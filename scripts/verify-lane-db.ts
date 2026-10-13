/**
 * verify-lane db — drop the fresh database `verify-lane --fresh-db` caused to
 * be created (issue 1667).
 *
 * WHY THIS EXISTS. `--fresh-db` hands `--fresh-db` to lane-bootstrap, which
 * createdb's a `lane_verify_lane_pr_<n>_<pid>_<time>` database. lane-bootstrap
 * only PRINTS a `dropdb` line (its teardown is manual by ledger item 15) and
 * verify-lane's teardown text named only the worktree, so nothing ever dropped
 * it. Four leaked (PRs 1623, 1624, 1625, 1641) and were dropped by hand on
 * 2026-10-04.
 *
 * THE SAME NARROW EXCEPTION AS `scripts/test-isolated.ts`. The printed-teardown
 * rule (docs/issue-graph.md:284) rejects a cleanup that removes things it may
 * not have created. This drops exactly one database: the one whose name
 * lane-bootstrap printed as created by THIS run, guarded by a fixed prefix so
 * no other name (the dogfood database included) can reach dropdb. The
 * worktree stays printed-teardown; only the per-run database is dropped.
 *
 * The shape mirrors test-isolated's `dropOne`/`teardown` (prefix guard,
 * synchronous `dropdb --if-exists --force` so it completes inside a signal
 * handler and `process.on("exit")`, and a LOUD orphan block with the exact
 * command when the drop fails). It is not imported from there because
 * test-isolated is a top-level script: importing it would run the test suite.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/**
 * Every database verify-lane can cause to exist: lane-bootstrap's `lane_` plus
 * the slug of `verify-lane/pr-<n>-<stamp>`. The drop refuses anything else.
 */
export const VERIFY_LANE_DB_PREFIX = "lane_verify_lane_pr_";

export interface DbConnection {
  host: string;
  port: string;
  user: string;
  password: string;
}

/**
 * The drop runs synchronously inside exit/signal handlers, so an unreachable
 * server must not be able to block shutdown: kill dropdb after this long.
 */
export const DROPDB_TIMEOUT_MS = 30_000;

/** The subprocess seam. `spawnSync` in production; a recorder in tests. */
export type DropRunner = (
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; encoding: "utf-8"; timeout: number },
) => {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  stderr?: string;
};

export type DropOutcome = "dropped" | "refused" | "orphaned";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The connection lane-bootstrap used for createdb: the repo `.env`, DB_* first
 * and PG* second, the same precedence and defaults as its readDbConnection.
 * Null when there is no `.env` or no user — the drop then reports an orphan.
 */
export function readRepoDbConnection(
  envPath: string = join(REPO_ROOT, ".env"),
): DbConnection | null {
  if (!existsSync(envPath)) return null;
  const env = parseEnv(readFileSync(envPath, "utf-8"));
  const pick = (dbKey: string, pgKey: string, fallback: string): string =>
    env[dbKey] || env[pgKey] || fallback;
  const user = pick("DB_USER", "PGUSER", "");
  if (!user) return null;
  return {
    host: pick("DB_HOST", "PGHOST", "127.0.0.1"),
    port: pick("DB_PORT", "PGPORT", "5432"),
    user,
    password: pick("DB_PASSWORD", "PGPASSWORD", ""),
  };
}

/**
 * The name lane-bootstrap printed in its `db-create: <name> created` line, or
 * null when it created none. Read from the output even when bootstrap FAILED,
 * because a migrate failure happens after createdb.
 */
export function parseFreshDbName(bootstrapOutput: string): string | null {
  return /\bdb-create: (\S+) created\b/.exec(bootstrapOutput)?.[1] ?? null;
}

/**
 * POSIX single-quote one argument for a printed, copy-pasteable command:
 * plain when it is only safe characters, otherwise wrapped in `'...'` with
 * each embedded `'` written as `'\''`.
 */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function dropCommand(conn: DbConnection | null, name: string): string {
  const q = shellQuote;
  if (!conn) return `dropdb --if-exists --force ${q(name)}`;
  return `dropdb --if-exists --force -h ${q(conn.host)} -p ${q(conn.port)} -U ${q(conn.user)} ${q(name)}`;
}

function printOrphan(name: string, conn: DbConnection | null, err: string): void {
  process.stderr.write(
    [
      "",
      "!".repeat(72),
      "ORPHANED DATABASE — verify-lane could not drop the database it created.",
      `  name: ${name}`,
      `  err:  ${err}`,
      "  drop it yourself with:",
      `    ${dropCommand(conn, name)}`,
      "!".repeat(72),
      "",
    ].join("\n"),
  );
}

function dropFailureText(result: ReturnType<DropRunner>): string {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") {
    return `dropdb timed out after ${DROPDB_TIMEOUT_MS} ms and was killed (${result.signal ?? "no signal"})`;
  }
  if (result.error) return result.error.message;
  return (result.stderr ?? "").trim() || `dropdb exited ${result.status}`;
}

/**
 * Drop one database by exact name. Synchronous on purpose: it must complete
 * inside a signal handler and inside `process.on("exit")`.
 */
export function dropFreshDb(opts: {
  name: string;
  conn: DbConnection | null;
  reason: string;
  run?: DropRunner;
}): DropOutcome {
  const { name, conn, reason } = opts;
  const run: DropRunner = opts.run ?? spawnSync;
  if (!name.startsWith(VERIFY_LANE_DB_PREFIX)) {
    // Unreachable by construction; kept because being wrong here drops a
    // database that matters.
    process.stderr.write(
      `\n  [REFUSED] db-teardown: "${name}" lacks the ${VERIFY_LANE_DB_PREFIX} prefix; not dropping.\n`,
    );
    return "refused";
  }
  if (!conn) {
    printOrphan(name, conn, "no DB_USER/PGUSER in the repo .env");
    return "orphaned";
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (conn.password) env.PGPASSWORD = conn.password;
  const result = run(
    "dropdb",
    [
      "--if-exists",
      "--force",
      "--no-password",
      "-h",
      conn.host,
      "-p",
      conn.port,
      "-U",
      conn.user,
      name,
    ],
    { env, encoding: "utf-8", timeout: DROPDB_TIMEOUT_MS },
  );
  if (result.error || result.status !== 0) {
    printOrphan(name, conn, dropFailureText(result));
    return "orphaned";
  }
  process.stdout.write(`  [ok]   db-teardown (${reason}): ${name} dropped\n`);
  return "dropped";
}

export interface FreshDbGuard {
  /** Record the database bootstrap created; from here on, teardown drops it. */
  adopt(name: string): void;
  /** Drop the adopted database once. Later calls are no-ops. */
  teardown(reason: string): DropOutcome | null;
  /** The exact `dropdb` line for the adopted database, for printed teardown. */
  dropLine(): string | null;
}

export function createFreshDbGuard(
  conn: DbConnection | null = readRepoDbConnection(),
  run: DropRunner = spawnSync,
): FreshDbGuard {
  let name: string | null = null;
  let torndown = false;
  return {
    adopt(created) {
      name = created;
    },
    teardown(reason) {
      if (torndown || name === null) return null;
      torndown = true;
      return dropFreshDb({ name, conn, reason, run });
    },
    dropLine() {
      return name === null ? null : dropCommand(conn, name);
    },
  };
}

/**
 * Cover the exit paths a `finally` cannot: a signal, and `process.exit()` from
 * the top-level error handler. The guard's teardown is idempotent, so the
 * `finally` in withFreshDbTeardown and these never drop twice.
 */
export function installFreshDbSignalTeardown(guard: FreshDbGuard): void {
  process.on("exit", () => guard.teardown("exit"));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      process.stdout.write(
        `\n  [!]    ${sig} received — dropping the fresh database\n`,
      );
      guard.teardown(sig);
      process.exit(130);
    });
  }
}

/** Run `body`, then drop the adopted database whether it resolved or threw. */
export async function withFreshDbTeardown<T>(
  guard: FreshDbGuard,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } finally {
    guard.teardown("verify-lane-complete");
  }
}
