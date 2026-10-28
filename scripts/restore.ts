#!/usr/bin/env node
/**
 * Open Brain restore CLI (issue #298).
 *
 * Fail-closed restore of a verified backup set into an EXPLICIT target
 * database. No partial success: any verification or post-restore validation
 * failure means status "failed" and a nonzero exit.
 *
 * SAFETY MODEL (follows scripts/retire-collab-migration.ts conventions)
 * - The target database is always explicit (--target-db-url or --target-db).
 *   There is no default target; the script can never point itself at the
 *   configured production database by accident.
 * - VERIFY BEFORE ANY MUTATION: the full backup-verify pass (integrity +
 *   runtime compatibility) runs first and any failed verdict aborts before
 *   the target is touched.
 * - A target with user tables in any schema OTHER than public is REFUSED
 *   outright, even with wipe approval: the approved wipe only drops schema
 *   public, so anything else would silently survive and falsify the receipt's
 *   wipe claim. Restore targets must be scratch databases or
 *   public-schema-only.
 * - A NON-EMPTY public schema is REFUSED unless --wipe-target is passed AND
 *   ${"OPENBRAIN_RESTORE_WIPE_APPROVED"} carries the exact approval value —
 *   the assertExecuteApproval pattern. The wipe drops schema public only.
 * - Any NON-LOCAL target host additionally requires
 *   ${"OPENBRAIN_RESTORE_REMOTE_APPROVED"} with its approval value, wipe or
 *   not (dbHostRequiresReleaseApproval pattern).
 * - Credentials reach the child pg_restore ONLY via PGPASSWORD env, never
 *   argv, and are never printed (stderr from the child is redacted).
 * - POST-RESTORE VALIDATION (all fail the restore loudly): applied-migrations
 *   table matches the manifest; per-table row counts match exactly; archived
 *   (soft-deleted) row counts match exactly and archived rows stay archived;
 *   distinct-namespace count matches; namespace predicate columns exist;
 *   pgvector extension + halfvec embedding column dimension present; then, if
 *   the backup head is older than the repo head, the standard migration path
 *   runs forward and the final applied set must equal the repo set; finally a
 *   writability probe (BEGIN / temp-table INSERT / ROLLBACK).
 * - Deletion semantics: hard-deleted rows are simply absent from the dump and
 *   cannot be resurrected; archived rows restore AS archived.
 *
 * Receipt (openbrain.restore_receipt.v1, last line on stdout) is content-free
 * and includes a rollback_hint: the target database can be dropped; the
 * source backup set is never mutated.
 */
import pg from "pg";
import { runMigrations } from "../server/db/migrate.ts";
import { CONTRACT_VERSION } from "../server/contracts/contract.ts";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "./settings.ts";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  DUMP_FILENAME,
  EXIT_FAILED,
  EXIT_USAGE,
  RESTORE_RECEIPT_SCHEMA,
  compareMigrationSets,
  listRepoMigrations,
  redactSecret,
  resolvePgTool,
  summarizeChildStderr,
  verifyBackupSet,
  type CurrentRuntime,
  type Queryable,
} from "./backup-lib.ts";

// ---------------------------------------------------------------------------
// Approval envs (assertExecuteApproval pattern from retire-collab-migration)
// ---------------------------------------------------------------------------

export const RESTORE_WIPE_APPROVAL_ENV = "OPENBRAIN_RESTORE_WIPE_APPROVED";
export const RESTORE_WIPE_APPROVAL_VALUE = "wipe-target-database-after-verified-backup";
export const RESTORE_REMOTE_APPROVAL_ENV = "OPENBRAIN_RESTORE_REMOTE_APPROVED";
export const RESTORE_REMOTE_APPROVAL_VALUE = "restore-remote-target-approved";

const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function assertWipeApproval(
  env: Record<string, string | undefined> = process.env,
): void {
  if (env[RESTORE_WIPE_APPROVAL_ENV] === RESTORE_WIPE_APPROVAL_VALUE) return;
  throw new Error(
    [
      `--wipe-target requires ${RESTORE_WIPE_APPROVAL_ENV}=`,
      RESTORE_WIPE_APPROVAL_VALUE,
      ` in the approved operator shell. Wiping a database is destructive;`,
      ` do not run it from a scratch shell without explicit approval.`,
    ].join(""),
  );
}

export function targetHostRequiresRemoteApproval(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return false;
  return !LOCAL_DB_HOSTS.has(normalized);
}

export function assertRemoteApproval(
  env: Record<string, string | undefined> = process.env,
): void {
  if (env[RESTORE_REMOTE_APPROVAL_ENV] === RESTORE_REMOTE_APPROVAL_VALUE) {
    return;
  }
  throw new Error(
    [
      `Restoring to a non-local target host requires `,
      `${RESTORE_REMOTE_APPROVAL_ENV}=${RESTORE_REMOTE_APPROVAL_VALUE} in the`,
      ` approved operator shell. Do not restore over the network from a PR`,
      ` worktree, planning checkout, or scratch shell.`,
    ].join(""),
  );
}

// ---------------------------------------------------------------------------
// Args and target parsing
// ---------------------------------------------------------------------------

export interface RestoreTarget {
  host: string;
  port: number;
  user: string;
  password: string | undefined;
  dbName: string;
}

export interface RestoreArgs {
  dir: string;
  target: RestoreTarget;
  wipeTarget: boolean;
  allowEmbeddingMismatch: boolean;
}

function usage(exitCode: number = EXIT_USAGE): never {
  console.error(
    [
      "Usage: node scripts/restore.ts --dir <backup-set-dir>",
      "       (--target-db-url postgres://user[:pass]@host:port/dbname",
      "        | --target-db <dbname>)",
      "       [--wipe-target] [--allow-embedding-mismatch]",
      "",
      "The target database must already exist (createdb <name>) and must be",
      "EMPTY. A non-empty public schema is refused unless --wipe-target is",
      `passed AND ${RESTORE_WIPE_APPROVAL_ENV}=${RESTORE_WIPE_APPROVAL_VALUE}`,
      "(the wipe drops schema public only). A target with user tables in any",
      "OTHER schema is refused outright — restore targets must be scratch",
      "databases or public-schema-only.",
      `Non-local target hosts additionally require`,
      `${RESTORE_REMOTE_APPROVAL_ENV}=${RESTORE_REMOTE_APPROVAL_VALUE}.`,
      "--target-db uses DB_HOST/DB_PORT/DB_USER/DB_PASSWORD for the",
      "connection but NEVER defaults the database name.",
      "Credentials: prefer a PASSWORDLESS --target-db-url and pass the",
      "credential via the DB_PASSWORD (or PGPASSWORD) environment variable;",
      "an inline URL password is still accepted for scratch/CI targets.",
      "Verification always runs first; any failed verdict aborts the restore.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

export function parseTargetDbUrl(url: string): RestoreTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid --target-db-url (must be a postgres:// URL)");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("--target-db-url must use postgres:// or postgresql://");
  }
  const dbName = parsed.pathname.replace(/^\//, "");
  if (!dbName) throw new Error("--target-db-url must include a database name");
  if (!parsed.username) throw new Error("--target-db-url must include a user");
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username),
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    dbName,
  };
}

/** The raw flags, before either target form is resolved to a RestoreTarget. */
interface RestoreFlags {
  dir: string | undefined;
  targetDbUrl: string | undefined;
  targetDb: string | undefined;
  wipeTarget: boolean;
  allowEmbeddingMismatch: boolean;
}

/** Flags that take a value; each maps to its RestoreFlags key. */
const VALUE_FLAGS: Record<string, "dir" | "targetDbUrl" | "targetDb"> = {
  "--dir": "dir",
  "--target-db-url": "targetDbUrl",
  "--target-db": "targetDb",
};

function parseRestoreFlags(argv: string[]): RestoreFlags {
  const flags: RestoreFlags = {
    dir: undefined,
    targetDbUrl: undefined,
    targetDb: undefined,
    wipeTarget: false,
    allowEmbeddingMismatch: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const valueKey = VALUE_FLAGS[arg];
    if (valueKey) {
      const value = argv[++i];
      if (!value) usage();
      flags[valueKey] = value;
      continue;
    }
    if (arg === "--wipe-target") flags.wipeTarget = true;
    else if (arg === "--allow-embedding-mismatch") flags.allowEmbeddingMismatch = true;
    else if (arg === "--help" || arg === "-h") usage(0);
    else {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
  }
  return flags;
}

function resolveRestoreTarget(
  flags: RestoreFlags,
  env: Record<string, string | undefined>,
): RestoreTarget {
  if (flags.targetDbUrl) {
    const target = parseTargetDbUrl(flags.targetDbUrl);
    // Preferred credential path: passwordless URL + DB_PASSWORD env (keeps
    // the secret out of argv/shell history). Inline URL passwords are still
    // accepted for scratch/CI targets.
    if (target.password === undefined && env.DB_PASSWORD) {
      return { ...target, password: env.DB_PASSWORD };
    }
    return target;
  }
  if (flags.targetDb) {
    if (!env.DB_HOST || !env.DB_USER) {
      console.error("--target-db requires DB_HOST and DB_USER in the env");
      usage();
    }
    return {
      host: env.DB_HOST,
      port: parseInt(env.DB_PORT || "5432", 10),
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      dbName: flags.targetDb,
    };
  }
  console.error(
    "An explicit restore target is required (--target-db-url or --target-db)",
  );
  usage();
}

export function parseRestoreArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): RestoreArgs {
  const flags = parseRestoreFlags(argv);
  const { dir } = flags;
  if (!dir) {
    console.error("--dir <backup-set-dir> is required");
    usage();
  }
  if (flags.targetDbUrl && flags.targetDb) {
    console.error("Pass either --target-db-url or --target-db, not both");
    usage();
  }
  return {
    dir,
    target: resolveRestoreTarget(flags, env),
    wipeTarget: flags.wipeTarget,
    allowEmbeddingMismatch: flags.allowEmbeddingMismatch,
  };
}

// ---------------------------------------------------------------------------
// Post-restore validation (exported for unit tests and the live drill)
// ---------------------------------------------------------------------------

// The six manifest checks live in ./restore-validation.ts (issue 864 lane):
// one function per check instead of one long body. Re-exported here so the
// CLI's own module stays the single import surface for its tests.
import {
  errorClassOf,
  validatePostRestore,
  type ValidationResult,
} from "./restore-validation.ts";

export { validatePostRestore, type ValidationResult };

/** After forward migration, applied history must equal the repo after approved legacy normalization. */
export async function validateMigrationsMatchRepo(
  db: Queryable,
  repoMigrations: string[],
): Promise<ValidationResult> {
  try {
    const { rows } = await db.query(
      "SELECT filename FROM _migrations ORDER BY filename",
    );
    const applied = rows.map((r) => String(r.filename));
    const matches = compareMigrationSets(applied, repoMigrations) === "equal";
    return {
      name: "post_migration_head_matches_repo",
      verdict: matches ? "ok" : "fail",
      detail: matches
        ? `applied=${applied.length}`
        : `applied=${applied.length} expected=${repoMigrations.length}`,
    };
  } catch (err) {
    return {
      name: "post_migration_head_matches_repo",
      verdict: "fail",
      detail: `query failed: ${errorClassOf(err)}`,
    };
  }
}

/** BEGIN / scratch temp-table INSERT / ROLLBACK writability probe. */
export async function writabilityProbe(client: {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}): Promise<ValidationResult> {
  try {
    await client.query("BEGIN");
    await client.query("CREATE TEMP TABLE ob_restore_probe (id INT) ON COMMIT DROP");
    await client.query("INSERT INTO ob_restore_probe (id) VALUES ($1)", [1]);
    await client.query("ROLLBACK");
    return {
      name: "writability_probe",
      verdict: "ok",
      detail: "begin/insert/rollback succeeded",
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // already failed; surface the original error
    }
    return {
      name: "writability_probe",
      verdict: "fail",
      detail: `probe failed: ${errorClassOf(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Target emptiness / wipe gate (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Fail-closed target gate, scope-matched to what the approved wipe actually
 * does (DROP SCHEMA public):
 * - user tables in ANY schema other than public → REFUSE outright, even with
 *   wipe approval. The wipe would leave those schemas intact and the receipt
 *   would overclaim; restore targets must be scratch databases or
 *   public-schema-only.
 * - user tables in schema public → refuse unless --wipe-target AND the
 *   approval env are present, then drop and recreate schema public ONLY.
 */
export async function prepareRestoreTarget(
  db: Queryable,
  wipeTarget: boolean,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const { rows } = await db.query(
    `SELECT schemaname, COUNT(*)::int AS count FROM pg_catalog.pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      GROUP BY schemaname`,
  );
  let publicTables = 0;
  let nonPublicTables = 0;
  for (const row of rows) {
    const count = Number(row.count ?? 0);
    if (String(row.schemaname) === "public") publicTables += count;
    else nonPublicTables += count;
  }
  if (nonPublicTables > 0) {
    throw new Error(
      `target contains non-public user schemas (${nonPublicTables} user ` +
        "table(s) outside schema public); refusing — restore targets must " +
        "be scratch databases or public-schema-only. --wipe-target only " +
        "wipes schema public and cannot approve this target.",
    );
  }
  if (publicTables > 0) {
    if (!wipeTarget) {
      throw new Error(
        `target database is NOT empty (${publicTables} user table(s) in ` +
          "schema public) — refusing to restore. Pass --wipe-target WITH " +
          `${RESTORE_WIPE_APPROVAL_ENV} approval to wipe schema public first.`,
      );
    }
    assertWipeApproval(env);
    await db.query("DROP SCHEMA IF EXISTS public CASCADE");
    await db.query("CREATE SCHEMA public");
  }
}

// ---------------------------------------------------------------------------
// pg_restore invocation
// ---------------------------------------------------------------------------

export async function runPgRestore(
  target: RestoreTarget,
  dumpPath: string,
): Promise<void> {
  const tool = resolvePgTool("pg_restore");
  // Custom-format archive streamed via stdin so the same invocation works for
  // a docker-exec wrapper (whose filesystem is not the host's). Single-job
  // pg_restore reads custom format from a pipe fine.
  const args = [
    "--no-owner",
    "--no-privileges",
    // A fresh local-clone target preinstalls pgvector through its local admin.
    // That extension remains admin-owned, so replaying the archive's COMMENT
    // would require the non-superuser clone role to own it. Comments are not
    // functional restore state; omit them while keeping the archive DDL/data.
    "--no-comments",
    "--exit-on-error",
    "--single-transaction",
    "-h",
    target.host,
    "-p",
    String(target.port),
    "-U",
    target.user,
    "-d",
    target.dbName,
  ];
  const [command, ...toolArgs] = tool;
  if (command === undefined) throw new Error("resolvePgTool returned an empty command");
  const proc = spawn(command, [...toolArgs, ...args], {
    // Only override PGPASSWORD when a password was resolved; a passwordless
    // target keeps the operator's own PGPASSWORD intact.
    env: {
      ...process.env,
      ...(target.password !== undefined ? { PGPASSWORD: target.password } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Node's spawn does not accept a file handle as an stdio VALUE the way
  // Bun.file() was passed here, so the dump is streamed in explicitly.
  // pipeline applies backpressure and closes the child's stdin on EOF, which
  // is what makes pg_restore terminate.
  const fed = pipeline(createReadStream(dumpPath), proc.stdin);

  // Drained CONCURRENTLY with the feed: pg_restore writes to stderr while it
  // is still consuming stdin, so waiting until after the feed to read it can
  // fill the stderr pipe buffer and deadlock both directions.
  let stderrText = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });
  proc.stdout.resume();

  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.on("error", reject);
    // null when killed by a signal; -1 keeps the failure branch reachable.
    proc.on("close", (code) => resolve(code ?? -1));
  });
  // A failing pg_restore closes stdin early, so the feed rejects with EPIPE.
  // That is a SYMPTOM of the child's failure, not the diagnosis: swallow it
  // here so the exit-code branch below reports the real, redacted reason.
  await fed.catch(() => {});
  if (exitCode !== 0) {
    // NEVER pass raw stderr through: a mid-COPY failure embeds literal row
    // content in CONTEXT/COPY/DETAIL lines. Only the sanitized error class
    // (first line, cut before any ':' or quote) plus the exit code survive.
    throw new Error(
      `pg_restore exited with code ${exitCode} ` +
        `(${redactSecret(summarizeChildStderr(stderrText), target.password)})`,
    );
  }
}

/**
 * Run the repo's migrations forward when the backup head is older than the
 * repo head AND every manifest check passed, appending the head-match result.
 * Returns the number of migrations applied (0 when the step is skipped).
 */
async function maybeMigrateForward(
  pool: pg.Pool,
  migrationCompat: string | null,
  repoMigrations: string[],
  validations: ValidationResult[],
): Promise<number> {
  if (migrationCompat !== "restorable_with_migrations") return 0;
  if (!validations.every((v) => v.verdict === "ok")) return 0;
  const applied = await runMigrations(pool);
  validations.push(await validateMigrationsMatchRepo(pool, repoMigrations));
  return applied.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseRestoreArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const validations: ValidationResult[] = [];
  let verifyStatus: string | null = null;
  let migratedForward = 0;

  const rollbackHint =
    `target database "${args.target.dbName}" can be dropped ` +
    `(dropdb ${args.target.dbName}); the source backup set is never mutated`;

  const emitReceipt = (status: "ok" | "failed", error?: string): void => {
    const receipt = {
      schema: RESTORE_RECEIPT_SCHEMA,
      operation: "restore",
      status,
      backup_dir: args.dir,
      target_host: args.target.host,
      target_db: args.target.dbName,
      verify_status: verifyStatus,
      migrations_applied_forward: migratedForward,
      validations,
      duration_ms: Date.now() - startedAt,
      rollback_hint: rollbackHint,
      ...(error ? { error: redactSecret(error, args.target.password) } : {}),
    };
    console.log(JSON.stringify(receipt));
  };

  // Remote-host approval BEFORE anything touches the network path.
  try {
    if (targetHostRequiresRemoteApproval(args.target.host)) {
      assertRemoteApproval();
    }
  } catch (err) {
    emitReceipt("failed", err instanceof Error ? err.message : String(err));
    process.exit(EXIT_FAILED);
  }

  // 1. VERIFY the backup set before any mutation anywhere.
  const runtime: CurrentRuntime = {
    repoMigrations: await listRepoMigrations(),
    contractVersion: CONTRACT_VERSION,
    embeddingModel: EMBEDDING_MODEL,
    embeddingDimensions: EMBEDDING_DIMENSIONS,
  };
  const verifyResult = await verifyBackupSet(args.dir, runtime, {
    allowEmbeddingMismatch: args.allowEmbeddingMismatch,
  });
  verifyStatus = verifyResult.status;
  if (verifyResult.status === "failed" || !verifyResult.manifest) {
    emitReceipt(
      "failed",
      "backup verification failed — restore aborted before any mutation " +
        `(verdicts: ${JSON.stringify(verifyResult.verdicts)})`,
    );
    process.exit(EXIT_FAILED);
  }
  const manifest = verifyResult.manifest;

  const pool = new pg.Pool({
    host: args.target.host,
    port: args.target.port,
    user: args.target.user,
    password: args.target.password,
    database: args.target.dbName,
    max: 2,
    connectionTimeoutMillis: 5000,
  });
  pool.on("error", () => {
    // Surfaced by the failing query; prevents unhandled 'error' crashes.
  });

  try {
    // 2. Refuse non-public user schemas outright; refuse a non-empty public
    // schema unless the wipe (schema public only) is explicitly approved.
    await prepareRestoreTarget(pool, args.wipeTarget);

    // 3. Restore the dump.
    await runPgRestore(args.target, join(args.dir, DUMP_FILENAME));

    // 4. Post-restore validation against the manifest (pre-forward-migration:
    // the manifest counts describe the database as dumped).
    validations.push(...(await validatePostRestore(pool, manifest)));

    // 5. Forward migration when the backup head is older than the repo head.
    migratedForward = await maybeMigrateForward(
      pool,
      verifyResult.migration_compat,
      runtime.repoMigrations,
      validations,
    );

    // 6. Writability probe on a single client connection.
    const client = await pool.connect();
    try {
      validations.push(await writabilityProbe(client));
    } finally {
      client.release();
    }

    const failed = validations.filter((v) => v.verdict === "fail");
    if (failed.length > 0) {
      throw new Error(
        `${failed.length} post-restore validation(s) failed: ` +
          failed.map((v) => v.name).join(", "),
      );
    }

    emitReceipt("ok");
  } catch (err) {
    emitReceipt("failed", err instanceof Error ? err.message : String(err));
    process.exitCode = EXIT_FAILED;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}
