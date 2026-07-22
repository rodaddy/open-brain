/**
 * Shared backup/restore substrate for Open Brain (issue #298).
 *
 * Everything in this module is CONTENT-FREE by construction: manifests and
 * receipts carry counts, hashes, filenames, and version identifiers — never
 * row content, namespace NAMES, tokens, or credentials. Namespace inventory
 * is a distinct-namespace COUNT only; namespace names are scope metadata that
 * stays inside the database (and its dump), never in manifests or receipts.
 *
 * SQL is parameterized throughout. Table names are interpolated ONLY from the
 * fixed allowlists below (COUNT_TABLE_ALLOWLIST / NAMESPACE_TABLE_ALLOWLIST /
 * ARCHIVED_AT_TABLE_ALLOWLIST), never from arguments or the manifest.
 */
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema identifiers and file layout
// ---------------------------------------------------------------------------

export const MANIFEST_SCHEMA_ID = "openbrain.backup_manifest.v1";
export const BACKUP_RECEIPT_SCHEMA = "openbrain.backup_receipt.v1";
export const VERIFY_RECEIPT_SCHEMA = "openbrain.backup_verify_receipt.v1";
export const RESTORE_RECEIPT_SCHEMA = "openbrain.restore_receipt.v1";

/** pg_dump custom-format archive filename inside a backup set directory. */
export const DUMP_FILENAME = "openbrain.dump";
export const MANIFEST_FILENAME = "manifest.json";

/** Exit codes shared by the operator CLIs. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_STALE = 3;

// ---------------------------------------------------------------------------
// Table allowlists (the ONLY source of interpolated identifiers)
// ---------------------------------------------------------------------------

/**
 * Tables whose row counts are recorded in the manifest. Enumerated from the
 * real migrations (001, 006_cognitive_tiering, 010, 012, 013, 022 and the
 * in-code `_migrations` tracking table). Missing tables (older schema heads)
 * are simply omitted from the manifest counts.
 */
export const COUNT_TABLE_ALLOWLIST = [
  "_migrations",
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
  "entry_access_log",
  "discarded_entries",
  "ob_entities",
  "ob_links",
  "ob_session_lanes",
  "ob_session_events",
  "mcp_tool_audit_log",
] as const;

/**
 * Tables with a NOT NULL namespace column that participate in the
 * distinct-namespace inventory COUNT. discarded_entries (nullable namespace)
 * and mcp_tool_audit_log (namespace_source, different semantics) are
 * intentionally excluded so the metric is deterministic across backup and
 * restore.
 */
export const NAMESPACE_TABLE_ALLOWLIST = [
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
  "ob_entities",
  "ob_links",
  "ob_session_lanes",
] as const;

/** Tables carrying the archived_at soft-delete marker (002, 017). */
export const ARCHIVED_AT_TABLE_ALLOWLIST = [
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
  "ob_entities",
  "ob_links",
] as const;

// ---------------------------------------------------------------------------
// Manifest schema (zod) and types
// ---------------------------------------------------------------------------

/**
 * Manifest file names must be BARE filenames. Without this constraint a
 * tampered manifest could point verify's stat/sha256 pass at arbitrary
 * paths ("../x", "/etc/...") and use it as a path-traversal read oracle.
 * The regex forbids '/', '\\', a leading dot ('.', '..', dotfiles), and any
 * character outside [A-Za-z0-9._-].
 */
const BARE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const fileEntrySchema = z.object({
  name: z
    .string()
    .min(1)
    .refine(
      (name) =>
        name !== "." &&
        name !== ".." &&
        !name.includes("/") &&
        !name.includes("\\") &&
        BARE_FILENAME_RE.test(name),
      { message: "file name must be a bare filename" },
    ),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
});

export const manifestSchema = z.object({
  schema: z.literal(MANIFEST_SCHEMA_ID),
  created_at: z.string().min(1),
  source: z.object({
    db_host: z.string().min(1),
    db_port: z.number().int().positive(),
    db_name: z.string().min(1),
    hostname: z.string().min(1),
  }),
  migrations: z.object({
    head: z.string().nullable(),
    applied: z.array(z.string()),
  }),
  contract: z.object({
    version: z.string().min(1),
    schema_hash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  embedding: z.object({
    model: z.string().min(1),
    dimensions: z.number().int().positive(),
    column_type: z.literal("halfvec"),
  }),
  pgvector_version: z.string().nullable(),
  files: z.array(fileEntrySchema).min(1),
  row_counts: z
    .record(z.string(), z.number().int().nonnegative())
    .refine((counts) => "_migrations" in counts, {
      message: "row_counts must include the _migrations table",
    }),
  archived_row_counts: z.record(z.string(), z.number().int().nonnegative()),
  namespace_inventory: z.object({
    distinct_namespaces: z.number().int().nonnegative(),
  }),
});

export type BackupManifestV1 = z.infer<typeof manifestSchema>;
export type ManifestFileEntry = z.infer<typeof fileEntrySchema>;

// ---------------------------------------------------------------------------
// Minimal query interface (Pool or PoolClient), matching repo convention
// ---------------------------------------------------------------------------

export interface Queryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
}

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

export async function sha256File(
  path: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

// ---------------------------------------------------------------------------
// Repo migration listing (current-runtime side of compatibility checks)
// ---------------------------------------------------------------------------

const REPO_MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "db",
  "migrations",
);

export async function listRepoMigrations(
  dir: string = REPO_MIGRATIONS_DIR,
): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
}

// ---------------------------------------------------------------------------
// Database info gathering (counts and versions only — content-free)
// ---------------------------------------------------------------------------

export interface BackupDbInfo {
  appliedMigrations: string[];
  pgvectorVersion: string | null;
  rowCounts: Record<string, number>;
  archivedRowCounts: Record<string, number>;
  distinctNamespaces: number;
}

async function tableExists(db: Queryable, table: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return rows.length > 0;
}

async function columnExists(
  db: Queryable,
  table: string,
  column: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

/**
 * Gather content-free database facts for the manifest. Only COUNT(*) and
 * version strings ever leave the database; no row content and no namespace
 * names are read into this process's output.
 */
export async function gatherDbInfo(db: Queryable): Promise<BackupDbInfo> {
  if (!(await tableExists(db, "_migrations"))) {
    throw new Error(
      "target database has no _migrations table — only migrated Open Brain " +
        "databases can be backed up (run `bun run migrate` first)",
    );
  }
  const { rows: appliedRows } = await db.query(
    "SELECT filename FROM _migrations ORDER BY filename",
  );
  const appliedMigrations = appliedRows.map((r) => String(r.filename));

  const { rows: vectorRows } = await db.query(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
  );
  const pgvectorVersion =
    vectorRows.length > 0 ? String(vectorRows[0].extversion) : null;

  const rowCounts: Record<string, number> = {};
  for (const table of COUNT_TABLE_ALLOWLIST) {
    if (!(await tableExists(db, table))) continue;
    // Table name comes from COUNT_TABLE_ALLOWLIST above, never from input.
    const { rows } = await db.query(
      `SELECT COUNT(*)::bigint AS count FROM ${table}`,
    );
    rowCounts[table] = Number(rows[0]?.count ?? 0);
  }

  const archivedRowCounts: Record<string, number> = {};
  for (const table of ARCHIVED_AT_TABLE_ALLOWLIST) {
    if (!(await tableExists(db, table))) continue;
    if (!(await columnExists(db, table, "archived_at"))) continue;
    // Table name comes from ARCHIVED_AT_TABLE_ALLOWLIST above.
    const { rows } = await db.query(
      `SELECT COUNT(*)::bigint AS count FROM ${table} WHERE archived_at IS NOT NULL`,
    );
    archivedRowCounts[table] = Number(rows[0]?.count ?? 0);
  }

  const namespaceParts: string[] = [];
  for (const table of NAMESPACE_TABLE_ALLOWLIST) {
    if (!(await tableExists(db, table))) continue;
    if (!(await columnExists(db, table, "namespace"))) continue;
    // Table name comes from NAMESPACE_TABLE_ALLOWLIST above. UNION dedupes,
    // and only COUNT(*) leaves the query — names never reach the manifest.
    namespaceParts.push(`SELECT namespace FROM ${table}`);
  }
  let distinctNamespaces = 0;
  if (namespaceParts.length > 0) {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS count FROM (${namespaceParts.join(" UNION ")}) AS ns`,
    );
    distinctNamespaces = Number(rows[0]?.count ?? 0);
  }

  return {
    appliedMigrations,
    pgvectorVersion,
    rowCounts,
    archivedRowCounts,
    distinctNamespaces,
  };
}

// ---------------------------------------------------------------------------
// Manifest construction
// ---------------------------------------------------------------------------

export interface ManifestBuildInput {
  dbInfo: BackupDbInfo;
  source: { db_host: string; db_port: number; db_name: string };
  contract: { version: string; schema_hash: string };
  embedding: { model: string; dimensions: number };
  files: ManifestFileEntry[];
  createdAt?: string;
  hostname?: string;
}

export function buildManifest(input: ManifestBuildInput): BackupManifestV1 {
  const applied = [...input.dbInfo.appliedMigrations].sort();
  const manifest: BackupManifestV1 = {
    schema: MANIFEST_SCHEMA_ID,
    created_at: input.createdAt ?? new Date().toISOString(),
    source: {
      db_host: input.source.db_host,
      db_port: input.source.db_port,
      db_name: input.source.db_name,
      hostname: input.hostname ?? osHostname(),
    },
    migrations: {
      head: applied.length > 0 ? applied[applied.length - 1]! : null,
      applied,
    },
    contract: {
      version: input.contract.version,
      schema_hash: input.contract.schema_hash,
    },
    embedding: {
      model: input.embedding.model,
      dimensions: input.embedding.dimensions,
      column_type: "halfvec",
    },
    pgvector_version: input.dbInfo.pgvectorVersion,
    files: input.files,
    row_counts: input.dbInfo.rowCounts,
    archived_row_counts: input.dbInfo.archivedRowCounts,
    namespace_inventory: {
      distinct_namespaces: input.dbInfo.distinctNamespaces,
    },
  };
  // Round-trip through the schema so a build bug fails at backup time, not at
  // verify/restore time.
  return manifestSchema.parse(manifest);
}

export function parseManifest(
  raw: unknown,
):
  | { manifest: BackupManifestV1; errors: [] }
  | { manifest: null; errors: string[] } {
  const result = manifestSchema.safeParse(raw);
  if (result.success) return { manifest: result.data, errors: [] };
  const errors = result.error.issues.map(
    (issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`,
  );
  return { manifest: null, errors };
}

// ---------------------------------------------------------------------------
// Compatibility comparisons (fail-closed on anything ambiguous)
// ---------------------------------------------------------------------------

export type MigrationCompat =
  | "equal"
  | "restorable_with_migrations"
  | "unknown_migrations"
  | "incompatible_interleaved";

/**
 * "restorable_with_migrations" requires the sorted backup applied list to be
 * an exact PREFIX of the sorted repo list — subset membership is not enough.
 * An interleaved / mid-sequence gap (e.g. backup applied 001,003 against repo
 * 001,002,003) would make the forward-migration path apply 002 AFTER 003 ran,
 * an ordering the migration authors never tested; that case fails closed as
 * "incompatible_interleaved".
 */
export function compareMigrationSets(
  backupApplied: string[],
  repoMigrations: string[],
): MigrationCompat {
  const repoSorted = [...repoMigrations].sort();
  const backupSorted = [...backupApplied].sort();
  const repoSet = new Set(repoSorted);
  for (const file of backupSorted) {
    if (!repoSet.has(file)) return "unknown_migrations";
  }
  for (let i = 0; i < backupSorted.length; i++) {
    if (backupSorted[i] !== repoSorted[i]) return "incompatible_interleaved";
  }
  return backupSorted.length === repoSorted.length
    ? "equal"
    : "restorable_with_migrations";
}

export interface ParsedContractVersion {
  date: string;
  family: string;
  rev: number;
}

/** Parses versions shaped like "2026-07-17.memory-tools.v22". */
export function parseContractVersion(
  version: string,
): ParsedContractVersion | null {
  const m = version.match(/^(\d{4}-\d{2}-\d{2})\.(.+)\.v(\d+)$/);
  if (!m) return null;
  return { date: m[1]!, family: m[2]!, rev: Number(m[3]!) };
}

export type ContractCompat = "equal" | "older" | "newer" | "unparseable";

export function compareContractVersions(
  backupVersion: string,
  currentVersion: string,
): ContractCompat {
  if (backupVersion === currentVersion) return "equal";
  const backup = parseContractVersion(backupVersion);
  const current = parseContractVersion(currentVersion);
  if (!backup || !current || backup.family !== current.family) {
    return "unparseable";
  }
  if (backup.date !== current.date) {
    return backup.date < current.date ? "older" : "newer";
  }
  if (backup.rev === current.rev) return "equal";
  return backup.rev < current.rev ? "older" : "newer";
}

// ---------------------------------------------------------------------------
// Backup-set verification
// ---------------------------------------------------------------------------

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
  let manifestStat: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    manifestStat = await stat(manifestPath);
  } catch {
    verdicts.push({
      element: "manifest",
      verdict: "fail",
      reason: "missing",
    });
  }

  if (manifestStat) {
    let raw: unknown = null;
    let parseFailed = false;
    try {
      raw = JSON.parse(await Bun.file(manifestPath).text());
    } catch {
      parseFailed = true;
      verdicts.push({
        element: "manifest",
        verdict: "fail",
        reason: "unparseable_json",
      });
    }
    if (!parseFailed) {
      const schemaId =
        raw && typeof raw === "object" ? (raw as any).schema : undefined;
      if (schemaId !== MANIFEST_SCHEMA_ID) {
        verdicts.push({
          element: "manifest",
          verdict: "fail",
          reason: "unknown_schema_id",
        });
      } else {
        const parsed = parseManifest(raw);
        if (!parsed.manifest) {
          for (const err of parsed.errors) {
            verdicts.push({
              element: "manifest_field",
              verdict: "fail",
              reason: err,
            });
          }
        } else {
          manifest = parsed.manifest;
          verdicts.push({
            element: "manifest",
            verdict: "ok",
            reason: "valid",
          });
        }
      }
    }
  }

  if (manifest) {
    // --- file inventory: every manifest file present, nothing extra --------
    let entries: string[] = [];
    try {
      entries = (await readdir(dir)).filter((e) => !e.startsWith("."));
    } catch {
      verdicts.push({
        element: "backup_dir",
        verdict: "fail",
        reason: "unreadable",
      });
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

    for (const file of manifest.files) {
      const filePath = join(dir, file.name);
      let fileStat: Awaited<ReturnType<typeof stat>>;
      try {
        fileStat = await stat(filePath);
      } catch {
        verdicts.push({
          element: `file:${file.name}`,
          verdict: "fail",
          reason: "missing",
        });
        continue;
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
      // Drift heuristic: a dump modified AFTER the manifest was written is
      // reported distinctly. sha256 above is the integrity authority — when
      // the checksum still matches this is a warn (content proven identical),
      // and when it does not match the checksum failure above already fails
      // the set.
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

    // --- migration compatibility ------------------------------------------
    const applied = manifest.migrations.applied;
    const expectedHead =
      applied.length > 0 ? [...applied].sort().at(-1)! : null;
    if (manifest.migrations.head !== expectedHead) {
      verdicts.push({
        element: "migrations",
        verdict: "fail",
        reason: "head_inconsistent_with_applied_list",
      });
    } else {
      migrationCompat = compareMigrationSets(applied, runtime.repoMigrations);
      if (migrationCompat === "equal") {
        verdicts.push({
          element: "migrations",
          verdict: "ok",
          reason: "equal_head",
        });
      } else if (migrationCompat === "restorable_with_migrations") {
        verdicts.push({
          element: "migrations",
          verdict: "ok",
          reason: "restorable_with_migrations",
        });
      } else if (migrationCompat === "incompatible_interleaved") {
        verdicts.push({
          element: "migrations",
          verdict: "fail",
          reason: "interleaved_migration_gap_fail_closed",
        });
      } else {
        verdicts.push({
          element: "migrations",
          verdict: "fail",
          reason: "unknown_or_newer_migrations_fail_closed",
        });
      }
    }

    // --- contract compatibility -------------------------------------------
    contractCompat = compareContractVersions(
      manifest.contract.version,
      runtime.contractVersion,
    );
    if (contractCompat === "equal") {
      verdicts.push({ element: "contract", verdict: "ok", reason: "equal" });
    } else if (contractCompat === "older") {
      verdicts.push({
        element: "contract",
        verdict: "warn",
        reason: "older_contract_restorable",
      });
    } else if (contractCompat === "newer") {
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

    // --- embedding compatibility ------------------------------------------
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
      // Re-embedding is not built; a restored database whose vectors came
      // from a different model/dimension would silently corrupt retrieval.
      verdicts.push({
        element: "embedding",
        verdict: "fail",
        reason: "model_or_dimension_mismatch_fail_closed",
      });
    }

    age = ageHours(manifest.created_at, now);
    if (age === null) {
      verdicts.push({
        element: "created_at",
        verdict: "fail",
        reason: "unparseable_timestamp",
      });
    } else if (age < 0) {
      // Future-dated created_at: same fail-closed semantics as an
      // unparseable timestamp — the set is invalid and cannot be trusted to
      // satisfy a staleness window.
      verdicts.push({
        element: "created_at",
        verdict: "fail",
        reason: "future_dated_timestamp",
      });
    }
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
  if (maxAgeHours === undefined)
    return { stale: false, newestValidAgeHours: newest };
  if (newest === null) return { stale: true, newestValidAgeHours: null };
  return { stale: newest > maxAgeHours, newestValidAgeHours: newest };
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
  const singleManifest = await Bun.file(join(path, MANIFEST_FILENAME)).exists();
  if (singleManifest) {
    sets.push(await verifyBackupSet(path, runtime, opts));
  } else {
    let entries: string[] = [];
    try {
      entries = await readdir(path);
    } catch {
      // fall through: zero sets found
    }
    for (const entry of entries.sort()) {
      const setDir = join(path, entry);
      let entryStat;
      try {
        entryStat = await stat(setDir);
      } catch {
        continue;
      }
      if (!entryStat.isDirectory()) continue;
      if (!(await Bun.file(join(setDir, MANIFEST_FILENAME)).exists())) continue;
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

  const validAges = sets
    .filter((s) => s.status !== "failed")
    .map((s) => s.age_hours);
  const { stale, newestValidAgeHours } = evaluateStaleness(
    validAges,
    opts.maxAgeHours,
  );

  let status: VerifyRootResult["status"];
  if (sets.some((s) => s.status === "failed")) status = "failed";
  else if (sets.some((s) => s.status === "warned")) status = "warned";
  else status = "passed";
  // Staleness dominates: a directory whose newest valid backup is too old is
  // an alertable condition even if every set is individually intact.
  if (stale) status = "stale";

  return {
    status,
    stale,
    newest_valid_age_hours: newestValidAgeHours,
    sets,
  };
}

// ---------------------------------------------------------------------------
// pg tool resolution (host binaries by default; docker-exec override for CI)
// ---------------------------------------------------------------------------

/**
 * Resolve the argv prefix for a Postgres client tool. By default the tool is
 * invoked directly from PATH. CI overrides these with docker-exec prefixes so
 * the tools always match the pinned server image major version, e.g.
 *   OPENBRAIN_PG_DUMP_BIN="docker exec -e PGPASSWORD <container> pg_dump"
 *   OPENBRAIN_PG_RESTORE_BIN="docker exec -i -e PGPASSWORD <container> pg_restore"
 * `-e PGPASSWORD` (no value) propagates the password from the docker CLI's
 * environment BY NAME — the credential never appears in argv anywhere.
 */
export function resolvePgTool(
  tool: "pg_dump" | "pg_restore",
  env: Record<string, string | undefined> = process.env,
): string[] {
  const override =
    tool === "pg_dump"
      ? env.OPENBRAIN_PG_DUMP_BIN
      : env.OPENBRAIN_PG_RESTORE_BIN;
  if (override && override.trim().length > 0) {
    return override.trim().split(/\s+/);
  }
  return [tool];
}

export function pgToolAvailable(
  tool: "pg_dump" | "pg_restore",
  env: Record<string, string | undefined> = process.env,
): boolean {
  try {
    const argv = resolvePgTool(tool, env);
    const result = Bun.spawnSync([...argv, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Receipt redaction guard
// ---------------------------------------------------------------------------

/**
 * Defense-in-depth: strip a known secret from any operator-facing text (e.g.
 * pg tool stderr) before it is printed. The scripts never put credentials in
 * argv or receipts; this guards against a child process echoing its own
 * connection failure detail.
 */
export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length === 0) return text;
  return text.split(secret).join("[redacted]");
}

/**
 * Summarize child pg_dump/pg_restore stderr WITHOUT carrying row content.
 * Raw pg stderr can embed literal row data (COPY "CONTEXT: ... line N" blocks,
 * DETAIL/HINT lines, quoted values); receipts certify content-freedom, so
 * only an error CLASS may survive: the first non-empty stderr line, with the
 * tool-name/severity prefixes stripped, truncated at the first ':' or quote
 * character (everything after is potentially data-bearing detail).
 */
export function summarizeChildStderr(stderrText: string): string {
  const firstLine =
    stderrText
      .split(/\r?\n/)
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "";
  if (firstLine.length === 0) return "no stderr output";
  let line = firstLine;
  for (let i = 0; i < 4; i++) {
    const prefix = line.match(
      /^(pg_dump|pg_restore|error|warning|fatal|panic):\s*/i,
    );
    if (!prefix) break;
    line = line.slice(prefix[0].length);
  }
  const cut = line.search(/[:"'`]/);
  const classPortion = (cut === -1 ? line : line.slice(0, cut))
    .trim()
    .slice(0, 160);
  return classPortion.length > 0 ? classPortion : "unclassifiable stderr";
}
