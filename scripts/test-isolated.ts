#!/usr/bin/env bun
/**
 * test-isolated — run the test suite against a database nobody else is using.
 *
 *   bun run test:isolated                    # whole suite
 *   bun run test:isolated src/foo.pg.test.ts # one file (any `bun test` args)
 *
 * WHY THIS EXISTS (#614). A full `bun test` run against the shared dogfood
 * database returns a DIFFERENT failure count each time on unmodified code —
 * 49 -> 43 -> 40 observed across consecutive runs on 2026-08-06, the same class
 * as #498. The tests are not the problem: the same tree against a freshly
 * created database was 3701 pass / 0 fail. The shared mutable state is the
 * contaminant, and #613 documents one concrete leakage mechanism. A run whose
 * red does not mean broken and whose green does not mean safe is not a gate, so
 * this script exists to make the trustworthy path the DEFAULT rather than
 * something each lane hand-builds.
 *
 * WHAT IT DOES: creates a uniquely-named database, migrates it, points
 * OPENBRAIN_TEST_DATABASE_URL at it, runs `bun test` with whatever arguments
 * were passed, prints the database name, and drops the database on the way out.
 *
 * IT ALSO SUPPLIES WHAT THE OTHER PG SUITES ASK FOR (#904, #878). Two suites
 * skip on variables this runner never set, so they never ran locally:
 *
 *  - OPENBRAIN_SCRATCH_ADMIN_URL — the admin connection this script ALREADY
 *    holds (it runs createdb/dropdb with it), published rather than rebuilt, so
 *    `scripts/retire-collab-migration.test.ts` can create and drop its own
 *    scratch database.
 *  - OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL — a per-run
 *    `open_brain_local_<suffix>` database owned by the shared
 *    `open_brain_local_clone` role, built the way `.github/workflows/ci.yml`
 *    builds it, so `scripts/local-clone.test.ts` exercises a real loopback
 *    clone. The clone DATABASE is dropped on exit alongside the main one; the
 *    ROLE is shared across runs and the operator runbook, so it is created only
 *    when absent and is never dropped here.
 *
 * DESIGN CONSTRAINTS:
 *
 *  - NOTHING NEW IS INVENTED. The creation mechanism is the one CI already
 *    uses (`createdb -E UTF8 -T template0`, .github/workflows/ci.yml:68) by way
 *    of `scripts/lane-bootstrap.ts --fresh-db`, which borrowed it first;
 *    migrations run through the existing `bun run migrate` path with DB_NAME
 *    overridden. `bun test` itself is unchanged, and the tests' existing
 *    OPENBRAIN_TEST_DATABASE_URL convention is what is being fed.
 *
 *  - IT DROPS ONLY WHAT IT CREATED. This is the narrow exception to the
 *    printed-teardown rule that lane-bootstrap follows (docs/issue-graph.md:284
 *    rejected scripted teardown for a *lane*, on the grounds that "a cleanup
 *    script that removes things it may not have created is a bigger risk than
 *    the friction it saves"). That reasoning turns the other way here: this
 *    process creates the database itself, seconds earlier, with a name only it
 *    knows, and a per-run database that outlives its run is pure garbage. The
 *    name is captured in one variable and the drop is by that exact name with
 *    --if-exists; there is no path by which it can name anything else, and no
 *    recursive or forced filesystem delete anywhere in this file.
 *
 *  - A CRASH CANNOT LEAK SILENTLY. Teardown is installed on normal exit and on
 *    SIGINT/SIGTERM/SIGHUP/uncaught exception. If teardown itself fails, the
 *    orphan's name and the exact `dropdb` line are printed LOUDLY (operator
 *    ruling 2026-08-08: nothing is adjusted silently). A leak the operator can
 *    see is recoverable; a silent one is what produced #614's ambiguity.
 *
 *  - THE DOGFOOD DATABASE IS NEVER TOUCHED. Names are generated with a fixed
 *    `ob_isolated_` prefix and a random suffix, and the drop is guarded to
 *    refuse any name lacking that prefix.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adminUrl,
  CLONE_DB_PREFIX,
  provisionCloneDatabase,
  type CloneProvision,
} from "./test-support/clone-database.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every database this script creates carries this prefix, and the drop refuses
 * any name without it. That is what makes it structurally impossible for this
 * file to drop the dogfood database or anything else it did not create.
 */
const DB_PREFIX = "ob_isolated_";

interface DbConfig {
  host: string;
  port: string;
  user: string;
  password: string;
}

/** Parse the repo `.env` for the libpq vars. Mirrors lane-bootstrap's reader. */
function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf-8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function fail(step: string, message: string): never {
  process.stderr.write(`\n  [FAIL] ${step}: ${message}\n\n`);
  process.exit(2);
}

function note(step: string, detail: string): void {
  process.stdout.write(`  [ok]   ${step}: ${detail}\n`);
}

function resolveDbConfig(): DbConfig {
  const envPath = join(REPO_ROOT, ".env");
  // The environment wins over the file, so a caller that has already exported
  // PG*/DB_* (CI does exactly this) is honoured without a .env present at all.
  const fileEnv = existsSync(envPath) ? readEnvFile(envPath) : {};
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const fromProcess = process.env[key];
      if (fromProcess) return fromProcess;
    }
    for (const key of keys) {
      if (fileEnv[key]) return fileEnv[key];
    }
    return "";
  };

  const user = pick("DB_USER", "PGUSER");
  if (!user) {
    fail(
      "config",
      "no DB_USER/PGUSER in the environment or .env; cannot create an isolated test database.",
    );
  }
  return {
    host: pick("DB_HOST", "PGHOST") || "127.0.0.1",
    port: pick("DB_PORT", "PGPORT") || "5432",
    user,
    password: pick("DB_PASSWORD", "PGPASSWORD"),
  };
}

/**
 * Collision-proof by construction: pid + time + random, same shape as
 * lane-bootstrap's. Two concurrent runs never share a database, which is the
 * whole point — a fixed name would reintroduce the shared-state contamination
 * this script exists to remove. Short enough that Postgres's 63-byte identifier
 * rule never rewrites it, so there is nothing silently reshaped to explain.
 *
 * The suffix is returned bare rather than prefixed, because the clone database
 * (#904) is named from the SAME suffix: one run, one identity, two databases.
 */
function makeRunSuffix(): string {
  return `${process.pid}_${Date.now().toString(36)}${Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, "0")}`;
}

function pgEnv(cfg: DbConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (cfg.password) env.PGPASSWORD = cfg.password;
  return env;
}

function dbUrlFor(cfg: DbConfig, dbName: string): string {
  const auth = cfg.password
    ? `${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}`
    : encodeURIComponent(cfg.user);
  return `postgres://${auth}@${cfg.host}:${cfg.port}/${dbName}`;
}

function dropCommand(cfg: DbConfig, dbName: string): string {
  return `dropdb --if-exists --force -h ${cfg.host} -p ${cfg.port} -U ${cfg.user} ${dbName}`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const testArgs = process.argv.slice(2);
const cfg = resolveDbConfig();
const runSuffix = makeRunSuffix();
const dbName = `${DB_PREFIX}${runSuffix}`;

// Printed BEFORE creation, so an interrupt at any point after this line leaves
// the operator holding the name. A tool that names its database only on success
// is exactly how an orphan becomes silent.
process.stdout.write(
  [
    "",
    "─".repeat(72),
    "ISOLATED TEST RUN (#614)",
    "─".repeat(72),
    `  database:  ${dbName}  (created for this run, dropped on exit)`,
    `  clone:     ${CLONE_DB_PREFIX}${runSuffix}  (created for this run, dropped on exit)`,
    `  clone role: open_brain_local_clone  (shared; created if absent, never dropped)`,
    `  host:      ${cfg.host}:${cfg.port}`,
    `  scope:     ${testArgs.length ? testArgs.join(" ") : "full suite"}`,
    `  if this run is killed, drop it with:`,
    `    ${dropCommand(cfg, dbName)}`,
    "─".repeat(72),
    "",
  ].join("\n"),
);

let created = false;
let torndown = false;
/**
 * The per-run clone database (#904), once provisioned. Only the DATABASE is
 * tracked for teardown: the `open_brain_local_clone` ROLE is shared with
 * concurrent runs and with the operator runbook, so this script creates it when
 * absent and never drops it.
 */
let clone: CloneProvision | null = null;

/**
 * Drop the database this process created. Guarded by the prefix so it can only
 * ever name a database from makeDbName(). Synchronous on purpose: it has to
 * complete inside a signal handler and inside process.on("exit").
 */
function dropOne(name: string, prefix: string, reason: string): void {
  if (!name.startsWith(prefix)) {
    // Unreachable by construction; kept because the cost of being wrong here is
    // dropping a database that matters.
    process.stderr.write(
      `\n  [REFUSED] teardown: "${name}" lacks the ${prefix} prefix; not dropping.\n`,
    );
    return;
  }
  const result = spawnSync(
    "dropdb",
    ["--if-exists", "--force", "-h", cfg.host, "-p", cfg.port, "-U", cfg.user, name],
    { env: pgEnv(cfg), encoding: "utf-8" },
  );
  if (result.error || result.status !== 0) {
    // LOUD, per the no-silent rule. The operator gets the name and the command.
    process.stderr.write(
      [
        "",
        "!".repeat(72),
        `ORPHANED DATABASE — teardown (${reason}) could not drop it.`,
        `  name: ${name}`,
        `  err:  ${result.error?.message ?? ((result.stderr || "").trim() || `dropdb exited ${result.status}`)}`,
        "  drop it yourself with:",
        `    ${dropCommand(cfg, name)}`,
        "!".repeat(72),
        "",
      ].join("\n"),
    );
    return;
  }
  process.stdout.write(`\n  [ok]   teardown (${reason}): ${name} dropped\n`);
}

/**
 * Drop everything this run created: the isolated database, and the #904 clone
 * database when one was provisioned. Both go through the same guarded path, so
 * the clone inherits the loud-orphan behavior and the signal handling for free.
 */
function teardown(reason: string): void {
  if (torndown || !created) return;
  torndown = true;
  if (clone) dropOne(clone.database, CLONE_DB_PREFIX, `${reason}/clone`);
  dropOne(dbName, DB_PREFIX, reason);
}

process.on("exit", () => teardown("exit"));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    process.stdout.write(`\n  [!]    ${sig} received — dropping ${dbName}\n`);
    teardown(sig);
    process.exit(130);
  });
}
process.on("uncaughtException", (err) => {
  process.stderr.write(`\n  [FAIL] uncaught: ${err instanceof Error ? err.message : String(err)}\n`);
  teardown("uncaughtException");
  process.exit(2);
});

// --- create ----------------------------------------------------------------
// The CI mechanism verbatim (.github/workflows/ci.yml:68): the explicit
// `-E UTF8 -T template0` is not decoration — ci.yml:59-66 records that a bare
// createdb inherits the cluster's template1 encoding, and a C/POSIX cluster
// yields SQL_ASCII, under which the snowball stemmers split multibyte accented
// characters and every non-English FTS assertion (#341) silently fails while
// ASCII-only English passes.
{
  const result = spawnSync(
    "createdb",
    ["-h", cfg.host, "-p", cfg.port, "-U", cfg.user, "-E", "UTF8", "-T", "template0", dbName],
    { env: pgEnv(cfg), encoding: "utf-8" },
  );
  if (result.error) fail("db-create", `could not execute createdb: ${result.error.message}`);
  if (result.status !== 0) {
    fail("db-create", `createdb exited ${result.status}: ${(result.stderr || "").trim()}`);
  }
  created = true;
  note("db-create", `${dbName} created (UTF8, template0)`);
}

// --- migrate ---------------------------------------------------------------
// Through the EXISTING path: `bun run migrate` -> scripts/migrate.ts ->
// createPool() (src/db/pool.ts), which reads DB_NAME from the environment.
// Overriding DB_NAME is how that path is pointed at the new database; no second
// migration path is introduced. The `vector` extension comes from migration
// 001_init.sql, so there is no separate extension step.
{
  const result = spawnSync("bun", ["run", "migrate"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DB_HOST: cfg.host,
      DB_PORT: cfg.port,
      DB_USER: cfg.user,
      DB_NAME: dbName,
      ...(cfg.password ? { DB_PASSWORD: cfg.password } : {}),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.error) fail("db-migrate", `could not execute bun run migrate: ${result.error.message}`);
  if (result.status !== 0) fail("db-migrate", `migrations exited ${result.status}`);
  note("db-migrate", `migrations applied to ${dbName}`);
}

// --- local clone (#904) ----------------------------------------------------
// `scripts/local-clone.test.ts` skipped every local run because nothing here
// supplied OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL — a suite that never runs is
// the false green #878 is about. The provisioning is CI's own recipe; see
// scripts/test-support/clone-database.ts for why the ROLE outlives the run.
{
  const provisioned = provisionCloneDatabase(cfg, runSuffix);
  if ("error" in provisioned) {
    fail("db-clone", provisioned.error);
  }
  clone = provisioned;
  // Nothing is adjusted silently: every choice the provisioner made is printed.
  for (const notice of provisioned.notices) note("db-clone", notice);
  note("db-clone", `${provisioned.database} created, owned by ${provisioned.role}`);

  const result = spawnSync("bun", ["run", "migrate"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DB_HOST: cfg.host,
      DB_PORT: cfg.port,
      DB_USER: cfg.user,
      DB_NAME: provisioned.database,
      ...(cfg.password ? { DB_PASSWORD: cfg.password } : {}),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.error) fail("db-clone-migrate", `could not execute bun run migrate: ${result.error.message}`);
  if (result.status !== 0) fail("db-clone-migrate", `clone migrations exited ${result.status}`);
  note("db-clone-migrate", `migrations applied to ${provisioned.database}`);
}

// --- run tests -------------------------------------------------------------
// `bun test` itself is unchanged; it is handed the isolated URL through the
// env var the tests already honour. Anything after `--`/the script name is
// passed straight through, so `bun run test:isolated src/x.pg.test.ts` and any
// other bun test flag work exactly as they do bare.
// Narrowed rather than asserted: provisioning above calls fail() on any error,
// so `clone` is set by here, and this makes that readable to the checker too.
if (!clone) fail("db-clone", "clone provisioning did not complete");
const cloneUrl = clone.url;

const testEnv: NodeJS.ProcessEnv = {
  ...process.env,
  OPENBRAIN_TEST_DATABASE_URL: dbUrlFor(cfg, dbName),
  // #904: the two vars the other pg suites gate on. The admin URL is the same
  // credential used for createdb/dropdb above, pointed at the `postgres`
  // maintenance database; the clone URL names the per-run clone.
  OPENBRAIN_SCRATCH_ADMIN_URL: adminUrl(cfg),
  OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL: cloneUrl,
  DB_HOST: cfg.host,
  DB_PORT: cfg.port,
  DB_USER: cfg.user,
  DB_NAME: dbName,
};
if (cfg.password) testEnv.DB_PASSWORD = cfg.password;

note("test", `OPENBRAIN_TEST_DATABASE_URL -> ${dbName}; running bun test ${testArgs.join(" ")}`);

const child = spawn("bun", ["test", ...testArgs], {
  cwd: REPO_ROOT,
  env: testEnv,
  stdio: "inherit",
});

child.on("error", (err) => {
  process.stderr.write(`\n  [FAIL] test: could not execute bun test: ${err.message}\n`);
  teardown("spawn-error");
  process.exit(2);
});

child.on("exit", (code, signal) => {
  const exitCode = signal ? 130 : (code ?? 1);
  process.stdout.write(
    [
      "",
      "─".repeat(72),
      `  tests exited ${signal ? `on ${signal}` : exitCode}`,
      `  database:  ${dbName}`,
      "─".repeat(72),
    ].join("\n") + "\n",
  );
  teardown("test-complete");
  process.exit(exitCode);
});
