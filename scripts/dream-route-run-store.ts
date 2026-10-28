/**
 * The SQL half of a DREAM route run: the three append-only result tables that
 * live INSIDE the run's own `dream_run_NNN` schema.
 *
 * Nothing here touches `public`. The schema name is the one thing that cannot
 * be a bind parameter, so every entry point runs it through
 * `assertDreamRunSchema` before it reaches a query string; every other value is
 * parameterized.
 *
 * Append-only is the contract: `createResultTables` is `IF NOT EXISTS`, a write
 * only ever INSERTs, and a rerun adds a new `run_id` rather than touching an
 * earlier one. That is what lets an earlier run's rows be compared byte for
 * byte after a later run.
 */

import type { Pool, PoolClient } from "pg";
import { assertDreamRunSchema } from "./rem-ethereal-cohort.ts";
import type { CandidateSnapshot, FrozenRow } from "./dream-route-selection.ts";
import type { RouteDecision } from "../server/domain/dream-route/types.ts";
import type { ResolvedWouldApply } from "../server/domain/dream-route/run-core.ts";

/** The manifest row a cohort was frozen with. */
export interface CohortManifest {
  readonly runId: string;
  readonly namespace: string;
  readonly selectionVersion: string;
  readonly cohortCount: number;
  readonly cohortDigest: string;
}

/** The header row of one route run. */
export interface RoutingRunRow {
  readonly matrixFingerprint: string;
  readonly classifierVersion: string;
  readonly thresholds: unknown;
  readonly backend: string;
  readonly servedModels: readonly string[];
  readonly records: number;
  readonly requests: number;
  readonly inputTokens: number;
  readonly estimatedUsd: number;
  readonly actualUsd: number;
  readonly ms: number;
  readonly note: string;
}

/** One row's decision plus the verdict that was resolved for it. */
export interface RoutedResult {
  readonly candidateId: string;
  readonly namespace: string;
  readonly decision: RouteDecision;
  readonly resolved: ResolvedWouldApply;
  readonly servedModel: string | null;
}

interface CohortRowShape {
  ordinal: number;
  candidate_id: string;
  namespace: string;
  content_hash: string;
  source: FrozenRow["source"];
  neighbour_of: string | null;
  snapshot: CandidateSnapshot;
}

/**
 * Reads the frozen manifest of a cohort schema.
 *
 * @param pool - The pool for the run's database.
 * @param schema - A `dream_run_NNN` schema name.
 * @returns The manifest row.
 * @throws {Error} When the schema is not a dream-run name or holds no manifest.
 */
export async function readManifest(
  pool: Pool,
  schema: string,
): Promise<CohortManifest> {
  assertDreamRunSchema(schema);
  const result = await pool.query<{
    run_id: string;
    namespace: string;
    selection_version: string;
    cohort_count: number;
    cohort_digest: string;
  }>(
    `SELECT run_id, namespace, selection_version, cohort_count, cohort_digest
       FROM ${schema}.manifest ORDER BY created_at LIMIT 1`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`${schema}.manifest holds no row`);
  return {
    runId: row.run_id,
    namespace: row.namespace,
    selectionVersion: row.selection_version,
    cohortCount: row.cohort_count,
    cohortDigest: row.cohort_digest,
  };
}

/**
 * Reads a cohort's frozen rows, in ordinal order.
 *
 * @param pool - The pool for the run's database.
 * @param schema - A `dream_run_NNN` schema name.
 * @returns The rows, in ordinal order; empty when the cohort is empty.
 */
export async function readCohortRows(pool: Pool, schema: string): Promise<FrozenRow[]> {
  assertDreamRunSchema(schema);
  const result = await pool.query<CohortRowShape>(
    `SELECT ordinal, candidate_id, namespace, content_hash, source, neighbour_of,
            snapshot
       FROM ${schema}.cohort ORDER BY ordinal`,
  );
  return result.rows.map((row) => ({
    ordinal: row.ordinal,
    candidateId: row.candidate_id,
    namespace: row.namespace,
    contentHash: row.content_hash,
    source: row.source,
    neighbourOf: row.neighbour_of,
    snapshot: row.snapshot,
  }));
}

/**
 * Creates the three result tables, if they are not already there.
 *
 * Idempotent by construction, so a rerun into the same schema neither fails nor
 * rewrites anything already stored.
 *
 * @param client - A client inside the write transaction.
 * @param schema - A `dream_run_NNN` schema name, already asserted by the caller.
 */
async function createResultTables(client: PoolClient, schema: string): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.routing_runs (
    run_id UUID PRIMARY KEY,
    matrix_fingerprint TEXT NOT NULL,
    classifier_version TEXT NOT NULL,
    thresholds JSONB NOT NULL,
    backend TEXT NOT NULL,
    served_models TEXT[] NOT NULL,
    records INTEGER NOT NULL,
    requests INTEGER NOT NULL,
    input_tokens BIGINT NOT NULL,
    estimated_usd NUMERIC NOT NULL,
    actual_usd NUMERIC NOT NULL,
    ms INTEGER NOT NULL,
    note TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.routing_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES ${schema}.routing_runs (run_id),
    candidate_id UUID NOT NULL,
    namespace TEXT NOT NULL,
    destination TEXT,
    agreement TEXT NOT NULL,
    authority_tier TEXT NOT NULL,
    restates BOOLEAN NOT NULL,
    drove_decision BOOLEAN NOT NULL,
    reasons JSONB NOT NULL,
    raw JSONB NOT NULL,
    served_model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, candidate_id))`);
  await client.query(
    `CREATE INDEX IF NOT EXISTS routing_decisions_candidate_idx
       ON ${schema}.routing_decisions (candidate_id)`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS routing_decisions_run_idx
       ON ${schema}.routing_decisions (run_id)`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS routing_decisions_destination_agreement_idx
       ON ${schema}.routing_decisions (destination, agreement)`,
  );
  await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.would_apply (
    run_id UUID NOT NULL,
    candidate_id UUID NOT NULL,
    action TEXT NOT NULL,
    reinforces UUID,
    reason TEXT NOT NULL,
    PRIMARY KEY (run_id, candidate_id))`);
  await client.query(
    `CREATE INDEX IF NOT EXISTS would_apply_action_idx
       ON ${schema}.would_apply (action)`,
  );
}

/**
 * The run this schema already holds for the same matrix and backend, if any.
 *
 * The idempotence guard: routing the same cohort against the same wording with
 * the same backend twice is almost always a mistake, so it is refused unless
 * the operator asks for a rerun by name.
 *
 * @param pool - The pool for the run's database.
 * @param schema - A `dream_run_NNN` schema name.
 * @param matrixFingerprint - The fingerprint of the matrix about to be used.
 * @param backend - `fake` or `jev`.
 * @returns The earlier `run_id`, or null when there is none (or no table yet).
 */
export async function existingRunId(
  pool: Pool,
  schema: string,
  matrixFingerprint: string,
  backend: string,
): Promise<string | null> {
  assertDreamRunSchema(schema);
  const present = await pool.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`${schema}.routing_runs`],
  );
  if (present.rows[0]?.present !== true) return null;
  const result = await pool.query<{ run_id: string }>(
    `SELECT run_id FROM ${schema}.routing_runs
      WHERE matrix_fingerprint = $1 AND backend = $2
      ORDER BY created_at LIMIT 1`,
    [matrixFingerprint, backend],
  );
  return result.rows[0]?.run_id ?? null;
}

/**
 * Writes one run's header, decisions, and verdicts, in ONE transaction.
 *
 * Nothing is updated or deleted: a failure anywhere rolls the whole run back,
 * and a success only ever adds rows.
 *
 * @param pool - The pool for the run's database.
 * @param write - The schema, the run id, the header row, and the results.
 */
export async function writeRun(
  pool: Pool,
  write: {
    readonly schema: string;
    readonly runId: string;
    readonly run: RoutingRunRow;
    readonly results: readonly RoutedResult[];
  },
): Promise<void> {
  const { schema, runId, run, results } = write;
  assertDreamRunSchema(schema);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await createResultTables(client, schema);
    await client.query(
      `INSERT INTO ${schema}.routing_runs
         (run_id, matrix_fingerprint, classifier_version, thresholds, backend,
          served_models, records, requests, input_tokens, estimated_usd,
          actual_usd, ms, note)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6::text[],$7,$8,$9,$10,$11,$12,$13)`,
      [
        runId,
        run.matrixFingerprint,
        run.classifierVersion,
        JSON.stringify(run.thresholds),
        run.backend,
        run.servedModels,
        run.records,
        run.requests,
        run.inputTokens,
        run.estimatedUsd,
        run.actualUsd,
        run.ms,
        run.note,
      ],
    );
    for (const result of results) {
      await client.query(
        `INSERT INTO ${schema}.routing_decisions
           (run_id, candidate_id, namespace, destination, agreement,
            authority_tier, restates, drove_decision, reasons, raw, served_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
        [
          runId,
          result.candidateId,
          result.namespace,
          result.decision.destination,
          result.decision.agreement,
          result.decision.authorityTier,
          result.decision.restates,
          result.decision.droveDecision,
          JSON.stringify(result.decision.reasons),
          JSON.stringify(result.decision.raw),
          result.servedModel,
        ],
      );
      await client.query(
        `INSERT INTO ${schema}.would_apply
           (run_id, candidate_id, action, reinforces, reason)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          runId,
          result.candidateId,
          result.resolved.action,
          result.resolved.reinforces,
          result.resolved.reason,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
