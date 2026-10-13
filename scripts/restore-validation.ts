/**
 * Post-restore validation for the restore CLI (issue #298), split out of
 * scripts/restore.ts so each of the six manifest checks is its own function
 * rather than one long body. The behaviour is unchanged: the same six checks
 * run in the same order and push the same result names and detail strings.
 *
 * Content-freedom is the standing constraint here — no namespace name, row
 * value, or driver message ever reaches a detail string, because the restore
 * receipt certifies that its contents carry none.
 */
import {
  ARCHIVED_AT_TABLE_ALLOWLIST,
  COUNT_TABLE_ALLOWLIST,
  NAMESPACE_TABLE_ALLOWLIST,
  type BackupManifestV1,
  type Queryable,
} from "./backup-lib.ts";

export interface ValidationResult {
  name: string;
  verdict: "ok" | "fail";
  detail: string;
}

/**
 * Content-free error identifier for validation details (post-#316
 * bulk_archive shape): pg error CODE when present, otherwise the error NAME.
 * Never err.message — driver messages embed literal row/namespace/constraint
 * content and the restore receipt certifies content-freedom.
 */
export function errorClassOf(err: unknown): string {
  return (
    (err as { code?: string }).code ?? (err instanceof Error ? err.name : "unknown")
  );
}

/**
 * Render a scalar column value from an untyped driver row as detail text.
 *
 * Driver rows are `unknown` per column. A pg scalar arrives as a string or a
 * number; anything else is a shape this check did not expect, and naming it as
 * such beats stringifying it into `[object Object]`. Nothing content-bearing
 * reaches a detail string: the two callers read a pgvector version and a
 * `format_type` result, both schema facts rather than row values.
 */
function scalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return String(value);
  return "unexpected-type";
}

/** A table name is usable only if it is allowlisted AND a plain identifier. */
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function isUsableTable(table: string, allowlist: Set<string>): boolean {
  return allowlist.has(table) && IDENT_RE.test(table);
}

function queryFailure(name: string, err: unknown): ValidationResult {
  return {
    name,
    verdict: "fail",
    detail: `query failed: ${errorClassOf(err)}`,
  };
}

/** 1. Applied migrations exactly match the manifest. */
async function checkAppliedMigrations(
  db: Queryable,
  manifest: BackupManifestV1,
): Promise<ValidationResult> {
  const name = "applied_migrations_match_manifest";
  try {
    const { rows } = await db.query(
      "SELECT filename FROM _migrations ORDER BY filename",
    );
    const applied = rows.map((r) => String(r.filename));
    const expected = [...manifest.migrations.applied].sort();
    const matches =
      applied.length === expected.length && applied.every((f, i) => f === expected[i]);
    return {
      name,
      verdict: matches ? "ok" : "fail",
      detail: matches
        ? `applied=${applied.length}`
        : `applied=${applied.length} expected=${expected.length} or ordering mismatch`,
    };
  } catch (err) {
    return queryFailure(name, err);
  }
}

/** One table's row count: exists, then exact match against the manifest. */
async function checkOneRowCount(
  db: Queryable,
  table: string,
  expectedCount: number,
): Promise<ValidationResult> {
  const name = `row_count:${table}`;
  try {
    const { rows: existsRows } = await db.query(
      `SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    if (existsRows.length === 0) {
      return { name, verdict: "fail", detail: "table missing after restore" };
    }
    const { rows } = await db.query(`SELECT COUNT(*)::bigint AS count FROM ${table}`);
    const actual = Number(rows[0]?.count ?? 0);
    return {
      name,
      verdict: actual === expectedCount ? "ok" : "fail",
      detail: `actual=${actual} expected=${expectedCount}`,
    };
  } catch (err) {
    return queryFailure(name, err);
  }
}

/**
 * 2. Row counts per table: exact match only (restore is offline).
 * FAIL CLOSED on tampered manifests: only table names in the fixed
 * allowlists (backup-lib.ts) are ever validated or interpolated — an
 * unknown key fails its validation instead of being skipped. The identifier
 * check is defense-in-depth BEHIND the allowlist intersection.
 */
async function checkRowCounts(
  db: Queryable,
  manifest: BackupManifestV1,
): Promise<ValidationResult[]> {
  const allowlist = new Set<string>(COUNT_TABLE_ALLOWLIST);
  const results: ValidationResult[] = [];
  for (const [table, expectedCount] of Object.entries(manifest.row_counts)) {
    if (!isUsableTable(table, allowlist)) {
      results.push({
        name: `row_count:${table}`,
        verdict: "fail",
        detail: "manifest table name is not an allowlisted identifier",
      });
      continue;
    }
    results.push(await checkOneRowCount(db, table, expectedCount));
  }
  return results;
}

/**
 * 3. Archived (soft-deleted) rows survive AS archived: exact count match,
 * and if any archived rows existed, at least one is still archived (the
 * count equality already proves it; the explicit >0 check keeps the
 * assertion honest if counts drift to 0=0).
 */
async function checkArchivedCounts(
  db: Queryable,
  manifest: BackupManifestV1,
): Promise<ValidationResult[]> {
  const allowlist = new Set<string>(ARCHIVED_AT_TABLE_ALLOWLIST);
  const results: ValidationResult[] = [];
  for (const [table, expectedArchived] of Object.entries(
    manifest.archived_row_counts,
  )) {
    const name = `archived_count:${table}`;
    if (!isUsableTable(table, allowlist)) {
      results.push({
        name,
        verdict: "fail",
        detail: "manifest table name is not an allowlisted identifier",
      });
      continue;
    }
    try {
      const { rows } = await db.query(
        `SELECT COUNT(*)::bigint AS count FROM ${table} WHERE archived_at IS NOT NULL`,
      );
      const actual = Number(rows[0]?.count ?? 0);
      const ok = actual === expectedArchived && (expectedArchived === 0 || actual > 0);
      results.push({
        name,
        verdict: ok ? "ok" : "fail",
        detail: `actual=${actual} expected=${expectedArchived}`,
      });
    } catch (err) {
      results.push(queryFailure(name, err));
    }
  }
  return results;
}

/**
 * 4. Distinct-namespace count matches the manifest inventory (count only —
 * namespace names never enter this process's output).
 */
async function checkDistinctNamespaces(
  db: Queryable,
  manifest: BackupManifestV1,
): Promise<ValidationResult> {
  const name = "distinct_namespace_count";
  try {
    const parts: string[] = [];
    for (const table of NAMESPACE_TABLE_ALLOWLIST) {
      const { rows } = await db.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
            AND column_name = 'namespace'`,
        [table],
      );
      if (rows.length > 0) parts.push(`SELECT namespace FROM ${table}`);
    }
    let actual = 0;
    if (parts.length > 0) {
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS count FROM (${parts.join(" UNION ")}) AS ns`,
      );
      actual = Number(rows[0]?.count ?? 0);
    }
    const expected = manifest.namespace_inventory.distinct_namespaces;
    return {
      name,
      verdict: actual === expected ? "ok" : "fail",
      detail: `actual=${actual} expected=${expected}`,
    };
  } catch (err) {
    return queryFailure(name, err);
  }
}

/**
 * 5. Namespace predicate columns exist (parameterized spot check on the
 * two highest-traffic predicate surfaces).
 */
async function checkNamespacePredicateColumns(
  db: Queryable,
): Promise<ValidationResult> {
  const name = "namespace_predicate_columns";
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS count FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = $1 AND column_name = $2)
            OR (table_name = $3 AND column_name = $4))`,
      ["thoughts", "namespace", "ob_session_lanes", "namespace"],
    );
    const count = Number(rows[0]?.count ?? 0);
    return {
      name,
      verdict: count === 2 ? "ok" : "fail",
      detail: `present=${count} expected=2`,
    };
  } catch (err) {
    return queryFailure(name, err);
  }
}

/** 6. pgvector extension + embedding column dimension usable for retrieval. */
async function checkVectorSurface(
  db: Queryable,
  manifest: BackupManifestV1,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  try {
    const { rows: extRows } = await db.query(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    const extVersion = extRows[0]?.extversion;
    results.push(
      extVersion === undefined
        ? {
            name: "pgvector_extension",
            verdict: "fail",
            detail: "vector extension missing after restore",
          }
        : {
            name: "pgvector_extension",
            verdict: "ok",
            detail: `version=${scalarText(extVersion)}`,
          },
    );
    const { rows: colRows } = await db.query(
      `SELECT format_type(a.atttypid, a.atttypmod) AS col_type
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1 AND a.attname = $2`,
      ["thoughts", "embedding"],
    );
    const rawColType = colRows[0]?.col_type;
    const colType = rawColType === undefined ? null : scalarText(rawColType);
    const expectedType = `halfvec(${manifest.embedding.dimensions})`;
    results.push({
      name: "embedding_column_dimension",
      verdict: colType === expectedType ? "ok" : "fail",
      detail: `actual=${colType ?? "missing"} expected=${expectedType}`,
    });
  } catch (err) {
    results.push(queryFailure("embedding_column_dimension", err));
  }
  return results;
}

/**
 * Validate the restored database against the manifest, BEFORE any forward
 * migration (forward migrations may legitimately rewrite rows; the manifest
 * counts describe the database as dumped).
 */
export async function validatePostRestore(
  db: Queryable,
  manifest: BackupManifestV1,
): Promise<ValidationResult[]> {
  return [
    await checkAppliedMigrations(db, manifest),
    ...(await checkRowCounts(db, manifest)),
    ...(await checkArchivedCounts(db, manifest)),
    await checkDistinctNamespaces(db, manifest),
    await checkNamespacePredicateColumns(db),
    ...(await checkVectorSurface(db, manifest)),
  ];
}
