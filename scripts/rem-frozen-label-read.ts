import type { Pool, PoolClient } from "pg";

import {
  assertDreamRunSchema,
  loadFrozenCohort,
  type FrozenCohort,
} from "./rem-ethereal-cohort.ts";
import {
  remFrozenHumanLabelSchema,
  type RemFrozenHumanLabel,
} from "./rem-frozen-human-label.ts";

interface FrozenHumanLabelRow {
  run_id: string;
  candidate_id: string;
  namespace: string;
  cohort_digest: string;
  full_snapshot_sha256: string;
  content_hash: string;
  grade: string;
  note: string | null;
  graded_by: string;
  graded_at: Date;
}

interface ScopeIntegrityRow {
  has_scope_mismatch: boolean;
}

export type FrozenHumanLabel = RemFrozenHumanLabel & {
  graded_by: string;
  graded_at: Date;
};

interface FrozenHumanLabelLoadBase {
  schema: string;
  namespace: string;
  cohortDigest: string;
  fullSnapshotSha256: string;
}

export type FrozenHumanLabelLoad = FrozenHumanLabelLoadBase &
  (
    | { status: "label_table_absent"; labels: [] }
    | { status: "labels_loaded"; labels: FrozenHumanLabel[] }
  );

function isUndefinedTable(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "42P01"
  );
}

function loadBase(cohort: FrozenCohort): FrozenHumanLabelLoadBase {
  return {
    schema: cohort.schema,
    namespace: cohort.namespace,
    cohortDigest: cohort.digest,
    fullSnapshotSha256: cohort.fullSnapshotSha256,
  };
}

function assertProvenance(
  row: FrozenHumanLabelRow,
  cohort: FrozenCohort,
  expectedHash: string | undefined,
): void {
  if (
    row.run_id !== cohort.schema ||
    row.namespace !== cohort.namespace ||
    row.cohort_digest !== cohort.digest ||
    row.full_snapshot_sha256 !== cohort.fullSnapshotSha256 ||
    expectedHash === undefined ||
    row.content_hash !== expectedHash
  ) {
    throw new Error(`frozen human label provenance mismatch: ${row.candidate_id}`);
  }
}

function validateRow(
  row: FrozenHumanLabelRow,
  cohort: FrozenCohort,
  contentHashes: ReadonlyMap<string, string>,
): FrozenHumanLabel {
  const expectedHash = contentHashes.get(row.candidate_id);
  assertProvenance(row, cohort, expectedHash);
  if (typeof row.graded_by !== "string" || row.graded_by.length === 0) {
    throw new Error(`frozen human label grader is invalid: ${row.candidate_id}`);
  }
  if (!(row.graded_at instanceof Date) || Number.isNaN(row.graded_at.getTime())) {
    throw new Error(`frozen human label timestamp is invalid: ${row.candidate_id}`);
  }
  const label = remFrozenHumanLabelSchema.safeParse({
    candidate_id: row.candidate_id,
    grade: row.grade,
    ...(row.note === null ? {} : { note: row.note }),
  });
  if (!label.success) {
    throw new Error(`frozen human label payload is invalid: ${row.candidate_id}`);
  }
  return { ...label.data, graded_by: row.graded_by, graded_at: row.graded_at };
}

export async function loadFrozenHumanLabels(
  pool: Pool | PoolClient,
  schema: string,
  namespace: string,
): Promise<FrozenHumanLabelLoad> {
  assertDreamRunSchema(schema);
  const cohort = await loadFrozenCohort(pool, schema, namespace);
  const base = loadBase(cohort);
  let rows: FrozenHumanLabelRow[];
  try {
    rows = (
      await pool.query<FrozenHumanLabelRow>(
        `SELECT run_id, candidate_id, namespace, cohort_digest,
                full_snapshot_sha256, content_hash, grade, note, graded_by, graded_at
           FROM ${schema}.human_label
          WHERE run_id = $1 AND namespace = $2
          ORDER BY candidate_id`,
        [schema, namespace],
      )
    ).rows;
  } catch (error) {
    if (isUndefinedTable(error)) {
      return { ...base, status: "label_table_absent", labels: [] };
    }
    throw error;
  }
  const scopeIntegrity = await pool.query<ScopeIntegrityRow>(
    `SELECT EXISTS (
       SELECT 1 FROM ${schema}.human_label
        WHERE run_id IS DISTINCT FROM $1
           OR namespace IS DISTINCT FROM $2
     ) AS has_scope_mismatch`,
    [schema, namespace],
  );
  if (scopeIntegrity.rows[0]?.has_scope_mismatch !== false) {
    throw new Error("frozen human label scope mismatch");
  }
  const contentHashes = new Map(
    cohort.candidates.map((candidate) => [candidate.id, candidate.content_hash]),
  );
  const labels = rows.map((row) => validateRow(row, cohort, contentHashes));
  if (new Set(labels.map((label) => label.candidate_id)).size !== labels.length) {
    throw new Error("duplicate frozen human label candidate id");
  }
  return { ...base, status: "labels_loaded", labels };
}
