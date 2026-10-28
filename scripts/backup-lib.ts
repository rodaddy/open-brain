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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
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

/**
 * A query result row. Callers read individual columns and coerce them
 * themselves (`Number(...)`, `String(...)`), which is what the pg driver's
 * untyped row already required — this makes that coercion explicit instead of
 * implicit.
 *
 * Every column this module and scripts/restore.ts read is named here, each
 * optional and `unknown`, which is what lets the row be something other than
 * `any`: a reader gets a value it must coerce rather than one it may treat as
 * anything, and a caller supplying rows (the fakes in scripts/restore.test.ts
 * declare their own narrower interfaces) still satisfies the shape. Adding a
 * column to a query means adding it here — deliberately, so the set of columns
 * that cross this boundary stays written down.
 */
export interface QueryRow {
  filename?: unknown;
  count?: unknown;
  extversion?: unknown;
  namespace?: unknown;
  col_type?: unknown;
  schemaname?: unknown;
  content?: unknown;
  /** The unnamed column of an existence probe (`SELECT 1 FROM ...`). */
  "1"?: unknown;
}

export interface Queryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: QueryRow[]; rowCount?: number | null }>;
}

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

export async function sha256File(
  path: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  // createReadStream yields Buffers where the Bun stream yielded Uint8Arrays.
  // Both are accepted by hash.update() and both expose .length as the byte
  // count, so the sha256 and the byte total are unchanged.
  const stream = createReadStream(path);
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
  "server",
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
async function gatherRowCounts(db: Queryable): Promise<Record<string, number>> {
  const rowCounts: Record<string, number> = {};
  for (const table of COUNT_TABLE_ALLOWLIST) {
    if (!(await tableExists(db, table))) continue;
    // Table name comes from COUNT_TABLE_ALLOWLIST above, never from input.
    const { rows } = await db.query(`SELECT COUNT(*)::bigint AS count FROM ${table}`);
    rowCounts[table] = Number(rows[0]?.count ?? 0);
  }
  return rowCounts;
}

async function gatherArchivedRowCounts(db: Queryable): Promise<Record<string, number>> {
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
  return archivedRowCounts;
}

async function gatherDistinctNamespaces(db: Queryable): Promise<number> {
  const namespaceParts: string[] = [];
  for (const table of NAMESPACE_TABLE_ALLOWLIST) {
    if (!(await tableExists(db, table))) continue;
    if (!(await columnExists(db, table, "namespace"))) continue;
    // Table name comes from NAMESPACE_TABLE_ALLOWLIST above. UNION dedupes,
    // and only COUNT(*) leaves the query — names never reach the manifest.
    namespaceParts.push(`SELECT namespace FROM ${table}`);
  }
  if (namespaceParts.length === 0) return 0;
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count FROM (${namespaceParts.join(" UNION ")}) AS ns`,
  );
  return Number(rows[0]?.count ?? 0);
}

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
    vectorRows.length > 0 ? String(vectorRows[0]?.extversion) : null;

  return {
    appliedMigrations,
    pgvectorVersion,
    rowCounts: await gatherRowCounts(db),
    archivedRowCounts: await gatherArchivedRowCounts(db),
    distinctNamespaces: await gatherDistinctNamespaces(db),
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
      head: applied.length > 0 ? (applied[applied.length - 1] ?? null) : null,
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
): { manifest: BackupManifestV1; errors: [] } | { manifest: null; errors: string[] } {
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

const LEGACY_MIGRATION_REPLACEMENTS = new Map([
  ["005_fts_hybrid", "005_fts_hybrid.sql"],
  ["010_chunking.sql", "011_chunking.sql"],
]);

// These are known duplicate ledger rows, not substitutes for the canonical
// migrations. Ignore one only when the canonical filename remains present on
// both sides of the compatibility comparison.
function normalizeAppliedMigrationHistory(
  applied: string[],
  repoMigrations: string[],
): string[] | null {
  if (
    new Set(applied).size !== applied.length ||
    new Set(repoMigrations).size !== repoMigrations.length
  ) {
    return null;
  }

  const repoSet = new Set(repoMigrations);
  const appliedSet = new Set(applied);
  const normalized = new Set<string>();
  for (const file of applied) {
    const replacement = LEGACY_MIGRATION_REPLACEMENTS.get(file);
    if (replacement) {
      if (!repoSet.has(replacement) || !appliedSet.has(replacement)) return null;
      continue;
    }
    normalized.add(file);
  }
  return [...normalized].sort();
}

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
  const backupSorted = normalizeAppliedMigrationHistory(backupApplied, repoMigrations);
  if (!backupSorted) return "unknown_migrations";
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
export function parseContractVersion(version: string): ParsedContractVersion | null {
  const m = version.match(/^(\d{4}-\d{2}-\d{2})\.(.+)\.v(\d+)$/);
  const [, date, family, rev] = m ?? [];
  if (date === undefined || family === undefined || rev === undefined) return null;
  return { date, family, rev: Number(rev) };
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
// Backup-set verification (implemented in ./backup-verify-lib.ts)
// ---------------------------------------------------------------------------

// The verification pass lives in its own module so each file stays under the
// size .oxlintrc.json enforces. It is re-exported here because every existing
// caller imports it from this module; the split is a file boundary only.
export {
  ageHours,
  evaluateStaleness,
  verifyBackupPath,
  verifyBackupSet,
} from "./backup-verify-lib.ts";
export type {
  CurrentRuntime,
  ElementVerdict,
  Verdict,
  VerifyOptions,
  VerifyRootResult,
  VerifySetResult,
  VerifySetStatus,
} from "./backup-verify-lib.ts";

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
    tool === "pg_dump" ? env.OPENBRAIN_PG_DUMP_BIN : env.OPENBRAIN_PG_RESTORE_BIN;
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
    const [command, ...rest] = resolvePgTool(tool, env);
    if (command === undefined) return false;
    // spawnSync, not execFileSync: resolvePgTool may return a multi-word
    // wrapper (e.g. a docker-exec override), so the argv array shape has to
    // survive. Node reports the exit code as `status`, NOT `exitCode`, and
    // `status` is null when the child was killed by a signal or never
    // launched -- both of which must read as unavailable, so the comparison
    // to 0 is what makes null fall through to false.
    const result = spawnSync(command, [...rest, "--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return result.error === undefined && result.status === 0;
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
 * Strip ANSI escape sequences and other C0/C1 control characters from a line
 * of child-process stderr.
 *
 * A child that believes it is writing to a terminal — or that has `FORCE_COLOR`
 * in its inherited environment — wraps its own diagnostics in SGR sequences,
 * so the bytes arriving on the pipe are `ESC[0mESC[31mpg_dump: error: ...`
 * rather than `pg_dump: error: ...`. Those leading escapes defeat every
 * `^`-anchored classifier downstream, and control characters have no business
 * in a receipt regardless: they are non-printable payload that can reposition
 * a cursor or recolor an operator's terminal when a receipt is displayed.
 */
/**
 * The control characters these patterns MUST match, named rather than written
 * as literals inside the regexes. Matching control characters is the entire
 * point of this function, so the patterns are assembled from these constants:
 * the intent is stated once, here, instead of asserted per-expression.
 */
const ESC = "\u001B";
const BEL = "\u0007";
/** C0 (NUL..US), DEL, and the C1 range — everything non-printable. */
const C0_C1_CLASS = "[\u0000-\u001F\u007F-\u009F]";

/** OSC: ESC ] ... BEL, or ESC ] ... ESC backslash — consumed whole, payload included. */
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
/** CSI: ESC [ parameter bytes, intermediate bytes, one final byte. */
const CSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
/** Remaining two-character escapes: ESC followed by one final byte. */
const TWO_CHAR_ESCAPE_RE = new RegExp(`${ESC}[@-Z\\\\-_]`, "g");
/** Any leftover control character, including a bare ESC or BEL. */
const CONTROL_CHAR_RE = new RegExp(C0_C1_CLASS, "g");

function stripControlSequences(line: string): string {
  return (
    line
      // OSC payload (title/hyperlink text) is data-bearing, so it goes too.
      .replace(OSC_RE, "")
      // Colors and cursor moves.
      .replace(CSI_RE, "")
      .replace(TWO_CHAR_ESCAPE_RE, "")
      .replace(CONTROL_CHAR_RE, "")
  );
}

/**
 * Summarize child pg_dump/pg_restore stderr WITHOUT carrying row content.
 * Raw pg stderr can embed literal row data (COPY "CONTEXT: ... line N" blocks,
 * DETAIL/HINT lines, quoted values); receipts certify content-freedom, so
 * only an error CLASS may survive: the first non-empty stderr line, stripped
 * of terminal control sequences, with the tool-name/severity prefixes removed,
 * truncated at the first ':' or quote character (everything after is
 * potentially data-bearing detail).
 */
export function summarizeChildStderr(stderrText: string): string {
  const firstLine =
    stderrText
      .split(/\r?\n/)
      .map((l) => stripControlSequences(l).trim())
      .find((l) => l.length > 0) ?? "";
  if (firstLine.length === 0) return "no stderr output";
  let line = firstLine;
  for (let i = 0; i < 4; i++) {
    const prefix = line.match(/^(pg_dump|pg_restore|error|warning|fatal|panic):\s*/i);
    if (!prefix) break;
    line = line.slice(prefix[0].length);
  }
  const cut = line.search(/[:"'`]/);
  const classPortion = (cut === -1 ? line : line.slice(0, cut)).trim().slice(0, 160);
  return classPortion.length > 0 ? classPortion : "unclassifiable stderr";
}
