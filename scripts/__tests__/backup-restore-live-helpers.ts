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
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import pg from "pg";
import { runMigrations } from "../../server/db/migrate.ts";
import {
  requireLocalCloneTestDatabaseUrl,
  requireTestDatabaseUrl,
} from "../test-support/require-test-database.ts";
import { expectDefined } from "../test-support/expect-defined.ts";
import { EXTENSION_BOOTSTRAP_SQL } from "../test-support/extension-bootstrap.ts";
import { resolveCloneAdmin } from "../test-support/clone-admin.ts";
import { sqlTemplateClause } from "../test-support/test-template-db.ts";

export { expectDefined };

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MIGRATIONS_DIR = join(REPO_ROOT, "server", "db", "migrations");

/**
 * Per-run suffix for every scratch database name (issue #912).
 *
 * Both drill suites import these names, and bun schedules test FILES in
 * parallel, so a fixed name means the second suite's CREATE DATABASE races the
 * first one's and dies on `duplicate key value violates unique constraint
 * "pg_database_datname_index"`. Each suite runs in its own process, so the pid
 * gives every run its own set; teardown derives from the same constant, so the
 * suffixed databases are the ones dropped.
 */
const RUN_SUFFIX = `_${process.pid}`;

export const SRC_DB = `open_brain_ci_restore_src${RUN_SUFFIX}`;
export const TGT_DB = `open_brain_ci_restore_tgt${RUN_SUFFIX}`;
export const OLD_SRC_DB = `open_brain_ci_restore_oldsrc${RUN_SUFFIX}`;
export const OLD_TGT_DB = `open_brain_ci_restore_oldtgt${RUN_SUFFIX}`;
export const SNAPSHOT_TGT_DB = `open_brain_ci_restore_snapshot_tgt${RUN_SUFFIX}`;
/**
 * The clone-owned restore target (issue #938). The runner's clone database is
 * already migrated by scripts/test-isolated.ts, and scripts/restore.ts refuses
 * a non-empty target, so the drill restores into this fresh database instead.
 * It is created OWNER <clone.user> to preserve the non-superuser property the
 * clone test asserts.
 */
export const CLONE_TGT_DB = `open_brain_ci_restore_clone_tgt${RUN_SUFFIX}`;
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

/** The part of a pg client the drill lifecycle uses; a seam for fakes. */
export interface DrillClient {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

/** Connects a drill client to a URL. The default is a real pg.Client. */
export type ConnectDrillClient = (url: string) => Promise<DrillClient>;

async function connectPg(url: string): Promise<DrillClient> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** One drill lifecycle: the admin and clone connections plus its temp dirs. */
export interface DrillContext {
  /** The drill server's admin connection: always the clone's (loopback) server (#1667). */
  admin: Conn & { database: string };
  clone: Conn & { database: string };
  adminClient: DrillClient;
  /** The CREATE DATABASE template clause valid on the drill server. */
  templateClause: string;
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
  const proc = spawn(process.execPath, [join(REPO_ROOT, "scripts", script), ...args], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const [exitCode] = (await once(proc, "close")) as [number | null];
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
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
  return { exitCode: exitCode ?? 1, receipt, stdout, stderr };
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

/**
 * Drops each named database, trying every one even after a failure, and
 * returns the failures (issue 1667: stopping at the first one leaked the rest).
 */
async function dropDatabases(
  adminClient: DrillClient,
  names: readonly string[],
): Promise<Error[]> {
  const failures: Error[] = [];
  for (const name of names) {
    // Names come from the SCRATCH_DBS list above — a fixed prefix plus this
    // process's own pid — never from input.
    try {
      await adminClient.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } catch (err) {
      failures.push(
        new Error(
          `could not drop ${name}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
  return failures;
}

function aggregate(failures: Error[], what: string): AggregateError {
  return new AggregateError(
    failures,
    `${what}: ${failures.map((f) => f.message).join("; ")}`,
  );
}

/** Drops every scratch database; throws one aggregated error after trying all. */
export async function dropScratchDbs(adminClient: DrillClient): Promise<void> {
  const failures = await dropDatabases(adminClient, SCRATCH_DBS);
  if (failures.length > 0) throw aggregate(failures, "scratch database cleanup failed");
}

/**
 * The server the whole drill runs on (#1667): the clone's server, by the same
 * resolver scripts/test-isolated.ts provisions the clone with. That is the
 * main admin itself when it is loopback (today's behaviour), else the
 * checkout's `.env` loopback admin, read from the FILE as the runner reads it.
 *
 * Why the whole drill and not only the clone-owned target: restore.ts refuses
 * every non-loopback target unless OPENBRAIN_RESTORE_REMOTE_APPROVED is set in
 * an approved operator shell, so with a remote main server every restore into
 * a main-server target fails before it runs. Approving remote restores from a
 * test would change what the drill proves.
 *
 * `templateClause` is the OPENBRAIN_TEST_TEMPLATE_DB clause only when the
 * drill server IS the main one; the template does not exist elsewhere.
 */
export function resolveDrillAdmin(main: Conn & { database: string }): {
  admin: Conn & { database: string };
  templateClause: string;
} {
  const envPath = join(REPO_ROOT, ".env");
  const fileEnv = existsSync(envPath)
    ? (parseEnv(readFileSync(envPath, "utf8")) as Record<string, string>)
    : {};
  const resolved = resolveCloneAdmin(
    {
      host: main.host,
      port: String(main.port),
      user: main.user,
      password: main.password ?? "",
    },
    fileEnv,
  );
  // #1667: empty when OPENBRAIN_TEST_TEMPLATE_DB is unset, so the statements
  // are unchanged; otherwise every scratch database comes from that template.
  if (resolved.useTestTemplate)
    return { admin: main, templateClause: sqlTemplateClause("") };
  return {
    admin: {
      host: resolved.admin.host,
      port: Number(resolved.admin.port),
      user: resolved.admin.user,
      password: resolved.admin.password || undefined,
      database: "postgres",
    },
    templateClause: "",
  };
}

/**
 * Opens one drill lifecycle: connects the admin client and recreates every
 * scratch database on the drill server (resolveDrillAdmin). CLONE_TGT_DB is
 * owned by the clone role so a restore into it exercises the non-superuser
 * path. If it fails partway it drops what it already created and closes its
 * client before rethrowing (issue 1667), since no context reaches closeDrill.
 */
export async function openDrill(
  connect: ConnectDrillClient = connectPg,
): Promise<DrillContext> {
  const { admin, templateClause } = resolveDrillAdmin(
    parseAdminUrl(requireTestDatabaseUrl()),
  );
  const clone = parseAdminUrl(requireLocalCloneTestDatabaseUrl());
  const adminClient = await connect(dbUrl(admin, admin.database));
  const created: string[] = [];
  try {
    await dropScratchDbs(adminClient);
    for (const name of SCRATCH_DBS) {
      if (name !== CLONE_TGT_DB) {
        await adminClient.query(`CREATE DATABASE ${name}${templateClause}`);
        created.push(name);
        continue;
      }
      await adminClient.query(
        `CREATE DATABASE ${name} OWNER ${clone.user}${templateClause}`,
      );
      created.push(name);
      // Administrative bootstrap, exactly as scripts/test-support/
      // clone-database.ts:194 does it for the clone database: the clone role
      // is a non-superuser and cannot install extensions itself, so pg_restore
      // would fail creating them (#938). #1667: pg_stat_statements only where
      // the server provides it (migration 008's guard).
      const seed = await connect(dbUrl(admin, name));
      await seed.query(EXTENSION_BOOTSTRAP_SQL).finally(() => seed.end());
    }
  } catch (err) {
    const failures = await dropDatabases(adminClient, created);
    try {
      await adminClient.end();
    } catch (endErr) {
      failures.push(endErr instanceof Error ? endErr : new Error(String(endErr)));
    }
    if (failures.length === 0) throw err;
    throw aggregate(
      [err instanceof Error ? err : new Error(String(err)), ...failures],
      "openDrill failed partway and its cleanup failed too",
    );
  }
  return { admin, clone, adminClient, templateClause, tempDirs: [] };
}

/**
 * Drops the scratch databases, closes the admin client, clears temp dirs.
 * Tolerates a partially built context (issue 1667): every step that has
 * something to act on runs, and drop failures are reported after the rest.
 */
export async function closeDrill(
  ctx: Partial<DrillContext> | undefined,
): Promise<void> {
  const failures: Error[] = [];
  if (ctx?.adminClient) {
    failures.push(...(await dropDatabases(ctx.adminClient, SCRATCH_DBS)));
    try {
      await ctx.adminClient.end();
    } catch (err) {
      failures.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  for (const dir of ctx?.tempDirs ?? []) {
    await rm(dir, { recursive: true, force: true });
  }
  if (failures.length > 0) throw aggregate(failures, "scratch database cleanup failed");
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
