/**
 * Backup-set verification for Open Brain (issue #298), split out of
 * scripts/backup-lib.ts so each module stays under the size the repo's
 * .oxlintrc.json enforces. Behavior is byte-identical to the code that lived
 * in backup-lib.ts; only the file boundary and the helper decomposition moved.
 *
 * Like its parent module, everything here is CONTENT-FREE: verdicts carry
 * element names, filenames, and reason CLASSES — never row content, namespace
 * names, tokens, or credentials.
 */
import { readdir, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  DUMP_FILENAME,
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_ID,
  compareContractVersions,
  compareMigrationSets,
  parseManifest,
  sha256File,
  type BackupManifestV1,
  type ContractCompat,
  type MigrationCompat,
} from "./backup-lib.ts";

export type Verdict = "ok" | "warn" | "fail";

export interface ElementVerdict {
  element: string;
  verdict: Verdict;
  reason: string;
}

export interface CurrentRuntime {
  repoMigrations: string[];
  contractVersion: string;
  embeddingModel: string;
  embeddingDimensions: number;
}

export interface VerifyOptions {
  allowEmbeddingMismatch?: boolean;
  maxAgeHours?: number;
  now?: Date;
}

export type VerifySetStatus = "passed" | "warned" | "failed";

export interface VerifySetResult {
  dir: string;
  status: VerifySetStatus;
  verdicts: ElementVerdict[];
  manifest: BackupManifestV1 | null;
  migration_compat: MigrationCompat | null;
  contract_compat: ContractCompat | null;
  age_hours: number | null;
}

type FileStat = Awaited<ReturnType<typeof stat>>;

function statusFromVerdicts(verdicts: ElementVerdict[]): VerifySetStatus {
  if (verdicts.some((v) => v.verdict === "fail")) return "failed";
  if (verdicts.some((v) => v.verdict === "warn")) return "warned";
  return "passed";
}

export function ageHours(createdAt: string, now: Date): number | null {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return null;
  return (now.getTime() - created) / 3_600_000;
}

/**
 * Read and validate manifest.json. Every distinct failure class gets its own
 * verdict, and a null return means no trustworthy manifest was obtained.
 */
async function readManifest(
  manifestPath: string,
  verdicts: ElementVerdict[],
): Promise<BackupManifestV1 | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    verdicts.push({
      element: "manifest",
      verdict: "fail",
      reason: "unparseable_json",
    });
    return null;
  }

  const schemaId =
    raw && typeof raw === "object" && "schema" in raw
      ? (raw as { schema: unknown }).schema
      : undefined;
  if (schemaId !== MANIFEST_SCHEMA_ID) {
    verdicts.push({
      element: "manifest",
      verdict: "fail",
      reason: "unknown_schema_id",
    });
    return null;
  }

  const parsed = parseManifest(raw);
  if (!parsed.manifest) {
    for (const err of parsed.errors) {
      verdicts.push({ element: "manifest_field", verdict: "fail", reason: err });
    }
    return null;
  }
  verdicts.push({ element: "manifest", verdict: "ok", reason: "valid" });
  return parsed.manifest;
}

/** Nothing in the directory beyond what the manifest lists, and the dump listed. */
async function checkFileInventory(
  dir: string,
  manifest: BackupManifestV1,
  verdicts: ElementVerdict[],
): Promise<void> {
  let entries: string[] = [];
  try {
    entries = (await readdir(dir)).filter((e) => !e.startsWith("."));
  } catch {
    verdicts.push({ element: "backup_dir", verdict: "fail", reason: "unreadable" });
  }
  const expected = new Set<string>([
    MANIFEST_FILENAME,
    ...manifest.files.map((f) => f.name),
  ]);
  for (const extra of entries.filter((e) => !expected.has(e))) {
    verdicts.push({
      element: `file:${extra}`,
      verdict: "fail",
      reason: "unexpected_file",
    });
  }
  if (!manifest.files.some((f) => f.name === DUMP_FILENAME)) {
    verdicts.push({
      element: `file:${DUMP_FILENAME}`,
      verdict: "fail",
      reason: "dump_not_listed_in_manifest",
    });
  }
}

/**
 * Size + sha256 for one manifest-listed file, plus the drift heuristic.
 *
 * Drift: a dump modified AFTER the manifest was written is reported
 * distinctly. sha256 is the integrity authority — when the checksum still
 * matches this is a warn (content proven identical), and when it does not
 * match the checksum failure already fails the set.
 */
async function checkOneFile(
  dir: string,
  file: BackupManifestV1["files"][number],
  manifestStat: FileStat | null,
  verdicts: ElementVerdict[],
): Promise<void> {
  const filePath = join(dir, file.name);
  let fileStat: FileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    verdicts.push({ element: `file:${file.name}`, verdict: "fail", reason: "missing" });
    return;
  }

  const { sha256, bytes } = await sha256File(filePath);
  if (bytes !== file.bytes) {
    verdicts.push({
      element: `file:${file.name}`,
      verdict: "fail",
      reason: "size_mismatch",
    });
  } else if (sha256 !== file.sha256) {
    verdicts.push({
      element: `file:${file.name}`,
      verdict: "fail",
      reason: "checksum_mismatch",
    });
  } else {
    verdicts.push({
      element: `file:${file.name}`,
      verdict: "ok",
      reason: "checksum_verified",
    });
  }

  if (
    manifestStat &&
    fileStat.mtimeMs > manifestStat.mtimeMs &&
    sha256 === file.sha256
  ) {
    verdicts.push({
      element: `file:${file.name}`,
      verdict: "warn",
      reason: "modified_after_manifest",
    });
  }
}

function migrationVerdictReason(compat: MigrationCompat): ElementVerdict {
  if (compat === "equal") {
    return { element: "migrations", verdict: "ok", reason: "equal_head" };
  }
  if (compat === "restorable_with_migrations") {
    return {
      element: "migrations",
      verdict: "ok",
      reason: "restorable_with_migrations",
    };
  }
  if (compat === "incompatible_interleaved") {
    return {
      element: "migrations",
      verdict: "fail",
      reason: "interleaved_migration_gap_fail_closed",
    };
  }
  return {
    element: "migrations",
    verdict: "fail",
    reason: "unknown_or_newer_migrations_fail_closed",
  };
}

function checkMigrations(
  manifest: BackupManifestV1,
  runtime: CurrentRuntime,
  verdicts: ElementVerdict[],
): MigrationCompat | null {
  const applied = manifest.migrations.applied;
  const sortedApplied = [...applied].sort();
  const expectedHead =
    sortedApplied.length > 0 ? (sortedApplied[sortedApplied.length - 1] ?? null) : null;
  if (manifest.migrations.head !== expectedHead) {
    verdicts.push({
      element: "migrations",
      verdict: "fail",
      reason: "head_inconsistent_with_applied_list",
    });
    return null;
  }
  const compat = compareMigrationSets(applied, runtime.repoMigrations);
  verdicts.push(migrationVerdictReason(compat));
  return compat;
}

function checkContract(
  manifest: BackupManifestV1,
  runtime: CurrentRuntime,
  verdicts: ElementVerdict[],
): ContractCompat {
  const compat = compareContractVersions(
    manifest.contract.version,
    runtime.contractVersion,
  );
  if (compat === "equal") {
    verdicts.push({ element: "contract", verdict: "ok", reason: "equal" });
  } else if (compat === "older") {
    verdicts.push({
      element: "contract",
      verdict: "warn",
      reason: "older_contract_restorable",
    });
  } else if (compat === "newer") {
    verdicts.push({
      element: "contract",
      verdict: "fail",
      reason: "newer_contract_fail_closed",
    });
  } else {
    verdicts.push({
      element: "contract",
      verdict: "fail",
      reason: "unparseable_contract_fail_closed",
    });
  }
  return compat;
}

function checkEmbedding(
  manifest: BackupManifestV1,
  runtime: CurrentRuntime,
  opts: VerifyOptions,
  verdicts: ElementVerdict[],
): void {
  const embeddingMatches =
    manifest.embedding.model === runtime.embeddingModel &&
    manifest.embedding.dimensions === runtime.embeddingDimensions;
  if (embeddingMatches) {
    verdicts.push({ element: "embedding", verdict: "ok", reason: "equal" });
  } else if (opts.allowEmbeddingMismatch) {
    verdicts.push({
      element: "embedding",
      verdict: "warn",
      reason: "mismatch_allowed_by_flag",
    });
  } else {
    // Re-embedding is not built; a restored database whose vectors came from a
    // different model/dimension would silently corrupt retrieval.
    verdicts.push({
      element: "embedding",
      verdict: "fail",
      reason: "model_or_dimension_mismatch_fail_closed",
    });
  }
}

function checkCreatedAt(
  manifest: BackupManifestV1,
  now: Date,
  verdicts: ElementVerdict[],
): number | null {
  const age = ageHours(manifest.created_at, now);
  if (age === null) {
    verdicts.push({
      element: "created_at",
      verdict: "fail",
      reason: "unparseable_timestamp",
    });
  } else if (age < 0) {
    // Future-dated created_at: same fail-closed semantics as an unparseable
    // timestamp — the set is invalid and cannot be trusted to satisfy a
    // staleness window.
    verdicts.push({
      element: "created_at",
      verdict: "fail",
      reason: "future_dated_timestamp",
    });
  }
  return age;
}

/**
 * Verify one backup-set directory against the filesystem and the CURRENT
 * runtime. Never mutates anything. Every distinct failure class gets its own
 * element verdict so operators can tell missing / corrupt / incomplete /
 * drifted apart at a glance.
 */
export async function verifyBackupSet(
  dir: string,
  runtime: CurrentRuntime,
  opts: VerifyOptions = {},
): Promise<VerifySetResult> {
  const verdicts: ElementVerdict[] = [];
  const now = opts.now ?? new Date();
  let manifest: BackupManifestV1 | null = null;
  let migrationCompat: MigrationCompat | null = null;
  let contractCompat: ContractCompat | null = null;
  let age: number | null = null;

  const manifestPath = join(dir, MANIFEST_FILENAME);
  let manifestStat: FileStat | null = null;
  try {
    manifestStat = await stat(manifestPath);
  } catch {
    verdicts.push({ element: "manifest", verdict: "fail", reason: "missing" });
  }

  if (manifestStat) {
    manifest = await readManifest(manifestPath, verdicts);
  }

  if (manifest) {
    await checkFileInventory(dir, manifest, verdicts);
    for (const file of manifest.files) {
      await checkOneFile(dir, file, manifestStat, verdicts);
    }
    migrationCompat = checkMigrations(manifest, runtime, verdicts);
    contractCompat = checkContract(manifest, runtime, verdicts);
    checkEmbedding(manifest, runtime, opts, verdicts);
    age = checkCreatedAt(manifest, now, verdicts);
  }

  return {
    dir,
    status: statusFromVerdicts(verdicts),
    verdicts,
    manifest,
    migration_compat: migrationCompat,
    contract_compat: contractCompat,
    age_hours: age,
  };
}

// ---------------------------------------------------------------------------
// Directory-level verification + staleness
// ---------------------------------------------------------------------------

export interface VerifyRootResult {
  status: VerifySetStatus | "stale";
  stale: boolean;
  newest_valid_age_hours: number | null;
  sets: VerifySetResult[];
}

export function evaluateStaleness(
  validAges: Array<number | null>,
  maxAgeHours: number | undefined,
): { stale: boolean; newestValidAgeHours: number | null } {
  // A negative age means a FUTURE-DATED created_at. Such a set is invalid
  // (verifyBackupSet fails it as future_dated_timestamp) and must never count
  // as the "newest" backup — clamping it would let one bogus timestamp mask
  // real staleness forever.
  const ages = validAges.filter((a): a is number => a !== null && a >= 0);
  const newest = ages.length > 0 ? Math.min(...ages) : null;
  if (maxAgeHours === undefined) return { stale: false, newestValidAgeHours: newest };
  if (newest === null) return { stale: true, newestValidAgeHours: null };
  return { stale: newest > maxAgeHours, newestValidAgeHours: newest };
}

/** Collect the immediate subdirectories of `path` that are backup sets. */
async function collectSetDirs(path: string): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(path);
  } catch {
    return [];
  }
  const setDirs: string[] = [];
  for (const entry of entries.sort()) {
    const setDir = join(path, entry);
    let entryStat: FileStat;
    try {
      entryStat = await stat(setDir);
    } catch {
      continue;
    }
    if (!entryStat.isDirectory()) continue;
    if (!existsSync(join(setDir, MANIFEST_FILENAME))) continue;
    setDirs.push(setDir);
  }
  return setDirs;
}

/**
 * Verify either a single backup set (dir contains manifest.json) or a root
 * directory whose immediate subdirectories are backup sets. Staleness is
 * evaluated over the newest VALID (passed or warned) set.
 */
export async function verifyBackupPath(
  path: string,
  runtime: CurrentRuntime,
  opts: VerifyOptions = {},
): Promise<VerifyRootResult> {
  const sets: VerifySetResult[] = [];
  const singleManifest = existsSync(join(path, MANIFEST_FILENAME));
  if (singleManifest) {
    sets.push(await verifyBackupSet(path, runtime, opts));
  } else {
    for (const setDir of await collectSetDirs(path)) {
      sets.push(await verifyBackupSet(setDir, runtime, opts));
    }
  }

  if (sets.length === 0) {
    // No backup sets at all: with a max-age window this is the stale-alert
    // condition (no valid backup exists); without one it is a plain failure.
    return {
      status: opts.maxAgeHours !== undefined ? "stale" : "failed",
      stale: opts.maxAgeHours !== undefined,
      newest_valid_age_hours: null,
      sets: [],
    };
  }

  const validAges = sets.filter((s) => s.status !== "failed").map((s) => s.age_hours);
  const { stale, newestValidAgeHours } = evaluateStaleness(validAges, opts.maxAgeHours);

  let status: VerifyRootResult["status"];
  if (sets.some((s) => s.status === "failed")) status = "failed";
  else if (sets.some((s) => s.status === "warned")) status = "warned";
  else status = "passed";
  // Staleness dominates: a directory whose newest valid backup is too old is
  // an alertable condition even if every set is individually intact.
  if (stale) status = "stale";

  return { status, stale, newest_valid_age_hours: newestValidAgeHours, sets };
}
