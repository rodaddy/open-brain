/**
 * Shared drill machinery for the live backup/restore suites (issues #298,
 * #878, #938).
 *
 * This module holds no test and creates no pool at import. It exists so the
 * drill and refusal suites can each open their own scratch-database lifecycle
 * from one definition instead of each carrying a private copy that drifts.
 *
 * The two connection strings are demanded through
 * scripts/test-support/require-test-database.ts at the point of use, so a run
 * without them fails with test_database_required rather than skipping.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.ts";
import {
  requireLocalCloneTestDatabaseUrl,
  requireTestDatabaseUrl,
} from "../test-support/require-test-database.ts";
import { expectDefined } from "../test-support/expect-defined.ts";

export { expectDefined };

export const REPO_ROOT = join(import.meta.dir, "..", "..");
export const MIGRATIONS_DIR = join(REPO_ROOT, "src", "db", "migrations");

export const SRC_DB = "open_brain_ci_restore_src";
export const TGT_DB = "open_brain_ci_restore_tgt";
export const OLD_SRC_DB = "open_brain_ci_restore_oldsrc";
export const OLD_TGT_DB = "open_brain_ci_restore_oldtgt";
export const SNAPSHOT_TGT_DB = "open_brain_ci_restore_snapshot_tgt";
/**
 * The clone-owned restore target (issue #938). The runner's clone database is
 * already migrated by scripts/test-isolated.ts, and scripts/restore.ts refuses
 * a non-empty target, so the drill restores into this fresh database instead.
 * It is created OWNER <clone.user> to preserve the non-superuser property the
 * clone test asserts.
 */
export const CLONE_TGT_DB = "open_brain_ci_restore_clone_tgt";
export const SCRATCH_DBS = [
  SRC_DB,
  TGT_DB,
  OLD_SRC_DB,
  OLD_TGT_DB,
  SNAPSHOT_TGT_DB,
  CLONE_TGT_DB,
];

export const NS_ALPHA = "drill-ns-alpha";
export const NS_BETA = "drill-ns-beta";
export const DELETED_HASH = "drill-hard-deleted-hash";
export const ARCHIVED_HASH = "drill-archived-hash";

export interface Conn {
  host: string;
  port: number;
  user: string;
  password: string | undefined;
}

/** One drill lifecycle: the admin and clone connections plus its temp dirs. */
export interface DrillContext {
  admin: Conn & { database: string };
  clone: Conn & { database: string };
  adminClient: pg.Client;
  tempDirs: string[];
}

/**
 * The receipt the backup/restore/verify CLIs print as their last stdout line.
 *
 * The three CLIs print three different receipt schemas, so the shared shape is
 * an open record; each assertion narrows the field it reads.
 */
export type CliReceipt = Record<string, unknown> | null;

export interface CliResult {
  exitCode: number;
  receipt: CliReceipt;
  stdout: string;
  stderr: string;
}
export function parseAdminUrl(url: string): Conn & { database: string } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username),
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database: parsed.pathname.replace(/^\//, ""),
  };
}

export function dbUrl(conn: Conn, database: string): string {
  const auth = conn.password
    ? `${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password)}`
    : encodeURIComponent(conn.user);
  return `postgres://${auth}@${conn.host}:${conn.port}/${database}`;
}

export function cliEnv(conn: Conn, database: string): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DB_HOST: conn.host,
    DB_PORT: String(conn.port),
    DB_USER: conn.user,
    DB_NAME: database,
  };
  if (conn.password !== undefined) env.DB_PASSWORD = conn.password;
  return env;
}

export async function runCli(
  script: string,
  args: string[],
  env: Record<string, string>,
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", join(REPO_ROOT, "scripts", script), ...args], {
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let receipt: CliReceipt = null;
  // The receipt is the last stdout line (logger lines may precede it).
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      receipt = JSON.parse(expectDefined(lines[i], "stdout line")) as CliReceipt;
      break;
    } catch {
      continue;
    }
  }
  return { exitCode, receipt, stdout, stderr };
}

export function makePool(conn: Conn, database: string): pg.Pool {
  return new pg.Pool({ ...conn, database, max: 2 });
}

/** Creates a temp directory and records it on the context for teardown. */
export async function tempDir(tempDirs: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ob298-live-"));
  tempDirs.push(dir);
  return dir;
}

export async function dropScratchDbs(adminClient: pg.Client): Promise<void> {
  for (const name of SCRATCH_DBS) {
    // Names come from the fixed SCRATCH_DBS list above, never from input.
    await adminClient.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
}

/**
 * Opens one drill lifecycle: connects the admin client and recreates every
 * scratch database. CLONE_TGT_DB is owned by the clone role so a restore into
 * it exercises the non-superuser path.
 */
export async function openDrill(): Promise<DrillContext> {
  const admin = parseAdminUrl(requireTestDatabaseUrl());
  const clone = parseAdminUrl(requireLocalCloneTestDatabaseUrl());
  const adminClient = new pg.Client({ connectionString: dbUrl(admin, admin.database) });
  await adminClient.connect();
  await dropScratchDbs(adminClient);
  for (const name of SCRATCH_DBS) {
    if (name === CLONE_TGT_DB) {
      await adminClient.query(`CREATE DATABASE ${name} OWNER ${clone.user}`);
      // Administrative bootstrap, exactly as scripts/test-support/
      // clone-database.ts:194 does it for the clone database: the clone role is
      // a non-superuser and cannot install extensions itself, so pg_restore
      // would fail creating them (#938).
      const seed = new pg.Client({ connectionString: dbUrl(admin, name) });
      await seed.connect();
      await seed.query(
        "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_stat_statements;",
      );
      await seed.end();
    } else {
      await adminClient.query(`CREATE DATABASE ${name}`);
    }
  }
  return { admin, clone, adminClient, tempDirs: [] };
}

/** Drops the scratch databases, closes the admin client, clears temp dirs. */
export async function closeDrill(ctx: DrillContext): Promise<void> {
  await dropScratchDbs(ctx.adminClient);
  await ctx.adminClient.end();
  for (const dir of ctx.tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Seeds the source database and runs the backup CLI against it.
 *
 * Returns the backup directory both suites restore from, alongside the
 * backup CLI result so a caller can assert on its receipt.
 */
export async function seedAndBackup(
  ctx: DrillContext,
): Promise<{ backupDir: string; backup: CliResult }> {
  const { admin } = ctx;
  // --- seed the source ------------------------------------------------
  const srcPool = makePool(admin, SRC_DB);
  try {
    await runMigrations(srcPool);
    await srcPool.query(
      `INSERT INTO thoughts (content, created_by, namespace, content_hash)
         VALUES ($1, $2, $3, $4), ($5, $2, $3, $6)`,
      [
        "drill alpha thought one",
        "drill",
        NS_ALPHA,
        "drill-alpha-1",
        "drill alpha thought two",
        "drill-alpha-2",
      ],
    );
    await srcPool.query(
      `INSERT INTO thoughts (content, created_by, namespace, content_hash, archived_at)
         VALUES ($1, $2, $3, $4, NOW())`,
      ["drill archived thought", "drill", NS_ALPHA, ARCHIVED_HASH],
    );
    await srcPool.query(
      `INSERT INTO thoughts (content, created_by, namespace, content_hash)
         VALUES ($1, $2, $3, $4), ($5, $2, $3, $6)`,
      [
        "drill beta thought one",
        "drill",
        NS_BETA,
        "drill-beta-1",
        "drill beta thought two",
        "drill-beta-2",
      ],
    );
    // Hard-delete semantics: this row is deleted BEFORE the backup and
    // must not be resurrected by restore (absent from the dump).
    await srcPool.query(
      `INSERT INTO thoughts (content, created_by, namespace, content_hash)
         VALUES ($1, $2, $3, $4)`,
      ["drill hard-deleted thought", "drill", NS_ALPHA, DELETED_HASH],
    );
    await srcPool.query("DELETE FROM thoughts WHERE content_hash = $1", [DELETED_HASH]);
    const { rows: laneRows } = await srcPool.query(
      `INSERT INTO ob_session_lanes (session_key, namespace, created_by, project)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
      ["drill-lane-1", NS_ALPHA, "drill", "drill-project"],
    );
    const laneId = expectDefined(laneRows[0], "lane row").id as string;
    await srcPool.query(
      `INSERT INTO ob_session_events (lane_id, event_type, content, created_by)
         VALUES ($1, $2, $3, $4)`,
      [laneId, "fact", "drill pre-backup event", "drill"],
    );
  } finally {
    await srcPool.end();
  }

  // --- backup ---------------------------------------------------------
  const backupDir = join(await tempDir(ctx.tempDirs), "set-1");
  const backup = await runCli("backup.ts", ["--out", backupDir], cliEnv(admin, SRC_DB));
  if (backup.exitCode !== 0) {
    throw new Error(`drill backup failed: ${backup.stderr}`);
  }
  return { backupDir, backup };
}

/**
 * Reads one field of the Nth entry of a receipt's `sets` array.
 *
 * backup-verify prints per-set records; typing them as an open record makes a
 * direct index an implicit any, so the narrowing lives here once.
 */
export function receiptSetField(
  receipt: CliReceipt,
  index: number,
  field: string,
): unknown {
  const sets = receipt?.["sets"];
  if (!Array.isArray(sets)) return undefined;
  const entry = sets[index] as Record<string, unknown> | undefined;
  return entry?.[field];
}
