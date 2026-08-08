#!/usr/bin/env bun
/**
 * lane-bootstrap — stand up one known-good lane environment, in one command.
 *
 *   bun scripts/lane-bootstrap.ts --branch <name> --reason "<stated reason>" [--fresh-db]
 *
 * Ledger item 15 (docs/issue-graph.md:261, decisions pass 2026-08-07). On one
 * night ~5 lanes hand-built their environments and each hit one of three
 * things: a missing `.env`, missing `bun-types` because deps were never
 * installed, or a pipe that swallowed a non-zero exit so a half-built
 * environment reported success. Those are the three failures this script is
 * built to make impossible to reach silently.
 *
 * DESIGN CONSTRAINTS (decided; see the ledger, do not re-litigate):
 *
 *  - `--reason` is REQUIRED and is printed into the output. The
 *    worktrees-need-a-stated-reason rule (AGENTS.md) stays intact: a worktree
 *    is scaffolding, and the reason is what makes a stray one explicable weeks
 *    later. Because the reason is echoed, it lands in the lane transcript.
 *
 *  - TEARDOWN IS PRINTED, NEVER EXECUTED. The ledger explicitly rejected
 *    scripted teardown (docs/issue-graph.md:284): "a cleanup script that
 *    removes things it may not have created is a bigger risk than the friction
 *    it saves." So this script emits the exact `git worktree remove` and
 *    `dropdb` lines and stops. Removal stays the manual, agent-owned step, and
 *    this file contains no delete path at all.
 *
 *  - NEVER checks out `main`. Lanes branch from `origin/main`; a worktree
 *    sitting on `main` is how a protected branch gets committed to by accident.
 *
 *  - Every step reports success or failure by NAME and the exit code reflects
 *    the FIRST failure. No `|| true`, no pipes that discard status — that is
 *    the swallowed-exit-code failure this script exists to prevent, so it must
 *    not reproduce it internally.
 */

import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The temp workspace is machine-specific (#636), so it is read rather than
// hardcoded. The fallback ANNOUNCES itself: silently relocating every lane
// worktree to a different volume is exactly the kind of self-made decision
// AGENTS.md "nothing is adjusted silently" forbids, and a stray worktree under
// ~/.cache is invisible to the `git worktree list` sweep that finds the rest.
const TEMP_WORKSPACE_SOURCE = process.env.OPENBRAIN_TEMP_WORKSPACE?.trim()
  ? "OPENBRAIN_TEMP_WORKSPACE"
  : process.env.DEV_TMP?.trim()
    ? "DEV_TMP"
    : "fallback";
const TEMP_WORKSPACE =
  process.env.OPENBRAIN_TEMP_WORKSPACE?.trim() ||
  process.env.DEV_TMP?.trim() ||
  join(homedir(), ".cache");
const WORKTREE_BASE = join(TEMP_WORKSPACE, "open-brain", "_worktrees");

if (TEMP_WORKSPACE_SOURCE === "fallback") {
  console.warn(
    `[lane-bootstrap] ADJUSTED: neither OPENBRAIN_TEMP_WORKSPACE nor DEV_TMP is set, ` +
      `so worktrees go under ${WORKTREE_BASE} instead of a configured temp workspace. ` +
      `Set OPENBRAIN_TEMP_WORKSPACE to place them where your other lane artifacts live.`,
  );
}

/** Placeholder reasons that are technically non-empty but state nothing. */
const PLACEHOLDER_REASONS = new Set([
  "reason",
  "todo",
  "tbd",
  "n/a",
  "na",
  "none",
  "test",
  "x",
  "-",
  "because",
  "work",
  "stuff",
  "placeholder",
  "asdf",
]);

const REASON_RULE =
  "AGENTS.md: a worktree needs a STATED REASON. A worktree is scaffolding for " +
  "one piece of work, not a record of it — the reason is what lets the next " +
  "person tell a live lane from an abandoned one. --reason is required, is " +
  "printed into this script's output so it lands in the lane transcript, and " +
  "cannot be a placeholder.";

interface Args {
  branch: string;
  reason: string;
  freshDb: boolean;
}

class LaneBootstrapError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

function parseArgs(argv: string[]): Args {
  let branch = "";
  let reason = "";
  let freshDb = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--branch") {
      branch = argv[++i] ?? "";
    } else if (arg === "--reason") {
      reason = argv[++i] ?? "";
    } else if (arg === "--fresh-db") {
      freshDb = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new LaneBootstrapError(
        "args",
        `unknown argument "${arg}". Run with --help for usage.`,
      );
    }
  }

  if (!branch.trim()) {
    throw new LaneBootstrapError(
      "args",
      "--branch <name> is required (the lane's new branch, cut from origin/main).",
    );
  }

  // The reason gate. Checked before anything is created, so a refusal never
  // leaves a half-built lane behind.
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new LaneBootstrapError(
      "reason",
      `--reason "<stated reason>" is required and was not given.\n\n${REASON_RULE}`,
    );
  }
  if (
    PLACEHOLDER_REASONS.has(trimmedReason.toLowerCase()) ||
    trimmedReason.length < 8
  ) {
    throw new LaneBootstrapError(
      "reason",
      `--reason "${trimmedReason}" is a placeholder, not a stated reason.\n\n${REASON_RULE}`,
    );
  }

  return { branch: branch.trim(), reason: trimmedReason, freshDb };
}

function printUsage(): void {
  process.stdout.write(
    [
      "lane-bootstrap — stand up one known-good lane environment.",
      "",
      "  bun scripts/lane-bootstrap.ts --branch <name> --reason \"<why>\" [--fresh-db]",
      "",
      "  --branch <name>   new branch for the lane, cut from origin/main (never main)",
      "  --reason  <text>  REQUIRED. Why this worktree exists; printed into the output.",
      "  --fresh-db        also create a uniquely-named migrated test database",
      "",
      "Teardown is PRINTED, never executed (ledger item 15 rejection record).",
      "",
    ].join("\n"),
  );
}

/**
 * Slugify a branch name for filesystem and Postgres identifier use.
 * `feat/foo-bar` -> `feat-foo-bar`.
 */
function slugify(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Run a command, inheriting stdio so the lane sees real output as it happens.
 * Throws a NAMED LaneBootstrapError on non-zero exit — this is the anti-
 * swallowed-exit-code guarantee: there is no code path here that observes a
 * failure and continues.
 */
function run(
  step: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: opts.env ?? process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw new LaneBootstrapError(
      step,
      `could not execute ${cmd}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new LaneBootstrapError(
      step,
      `${cmd} ${args.join(" ")} exited ${result.status}`,
    );
  }
}

/** Run a command and capture stdout. Same named-failure contract as run(). */
function capture(
  step: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: opts.env ?? process.env,
    encoding: "utf-8",
  });
  if (result.error) {
    throw new LaneBootstrapError(
      step,
      `could not execute ${cmd}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new LaneBootstrapError(
      step,
      `${cmd} ${args.join(" ")} exited ${result.status}: ${(result.stderr || "").trim()}`,
    );
  }
  return (result.stdout || "").trim();
}

function step(name: string, detail: string): void {
  process.stdout.write(`  [ok]   ${name}: ${detail}\n`);
}

/** Parse the repo `.env` for the libpq vars used to create the test database. */
function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(path, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const slug = slugify(args.branch);
  const worktreePath = join(WORKTREE_BASE, slug);

  process.stdout.write("lane-bootstrap\n");
  // The reason is echoed FIRST, so it lands in the lane transcript above any
  // output that might scroll. This is the whole point of requiring it.
  process.stdout.write(`  reason: ${args.reason}\n\n`);

  // --- 1. never main -------------------------------------------------------
  if (args.branch === "main" || args.branch === "origin/main") {
    throw new LaneBootstrapError(
      "branch",
      "refusing to create a lane on main. Lanes branch FROM origin/main onto a new branch; a worktree sitting on main is how a protected branch gets committed to by accident.",
    );
  }

  // --- 2. worktree ---------------------------------------------------------
  if (existsSync(worktreePath)) {
    throw new LaneBootstrapError(
      "worktree",
      `${worktreePath} already exists. Refusing to touch it — it may be a live lane. Remove it yourself (git worktree remove ${worktreePath}) or pick another --branch.`,
    );
  }

  run("fetch", "git", ["fetch", "origin", "--quiet"]);
  step("fetch", "origin fetched");

  run("worktree", "git", [
    "worktree",
    "add",
    "-b",
    args.branch,
    worktreePath,
    "origin/main",
  ]);
  step("worktree", `${worktreePath} on new branch ${args.branch} from origin/main`);

  // --- 3. .env -------------------------------------------------------------
  const srcEnv = join(REPO_ROOT, ".env");
  if (!existsSync(srcEnv)) {
    throw new LaneBootstrapError(
      "env",
      `no .env at ${srcEnv} to copy. The lane would start without database or embedding config — the exact missing-.env failure this script exists to prevent.`,
    );
  }
  copyFileSync(srcEnv, join(worktreePath, ".env"));
  step("env", ".env copied from repo root");

  // --- 4. deps -------------------------------------------------------------
  // Fails loudly by contract: run() throws on non-zero. A partially-installed
  // environment is exactly the bun-types failure from the ledger.
  run("deps", "bun", ["install", "--frozen-lockfile"], { cwd: worktreePath });
  step("deps", "bun install --frozen-lockfile completed");

  // --- 5. optional fresh database -----------------------------------------
  let dbUrl = "";
  let dbName = "";
  if (args.freshDb) {
    const env = readEnvFile(srcEnv);
    const host = env.DB_HOST || env.PGHOST || "127.0.0.1";
    const port = env.DB_PORT || env.PGPORT || "5432";
    const user = env.DB_USER || env.PGUSER;
    const password = env.DB_PASSWORD || env.PGPASSWORD || "";
    if (!user) {
      throw new LaneBootstrapError(
        "db",
        "no DB_USER/PGUSER in .env; cannot create a test database.",
      );
    }

    // Collision-proof by construction: slug + pid + time + random. Two lanes on
    // the same branch name, started in the same second, still differ. A fixed
    // name is how concurrent lanes truncate each other's tables.
    const suffix = `${process.pid}_${Date.now().toString(36)}${Math.floor(Math.random() * 1296)
      .toString(36)
      .padStart(2, "0")}`;

    // Postgres identifiers are bounded at NAMEDATALEN-1 = 63 bytes; this is a
    // compile-time server constant (`show max_identifier_length` = 63 on the
    // dogfood cluster), not a policy choice, and the server silently TRUNCATES
    // anything longer rather than erroring. Silent truncation is the danger:
    // it would cut the tail, which is precisely where the uniqueness suffix
    // lives, so two long branch names would collapse to the same database and
    // truncate each other's tables — the exact collision --fresh-db exists to
    // prevent. The uniqueness suffix is therefore kept WHOLE and the
    // human-readable slug yields the space instead; the name stays unique no
    // matter how long the branch is.
    const prefix = "lane_";
    const laneSuffix = `_${suffix}`;
    const room = 63 - prefix.length - laneSuffix.length;
    const fullSlug = slug.replace(/-/g, "_");
    const slugPart = fullSlug.slice(0, Math.max(0, room));
    dbName = `${prefix}${slugPart}${laneSuffix}`;
    if (slugPart !== fullSlug) {
      // Operator ruling 2026-08-07: nothing is adjusted silently. The name is
      // still collision-proof (suffix whole); only the readable part shrank,
      // and the lane transcript must say so rather than leave a name that
      // doesn't match the branch unexplained.
      step(
        "db-name",
        `NOTICE: branch slug shortened to fit Postgres's 63-byte identifier bound: "${fullSlug}" -> "${slugPart}" (uniqueness suffix kept whole; database is ${dbName})`,
      );
    }

    const pgEnv: NodeJS.ProcessEnv = { ...process.env };
    if (password) pgEnv.PGPASSWORD = password;

    // Reuses the CI mechanism verbatim: `createdb -E UTF8 -T template0`
    // (.github/workflows/ci.yml:68). The explicit encoding is NOT decoration —
    // ci.yml:59-66 records that a bare createdb inherits the cluster's
    // template1 encoding, and a C/POSIX cluster yields SQL_ASCII, under which
    // the snowball stemmers split multibyte accented characters and every
    // non-English FTS assertion (#341) silently fails while ASCII-only English
    // passes. `-T template0` is required to choose an encoding at all.
    run(
      "db-create",
      "createdb",
      ["-h", host, "-p", port, "-U", user, "-E", "UTF8", "-T", "template0", dbName],
      { env: pgEnv },
    );
    step("db-create", `${dbName} created (UTF8, template0)`);

    // Migrations run through the EXISTING path — `bun run migrate` ->
    // scripts/migrate.ts -> createPool() (src/db/pool.ts:22), which reads
    // DB_NAME from the environment. Overriding DB_NAME is therefore how the
    // existing migration path is pointed at the new database; no second
    // migration path is introduced here. The `vector` extension is created by
    // migration 001_init.sql:4, so no separate extension step is needed.
    const migrateEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DB_HOST: host,
      DB_PORT: port,
      DB_USER: user,
      DB_NAME: dbName,
    };
    if (password) migrateEnv.DB_PASSWORD = password;
    run("db-migrate", "bun", ["run", "migrate"], {
      cwd: worktreePath,
      env: migrateEnv,
    });
    step("db-migrate", `migrations applied to ${dbName}`);

    const auth = password
      ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
      : encodeURIComponent(user);
    dbUrl = `postgres://${auth}@${host}:${port}/${dbName}`;
  }

  // --- final report --------------------------------------------------------
  const lines: string[] = [
    "",
    "─".repeat(72),
    "LANE READY",
    "─".repeat(72),
    `  reason:    ${args.reason}`,
    `  worktree:  ${worktreePath}`,
    `  branch:    ${args.branch} (from origin/main)`,
    `  env:       .env copied — OK`,
    `  deps:      bun install --frozen-lockfile — OK`,
  ];
  if (args.freshDb) {
    lines.push(`  database:  ${dbName} — created and migrated`);
    lines.push("");
    lines.push("  Export this in the lane before running DB-backed tests:");
    lines.push("");
    lines.push(`    export OPENBRAIN_TEST_DATABASE_URL="${dbUrl}"`);
  } else {
    lines.push(`  database:  none (--fresh-db not given)`);
  }
  lines.push("");
  lines.push("─".repeat(72));
  // Printed, never executed. See the ledger rejection record
  // (docs/issue-graph.md:284): teardown stays manual and agent-owned.
  lines.push("TEARDOWN — run these YOURSELF when the lane is done. Nothing here is automatic.");
  lines.push("─".repeat(72));
  lines.push("");
  lines.push(`    git worktree remove ${worktreePath}`);
  if (args.freshDb) {
    lines.push(`    dropdb ${dbName}`);
  } else {
    lines.push(`    # dropdb <name>   (no database was created by this run)`);
  }
  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");
}

try {
  main();
} catch (err) {
  if (err instanceof LaneBootstrapError) {
    // Named step + non-zero exit. The first failure is the exit code.
    process.stderr.write(`\n  [FAIL] ${err.step}: ${err.message}\n\n`);
    process.exit(1);
  }
  process.stderr.write(
    `\n  [FAIL] unexpected: ${err instanceof Error ? err.stack || err.message : String(err)}\n\n`,
  );
  process.exit(1);
}
