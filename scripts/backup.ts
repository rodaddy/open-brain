#!/usr/bin/env bun
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
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createPool } from "../src/db/pool.ts";
import { buildContract, CONTRACT_VERSION } from "../src/contract.ts";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "../src/embedding.ts";
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

export interface BackupArgs {
  out: string;
  force: boolean;
}

function usage(exitCode: number = EXIT_USAGE): never {
  console.error(
    [
      "Usage: bun run scripts/backup.ts --out <backup-set-dir> [--force]",
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
    const arg = argv[i]!;
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
  const proc = Bun.spawn([...tool, ...args], {
    // Only override PGPASSWORD when a password was configured; otherwise the
    // operator's own PGPASSWORD stays intact.
    env: {
      ...process.env,
      ...(opts.password !== undefined ? { PGPASSWORD: opts.password } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const writer = Bun.file(opts.dumpPath).writer();
  for await (const chunk of proc.stdout) {
    writer.write(chunk);
  }
  await writer.end();
  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
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

async function main(): Promise<void> {
  const args = parseBackupArgs(Bun.argv.slice(2));
  if (!process.env.DB_HOST || !process.env.DB_USER) {
    console.error(
      "DB_HOST and DB_USER are required (DB_NAME defaults to open_brain).",
    );
    process.exit(EXIT_USAGE);
  }
  const host = process.env.DB_HOST;
  const port = parseInt(process.env.DB_PORT || "5432", 10);
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const dbName = process.env.DB_NAME || "open_brain";

  const dumpPath = join(args.out, DUMP_FILENAME);
  const manifestPath = join(args.out, MANIFEST_FILENAME);

  const existingDump = await Bun.file(dumpPath).exists();
  const existingManifest = await Bun.file(manifestPath).exists();
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

  const startedAt = Date.now();
  const pool = createPool({ max: 2, application_name: "openbrain-backup" });
  try {
    // Hold one read-only, repeatable-read transaction while both the manifest
    // facts and pg_dump read its exported snapshot. This prevents a concurrent
    // commit from landing in only one half of the backup set.
    const client = await pool.connect();
    let dbInfo;
    let dumpDurationMs: number;
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const { rows: snapshotRows } = await client.query(
        "SELECT pg_export_snapshot() AS snapshot",
      );
      const snapshot = String(snapshotRows[0]?.snapshot ?? "");
      if (!snapshot) {
        throw new Error("PostgreSQL did not return an exported snapshot");
      }

      // The dump is written before the manifest so a valid set always has
      // manifest mtime >= dump mtime (verify's drift heuristic relies on it).
      dbInfo = await gatherDbInfo(client);
      const dumpStartedAt = Date.now();
      await runPgDump({
        host,
        port,
        user,
        password,
        dbName,
        dumpPath,
        snapshot,
      });
      dumpDurationMs = Date.now() - dumpStartedAt;
      await client.query("ROLLBACK");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const { sha256, bytes } = await sha256File(dumpPath);
    const manifest = buildManifest({
      dbInfo,
      source: { db_host: host, db_port: port, db_name: dbName },
      contract: {
        version: CONTRACT_VERSION,
        schema_hash: buildContract().schema_hash,
      },
      embedding: {
        // Defaults match src/embedding.ts: gemini-embedding-001 / 768.
        // Production (core01 launchd) overrides EMBEDDING_MODEL to the local
        // MLX deployment (embeddinggemma-300m-8bit); the manifest records
        // whatever the runtime that owns this database was configured with.
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
      },
      files: [{ name: DUMP_FILENAME, sha256, bytes }],
    });
    await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    const totalRows = Object.values(manifest.row_counts).reduce(
      (sum, n) => sum + n,
      0,
    );
    const receipt = {
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
    };
    console.log(JSON.stringify(receipt));
  } catch (err) {
    const receipt = {
      schema: BACKUP_RECEIPT_SCHEMA,
      operation: "backup",
      status: "failed",
      backup_dir: args.out,
      duration_ms: Date.now() - startedAt,
      error: redactSecret(
        err instanceof Error ? err.message : String(err),
        password,
      ),
    };
    console.log(JSON.stringify(receipt));
    process.exit(EXIT_FAILED);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}
