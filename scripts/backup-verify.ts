#!/usr/bin/env bun
/**
 * Open Brain backup verification CLI (issue #298).
 *
 * Verifies a backup set (or a directory of backup sets) BEFORE any mutation
 * anywhere: file presence, sha256 integrity, drift, manifest schema/fields,
 * and compatibility against the CURRENT runtime (repo migrations head,
 * contract version, embedding model/dimension). Read-only: never mutates the
 * backup set or any database.
 *
 * Verdict policy (fail-closed):
 * - older backup migration head  -> ok, "restorable_with_migrations"
 * - unknown/newer migration head -> FAIL
 * - older contract version       -> warn
 * - newer/unparseable contract   -> FAIL
 * - embedding model/dim mismatch -> FAIL unless --allow-embedding-mismatch
 *   (re-embedding is not built; mismatched vectors corrupt retrieval)
 * - --max-age-hours N            -> exit ${EXIT_STALE} with a stale verdict
 *   when the newest VALID backup is older than N hours (stale-backup alert
 *   hook; see docs/backup-restore.md for cron/launchd wiring)
 *
 * Receipt (openbrain.backup_verify_receipt.v1, single line on stdout) is
 * content-free: per-element verdicts, ages, counts — no row content, no
 * namespace names, no credentials.
 *
 * Exit codes: 0 passed/warned, 1 failed, 2 usage, 3 stale.
 */
import { CONTRACT_VERSION } from "../src/contract.ts";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "../src/embedding.ts";
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_STALE,
  EXIT_USAGE,
  VERIFY_RECEIPT_SCHEMA,
  listRepoMigrations,
  verifyBackupPath,
  type CurrentRuntime,
} from "./backup-lib.ts";

export interface VerifyArgs {
  dir: string;
  allowEmbeddingMismatch: boolean;
  maxAgeHours: number | undefined;
}

function usage(exitCode: number = EXIT_USAGE): never {
  console.error(
    [
      "Usage: bun run scripts/backup-verify.ts --dir <path>",
      "       [--allow-embedding-mismatch] [--max-age-hours N]",
      "",
      "<path> is either a single backup set (contains manifest.json) or a",
      "root directory whose immediate subdirectories are backup sets.",
      "Read-only: verifies integrity and runtime compatibility, mutates",
      "nothing. Exit codes: 0 passed/warned, 1 failed, 2 usage, 3 stale.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

export function parseVerifyArgs(argv: string[]): VerifyArgs {
  let dir: string | undefined;
  let allowEmbeddingMismatch = false;
  let maxAgeHours: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dir") {
      dir = argv[++i];
      if (!dir) usage();
    } else if (arg === "--allow-embedding-mismatch") {
      allowEmbeddingMismatch = true;
    } else if (arg === "--max-age-hours") {
      const raw = argv[++i];
      const parsed = raw === undefined ? NaN : Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error("--max-age-hours requires a positive number");
        usage();
      }
      maxAgeHours = parsed;
    } else if (arg === "--help" || arg === "-h") usage(0);
    else {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
  }
  if (!dir) {
    console.error("--dir <path> is required");
    usage();
  }
  return { dir, allowEmbeddingMismatch, maxAgeHours };
}

async function main(): Promise<void> {
  const args = parseVerifyArgs(Bun.argv.slice(2));
  const runtime: CurrentRuntime = {
    repoMigrations: await listRepoMigrations(),
    contractVersion: CONTRACT_VERSION,
    embeddingModel: EMBEDDING_MODEL,
    embeddingDimensions: EMBEDDING_DIMENSIONS,
  };
  const result = await verifyBackupPath(args.dir, runtime, {
    allowEmbeddingMismatch: args.allowEmbeddingMismatch,
    maxAgeHours: args.maxAgeHours,
  });

  const receipt = {
    schema: VERIFY_RECEIPT_SCHEMA,
    operation: "backup_verify",
    status: result.status,
    path: args.dir,
    stale: result.stale,
    max_age_hours: args.maxAgeHours ?? null,
    newest_valid_age_hours:
      result.newest_valid_age_hours === null
        ? null
        : Number(result.newest_valid_age_hours.toFixed(3)),
    sets: result.sets.map((set) => ({
      dir: set.dir,
      status: set.status,
      migration_compat: set.migration_compat,
      contract_compat: set.contract_compat,
      age_hours:
        set.age_hours === null ? null : Number(set.age_hours.toFixed(3)),
      verdicts: set.verdicts,
    })),
  };
  console.log(JSON.stringify(receipt));

  if (result.status === "stale") process.exit(EXIT_STALE);
  if (result.status === "failed") process.exit(EXIT_FAILED);
  process.exit(EXIT_OK);
}

if (import.meta.main) {
  await main();
}
