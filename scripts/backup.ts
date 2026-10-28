#!/usr/bin/env node
/**
 * Open Brain backup CLI (issue #298).
 *
 * Creates a self-contained backup SET in a target directory:
 *   <out>/openbrain.dump   pg_dump custom-format (-Fc) of the configured DB
 *   <out>/manifest.json    content-free manifest (openbrain.backup_manifest.v1)
 *
 * SAFETY MODEL
 * - NON-MUTATING for the source database: pg_dump only reads. There is no
 *   --dry-run for that reason; the flag shape otherwise follows
 *   scripts/retire-collab-migration.ts conventions.
 * - Refuses to overwrite an existing backup set unless --force is passed.
 * - Secrets: DB_PASSWORD reaches the child pg_dump ONLY via the PGPASSWORD
 *   environment variable, never argv. Credentials are never printed and never
 *   appear in the manifest or the receipt.
 * - The receipt (openbrain.backup_receipt.v1, single line on stdout) is
 *   content-free: counts, hashes, sizes, durations, version identifiers.
 *
 * Connects via the repo pool config: DB_HOST, DB_USER (required), DB_NAME
 * (default open_brain), DB_PORT, DB_PASSWORD.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  createPool,
  buildContract,
  CONTRACT_VERSION,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from "./settings.ts";
import {
  BACKUP_RECEIPT_SCHEMA,
  DUMP_FILENAME,
  EXIT_FAILED,
  EXIT_USAGE,
  MANIFEST_FILENAME,
  buildManifest,
  gatherDbInfo,
  redactSecret,
  resolvePgTool,
  sha256File,
  summarizeChildStderr,
} from "./backup-lib.ts";
import {
  DeployInProgressError,
  EXIT_DEPLOY_IN_PROGRESS,
  assertNoDeployInProgress,
} from "./deploy-lock.ts";

export interface BackupArgs {
  out: string;
  force: boolean;
}

function usage(exitCode: number = EXIT_USAGE): never {
  console.error(
    [
      "Usage: node scripts/backup.ts --out <backup-set-dir> [--force]",
      "",
      "Creates <dir>/openbrain.dump (pg_dump -Fc) plus <dir>/manifest.json.",
      "Refuses to overwrite an existing backup set unless --force is passed.",
      "Backup is non-mutating for the source database (pg_dump reads only).",
      "Connects via the repo pool config: DB_HOST, DB_USER (required),",
      "DB_NAME (default open_brain), DB_PORT, DB_PASSWORD (passed to pg_dump",
      "via PGPASSWORD env, never argv).",
    ].join("\n"),
  );
  process.exit(exitCode);
}

export function parseBackupArgs(argv: string[]): BackupArgs {
  let out: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      out = argv[++i];
      if (!out) usage();
    } else if (arg === "--force") force = true;
    else if (arg === "--help" || arg === "-h") usage(0);
    else {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
  }
  if (!out) {
    console.error("--out <backup-set-dir> is required");
    usage();
  }
  return { out, force };
}

export async function runPgDump(opts: {
  host: string;
  port: number;
  user: string;
  password: string | undefined;
  dbName: string;
  dumpPath: string;
  snapshot: string;
}): Promise<void> {
  const tool = resolvePgTool("pg_dump");
  // Custom format to stdout, streamed to a host-side file. Writing via stdout
  // (instead of -f) keeps the exact same invocation working when the tool is
  // a docker-exec wrapper whose filesystem is not the host's.
  const args = [
    "-Fc",
    "--no-owner",
    "-h",
    opts.host,
    "-p",
    String(opts.port),
    "-U",
    opts.user,
    "-d",
    opts.dbName,
    "--snapshot",
    opts.snapshot,
  ];
  const [command, ...toolArgs] = tool;
  if (command === undefined) throw new Error("resolvePgTool returned an empty command");
  const proc = spawn(command, [...toolArgs, ...args], {
    // Only override PGPASSWORD when a password was configured; otherwise the
    // operator's own PGPASSWORD stays intact.
    env: {
      ...process.env,
      ...(opts.password !== undefined ? { PGPASSWORD: opts.password } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // stderr is drained CONCURRENTLY with the dump pipeline, not after it: a
  // chatty pg_dump that fills the stderr pipe buffer while nobody is reading
  // it blocks the child, which stops writing stdout, which stalls the
  // pipeline -- a deadlock on exactly the large dumps this path exists for.
  let stderrText = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });

  // pipeline replaces the FileSink loop and is strictly better: it applies
  // real backpressure (the old `void writer.write(chunk)` deliberately did
  // not) and it destroys the file stream on error instead of leaving a
  // half-written dump behind an unresolved promise.
  const exited = new Promise<number>((resolve, reject) => {
    proc.on("error", reject);
    // `close` reports null when the child is killed by a signal; -1 keeps the
    // non-zero branch below reachable rather than coercing that to success.
    proc.on("close", (code) => resolve(code ?? -1));
  });

  try {
    await pipeline(proc.stdout, createWriteStream(opts.dumpPath));
  } catch (error) {
    proc.kill();
    await rm(opts.dumpPath, { force: true });
    throw error;
  }

  const exitCode = await exited;
  if (exitCode !== 0) {
    // Remove the partial dump so a retry is not blocked behind --force (a
    // truncated dump would otherwise sit there looking like a backup set).
    await rm(opts.dumpPath, { force: true });
    // NEVER pass raw stderr through: pg_dump failure detail can embed literal
    // row/DDL content. Only the sanitized error class + exit code survive.
    throw new Error(
      `pg_dump exited with code ${exitCode} ` +
        `(${redactSecret(summarizeChildStderr(stderrText), opts.password)})`,
    );
  }
}

/** The two files a backup set is made of. */
interface SetPaths {
  dumpPath: string;
  manifestPath: string;
}

interface DbTarget {
  host: string;
  port: number;
  user: string;
  password: string | undefined;
  dbName: string;
}

/** The pool config the CLI connects with, or a usage exit when it is absent. */
function readDbTarget(): DbTarget {
  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  if (!host || !user) {
    console.error("DB_HOST and DB_USER are required (DB_NAME defaults to open_brain).");
    process.exit(EXIT_USAGE);
  }
  return {
    host,
    port: parseInt(process.env.DB_PORT || "5432", 10),
    user,
    password: process.env.DB_PASSWORD,
    dbName: process.env.DB_NAME || "open_brain",
  };
}

/**
 * Overlap guard (#677). Run BEFORE the output directory is created and before
 * any dump work, so a refusal leaves nothing behind that could be mistaken for
 * a backup set.
 */
async function refuseWhenDeployInProgress(outDir: string): Promise<void> {
  const guardPool = createPool({
    max: 1,
    application_name: "openbrain-backup-deploy-guard",
  });
  try {
    const guardClient = await guardPool.connect();
    try {
      await assertNoDeployInProgress(guardClient);
    } finally {
      guardClient.release();
    }
  } catch (err) {
    if (!(err instanceof DeployInProgressError)) throw err;
    console.error(err.message);
    console.log(
      JSON.stringify({
        schema: BACKUP_RECEIPT_SCHEMA,
        operation: "backup",
        status: "refused",
        reason: "deploy_in_progress",
        backup_dir: outDir,
      }),
    );
    await guardPool.end();
    process.exit(EXIT_DEPLOY_IN_PROGRESS);
  } finally {
    await guardPool.end();
  }
}

/** Refuse an existing backup set unless --force, in which case clear it. */
async function prepareOutputDir(
  args: BackupArgs,
  { dumpPath, manifestPath }: SetPaths,
): Promise<void> {
  const existingDump = existsSync(dumpPath);
  const existingManifest = existsSync(manifestPath);
  if (existingDump || existingManifest) {
    if (!args.force) {
      console.error(
        `Backup set already exists at ${args.out} — refusing to overwrite ` +
          "without --force.",
      );
      process.exit(EXIT_FAILED);
    }
    await rm(dumpPath, { force: true });
    await rm(manifestPath, { force: true });
  }
  await mkdir(args.out, { recursive: true });
}

/**
 * Hold one read-only, repeatable-read transaction while both the manifest facts
 * and pg_dump read its exported snapshot. This prevents a concurrent commit from
 * landing in only one half of the backup set.
 */
async function dumpUnderSnapshot(
  pool: ReturnType<typeof createPool>,
  target: DbTarget,
  dumpPath: string,
): Promise<{
  dbInfo: Awaited<ReturnType<typeof gatherDbInfo>>;
  dumpDurationMs: number;
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: snapshotRows } = await client.query(
      "SELECT pg_export_snapshot() AS snapshot",
    );
    const snapshot = String(snapshotRows[0]?.snapshot ?? "");
    if (!snapshot) {
      throw new Error("PostgreSQL did not return an exported snapshot");
    }

    // The dump is written before the manifest so a valid set always has
    // manifest mtime >= dump mtime (verify's drift heuristic relies on it).
    const dbInfo = await gatherDbInfo(client);
    const dumpStartedAt = Date.now();
    await runPgDump({ ...target, dumpPath, snapshot });
    const dumpDurationMs = Date.now() - dumpStartedAt;
    await client.query("ROLLBACK");
    return { dbInfo, dumpDurationMs };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function writeBackupSet(
  target: DbTarget,
  args: BackupArgs,
  paths: SetPaths,
  startedAt: number,
): Promise<void> {
  const { dumpPath, manifestPath } = paths;
  const pool = createPool({ max: 2, application_name: "openbrain-backup" });
  try {
    const { dbInfo, dumpDurationMs } = await dumpUnderSnapshot(pool, target, dumpPath);

    const { sha256, bytes } = await sha256File(dumpPath);
    const manifest = buildManifest({
      dbInfo,
      source: {
        db_host: target.host,
        db_port: target.port,
        db_name: target.dbName,
      },
      contract: {
        version: CONTRACT_VERSION,
        schema_hash: buildContract().schema_hash,
      },
      embedding: {
        // Defaults match scripts/settings.ts: gemini-embedding-001 / 768.
        // Production (production-host launchd) overrides EMBEDDING_MODEL to the local
        // MLX deployment (embeddinggemma-300m-8bit); the manifest records
        // whatever the runtime that owns this database was configured with.
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
      },
      files: [{ name: DUMP_FILENAME, sha256, bytes }],
    });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    const totalRows = Object.values(manifest.row_counts).reduce((sum, n) => sum + n, 0);
    console.log(
      JSON.stringify({
        schema: BACKUP_RECEIPT_SCHEMA,
        operation: "backup",
        status: "ok",
        backup_dir: args.out,
        dump_sha256_prefix: sha256.slice(0, 12),
        dump_bytes: bytes,
        duration_ms: Date.now() - startedAt,
        dump_duration_ms: dumpDurationMs,
        tables_counted: Object.keys(manifest.row_counts).length,
        total_rows: totalRows,
        distinct_namespaces: manifest.namespace_inventory.distinct_namespaces,
        migrations_head: manifest.migrations.head,
        contract_version: manifest.contract.version,
      }),
    );
  } catch (err) {
    console.log(
      JSON.stringify({
        schema: BACKUP_RECEIPT_SCHEMA,
        operation: "backup",
        status: "failed",
        backup_dir: args.out,
        duration_ms: Date.now() - startedAt,
        error: redactSecret(
          err instanceof Error ? err.message : String(err),
          target.password,
        ),
      }),
    );
    process.exit(EXIT_FAILED);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const args = parseBackupArgs(process.argv.slice(2));
  const target = readDbTarget();

  const paths: SetPaths = {
    dumpPath: join(args.out, DUMP_FILENAME),
    manifestPath: join(args.out, MANIFEST_FILENAME),
  };

  await refuseWhenDeployInProgress(args.out);
  await prepareOutputDir(args, paths);

  await writeBackupSet(target, args, paths, Date.now());
}

if (import.meta.main) {
  await main();
}
