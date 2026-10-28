import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { RemCandidate } from "../server/maintenance/dream-rem.ts";

export const FROZEN_COHORT_SIZE = 50;
export const FROZEN_SELECTION_VERSION = "rem-ethereal-frozen50-v1";
const SCHEMA_PATTERN = /^dream_run_[0-9]{3}$/;

interface CandidateRow {
  id: string;
  namespace: string;
  candidate_type: string;
  content: string;
  content_hash: string;
  uncertain: boolean;
  uncertainty_reason: string | null;
  model: string | null;
  session_count: string | null;
  occurrence_count: string | null;
  reinforcement_count: string;
}

interface ManifestRow {
  run_id: string;
  namespace: string;
  selection_version: string;
  source_identity: unknown;
  cohort_count: number;
  ordered_ids: string[];
  ordered_namespaces: string[];
  ordered_content_hashes: string[];
  cohort_digest: string;
  full_snapshot_sha256: string;
}

interface SourceIdentity {
  database: string;
  table: "public.candidate_memory";
  namespace: string;
  selection_version: typeof FROZEN_SELECTION_VERSION;
}

interface CohortRow {
  ordinal: number;
  candidate_id: string;
  namespace: string;
  content_hash: string;
  snapshot: unknown;
}

export interface FrozenCohort {
  schema: string;
  namespace: string;
  digest: string;
  fullSnapshotSha256: string;
  candidates: RemCandidate[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertNamespace(namespace: string): void {
  if (
    typeof namespace !== "string" ||
    namespace.length === 0 ||
    namespace.trim() !== namespace
  ) {
    throw new Error("freeze requires one explicit non-empty namespace");
  }
}

export function assertDreamRunSchema(schema: string): void {
  if (!SCHEMA_PATTERN.test(schema)) {
    throw new Error(`invalid dream run schema: ${schema}`);
  }
}

function toCandidate(row: CandidateRow): RemCandidate {
  return {
    id: row.id,
    namespace: row.namespace,
    candidate_type: row.candidate_type,
    content: row.content,
    content_hash: row.content_hash,
    uncertain: row.uncertain,
    uncertainty_reason: row.uncertainty_reason,
    model: row.model,
    session_count: Number(row.session_count ?? 0),
    occurrence_count: Number(row.occurrence_count ?? 0),
    reinforcement_count: Number(row.reinforcement_count),
  };
}

function canonicalSnapshot(candidate: RemCandidate): string {
  return JSON.stringify({
    id: candidate.id,
    namespace: candidate.namespace,
    candidate_type: candidate.candidate_type,
    content: candidate.content,
    content_hash: candidate.content_hash,
    uncertain: candidate.uncertain,
    uncertainty_reason: candidate.uncertainty_reason,
    model: candidate.model,
    session_count: candidate.session_count,
    occurrence_count: candidate.occurrence_count,
    reinforcement_count: candidate.reinforcement_count,
  });
}

function cohortDigest(candidates: readonly RemCandidate[]): string {
  return sha256(
    candidates
      .map((candidate, index) =>
        JSON.stringify([
          index + 1,
          candidate.id,
          candidate.namespace,
          candidate.content_hash,
        ]),
      )
      .join("\n"),
  );
}

function fullSnapshotSha256(candidates: readonly RemCandidate[]): string {
  return sha256(candidates.map(canonicalSnapshot).join("\n"));
}

function parseSourceIdentity(value: unknown, namespace: string): SourceIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid frozen source identity");
  }
  const source = value as Record<string, unknown>;
  if (
    typeof source.database !== "string" ||
    source.database.length === 0 ||
    source.table !== "public.candidate_memory" ||
    source.namespace !== namespace ||
    source.selection_version !== FROZEN_SELECTION_VERSION ||
    Object.keys(source).sort().join(",") !==
      "database,namespace,selection_version,table"
  ) {
    throw new Error("invalid frozen source identity");
  }
  return source as unknown as SourceIdentity;
}

function parseSnapshot(value: unknown, ordinal: number): RemCandidate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid snapshot at ordinal ${ordinal}`);
  }
  const candidate = value as Record<string, unknown>;
  assertSnapshotStrings(candidate, ordinal);
  if (typeof candidate.uncertain !== "boolean") {
    throw new Error(`invalid snapshot uncertain at ordinal ${ordinal}`);
  }
  assertNullableSnapshotString(candidate, "uncertainty_reason", ordinal);
  assertNullableSnapshotString(candidate, "model", ordinal);
  assertSnapshotCounts(candidate, ordinal);
  return candidate as unknown as RemCandidate;
}

function assertSnapshotStrings(
  candidate: Record<string, unknown>,
  ordinal: number,
): void {
  for (const key of ["id", "namespace", "candidate_type", "content", "content_hash"]) {
    if (typeof candidate[key] !== "string")
      throw new Error(`invalid snapshot ${key} at ordinal ${ordinal}`);
  }
}

function assertNullableSnapshotString(
  candidate: Record<string, unknown>,
  key: string,
  ordinal: number,
): void {
  const value = candidate[key];
  if (value !== null && typeof value !== "string")
    throw new Error(`invalid snapshot ${key} at ordinal ${ordinal}`);
}

function assertSnapshotCounts(
  candidate: Record<string, unknown>,
  ordinal: number,
): void {
  for (const key of ["session_count", "occurrence_count", "reinforcement_count"]) {
    if (!Number.isSafeInteger(candidate[key]) || (candidate[key] as number) < 0) {
      throw new Error(`invalid snapshot ${key} at ordinal ${ordinal}`);
    }
  }
}

async function createFrozenTables(client: PoolClient, schema: string): Promise<void> {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`CREATE TABLE ${schema}.manifest (
    run_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK (mode = 'frozen'), namespace TEXT NOT NULL,
    selection_version TEXT NOT NULL, source_identity JSONB NOT NULL, cohort_count INTEGER NOT NULL,
    ordered_ids UUID[] NOT NULL, ordered_namespaces TEXT[] NOT NULL,
    ordered_content_hashes TEXT[] NOT NULL, cohort_digest TEXT NOT NULL,
    full_snapshot_sha256 TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await client.query(`CREATE TABLE ${schema}.cohort (
    ordinal INTEGER PRIMARY KEY CHECK (ordinal BETWEEN 1 AND 50), candidate_id UUID NOT NULL UNIQUE,
    namespace TEXT NOT NULL, content_hash TEXT NOT NULL, snapshot JSONB NOT NULL)`);
}

/**
 * The one `dream_run_NNN` allocator. It holds a transaction-scoped advisory
 * lock, so the caller must create the schema before it commits.
 */
export async function nextSchema(client: PoolClient): Promise<string> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('rem-ethereal-run-schema'))",
  );
  const existing = await client.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
      WHERE nspname LIKE 'dream\\_run\\_%' ORDER BY nspname DESC LIMIT 1`,
  );
  const next = existing.rows[0] ? Number(existing.rows[0].nspname.slice(-3)) + 1 : 1;
  if (!Number.isSafeInteger(next) || next > 999) {
    throw new Error("no dream_run_NNN schema remains available");
  }
  return `dream_run_${String(next).padStart(3, "0")}`;
}

export async function freezeCohort(
  pool: Pool,
  namespace: string,
): Promise<FrozenCohort> {
  assertNamespace(namespace);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const schema = await nextSchema(client);
    const selected = await client.query<CandidateRow>(
      `SELECT c.id, c.namespace, c.candidate_type, c.content, c.content_hash,
              c.uncertain, c.uncertainty_reason, c.model,
              o.session_count, o.occurrence_count,
              (SELECT count(*) FROM public.candidate_reinforcement r
                WHERE r.candidate_id = c.id)::text AS reinforcement_count
         FROM public.candidate_memory c
         LEFT JOIN public.content_occurrences o
                ON o.namespace = c.namespace AND o.content_hash = c.content_hash
        WHERE c.namespace = $1
          AND c.unit_kind = 'exchange'
          AND c.reviewed_at IS NULL
          AND c.parent_id IS NULL
        ORDER BY md5(c.id::text), c.id
        LIMIT $2`,
      [namespace, FROZEN_COHORT_SIZE],
    );
    if (selected.rows.length !== FROZEN_COHORT_SIZE) {
      throw new Error(
        `freeze requires exactly 50 selected candidates; found ${selected.rows.length}`,
      );
    }
    const candidates = selected.rows.map(toCandidate);
    const digest = cohortDigest(candidates);
    const snapshotSha = fullSnapshotSha256(candidates);
    const source = await client.query<{ database: string }>(
      "SELECT current_database() AS database",
    );
    const sourceIdentity = {
      database: source.rows[0]?.database,
      table: "public.candidate_memory",
      namespace,
      selection_version: FROZEN_SELECTION_VERSION,
    };
    parseSourceIdentity(sourceIdentity, namespace);

    await createFrozenTables(client, schema);
    for (const [index, candidate] of candidates.entries()) {
      await client.query(
        `INSERT INTO ${schema}.cohort
           (ordinal, candidate_id, namespace, content_hash, snapshot)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [
          index + 1,
          candidate.id,
          candidate.namespace,
          candidate.content_hash,
          canonicalSnapshot(candidate),
        ],
      );
    }
    await client.query(
      `INSERT INTO ${schema}.manifest
         (run_id, mode, namespace, selection_version, source_identity,
          cohort_count, ordered_ids, ordered_namespaces, ordered_content_hashes,
          cohort_digest, full_snapshot_sha256)
       VALUES ($1,'frozen',$2,$3,$4::jsonb,$5,$6::uuid[],$7::text[],$8::text[],$9,$10)`,
      [
        schema,
        namespace,
        FROZEN_SELECTION_VERSION,
        JSON.stringify(sourceIdentity),
        candidates.length,
        candidates.map((candidate) => candidate.id),
        candidates.map((candidate) => candidate.namespace),
        candidates.map((candidate) => candidate.content_hash),
        digest,
        snapshotSha,
      ],
    );
    await client.query("COMMIT");
    return { schema, namespace, digest, fullSnapshotSha256: snapshotSha, candidates };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function loadFrozenCohort(
  pool: Pool | PoolClient,
  schema: string,
  expectedNamespace: string,
): Promise<FrozenCohort> {
  assertDreamRunSchema(schema);
  assertNamespace(expectedNamespace);
  const manifestResult = await pool.query<ManifestRow>(
    `SELECT run_id, namespace, selection_version, source_identity, cohort_count,
            ordered_ids, ordered_namespaces, ordered_content_hashes,
            cohort_digest, full_snapshot_sha256
       FROM ${schema}.manifest WHERE run_id = $1`,
    [schema],
  );
  if (manifestResult.rows.length !== 1)
    throw new Error("frozen manifest missing or duplicated");
  const manifest = manifestResult.rows[0];
  if (manifest === undefined) throw new Error("frozen manifest missing");
  validateFrozenManifest(manifest, expectedNamespace);
  const result = await pool.query<CohortRow>(
    `SELECT ordinal, candidate_id, namespace, content_hash, snapshot
       FROM ${schema}.cohort ORDER BY ordinal`,
  );
  const candidates = validateCohortRows(result.rows, manifest.cohort_count);
  const ids = candidates.map((candidate) => candidate.id);
  const namespaces = candidates.map((candidate) => candidate.namespace);
  const hashes = candidates.map((candidate) => candidate.content_hash);
  validateOrderedIdentity(manifest, ids, namespaces, hashes);
  const digest = cohortDigest(candidates);
  if (digest !== manifest.cohort_digest)
    throw new Error("frozen cohort digest mismatch");
  const snapshotSha = fullSnapshotSha256(candidates);
  if (snapshotSha !== manifest.full_snapshot_sha256) {
    throw new Error("frozen full snapshot digest mismatch");
  }
  return {
    schema,
    namespace: manifest.namespace,
    digest,
    fullSnapshotSha256: snapshotSha,
    candidates,
  };
}

function validateFrozenManifest(
  manifest: ManifestRow,
  expectedNamespace: string,
): void {
  if (manifest.selection_version !== FROZEN_SELECTION_VERSION) {
    throw new Error(
      `unsupported frozen selection version: ${manifest.selection_version}`,
    );
  }
  if (manifest.namespace !== expectedNamespace) {
    throw new Error(`frozen cohort namespace mismatch: expected ${expectedNamespace}`);
  }
  parseSourceIdentity(manifest.source_identity, manifest.namespace);
}

function validateCohortRows(rows: CohortRow[], manifestCount: number): RemCandidate[] {
  if (manifestCount !== FROZEN_COHORT_SIZE || rows.length !== FROZEN_COHORT_SIZE) {
    throw new Error("frozen cohort count must be exactly 50");
  }
  const candidates = rows.map((row, index) => validateCohortRow(row, index));
  if (
    new Set(candidates.map((candidate) => candidate.id)).size !== FROZEN_COHORT_SIZE
  ) {
    throw new Error("frozen cohort candidate ids are not unique");
  }
  return candidates;
}

function validateCohortRow(row: CohortRow, index: number): RemCandidate {
  if (row.ordinal !== index + 1)
    throw new Error("frozen cohort ordinals are not contiguous");
  const candidate = parseSnapshot(row.snapshot, row.ordinal);
  if (
    candidate.id !== row.candidate_id ||
    candidate.namespace !== row.namespace ||
    candidate.content_hash !== row.content_hash
  ) {
    throw new Error(`snapshot metadata mismatch at ordinal ${row.ordinal}`);
  }
  return candidate;
}

function validateOrderedIdentity(
  manifest: ManifestRow,
  ids: string[],
  namespaces: string[],
  hashes: string[],
): void {
  const mismatch =
    JSON.stringify(ids) !== JSON.stringify(manifest.ordered_ids) ||
    JSON.stringify(namespaces) !== JSON.stringify(manifest.ordered_namespaces) ||
    JSON.stringify(hashes) !== JSON.stringify(manifest.ordered_content_hashes);
  if (mismatch) throw new Error("frozen cohort ordered identity manifest mismatch");
  if (namespaces.some((namespace) => namespace !== manifest.namespace)) {
    throw new Error("frozen cohort contains a foreign namespace");
  }
}
