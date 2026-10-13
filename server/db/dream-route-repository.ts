/**
 * Public DREAM routing repository (issue 1525, plan item 4 of
 * `_plans/1469-dream-route.md`).
 *
 * Reads the candidates that carry no routing decision yet, and stores one
 * run's history in the public `routing_runs` and `routing_decisions` tables
 * created by migration 052. Public schema only: the disposable
 * `dream_run_NNN` schemas stay the business of the run store in `scripts/`.
 */
import type { PoolClient } from "pg";
import type { CandidateSnapshot } from "../domain/dream-route/types.ts";
import type { QuerySurface } from "./transaction.ts";

/** The fields the `routing_runs` INSERT binds. */
export interface RoutingRunRecord {
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

/** The fields one `routing_decisions` INSERT binds, besides the run id. */
export interface RoutingDecisionRecord {
  readonly candidateId: string;
  readonly namespace: string;
  readonly destination: string | null;
  readonly agreement: string;
  readonly authorityTier: string;
  readonly restates: boolean;
  readonly droveDecision: boolean;
  readonly reasons: readonly string[];
  readonly raw: Readonly<Record<string, number | string>>;
  readonly servedModel: string | null;
}

interface CandidateRow {
  id: string;
  namespace: string;
  candidate_type: string;
  content: string;
  content_hash: string;
  operator_text: string | null;
  unit_kind: string;
  anchor_kind: string | null;
  first_said_at: Date | null;
  last_said_at: Date | null;
  source_turn_ids: string[];
}

const UNROUTED_SQL = `SELECT id, namespace, candidate_type, content, content_hash,
       operator_text, unit_kind, anchor_kind, first_said_at, last_said_at,
       source_turn_ids
  FROM candidate_memory AS c
 WHERE c.parent_id IS NULL
   AND c.embedding IS NOT NULL
   AND ($1::text IS NULL OR c.namespace = $1)
   AND NOT EXISTS (SELECT 1 FROM routing_decisions AS d WHERE d.candidate_id = c.id)
 ORDER BY c.created_at, c.id
 LIMIT $2`;

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * The oldest embedded, top-level candidates with no routing decision yet.
 *
 * @param input - The query surface, a namespace (`null` for all), and the
 *   maximum number of rows to return (a positive integer).
 */
export async function readUnroutedSlice(input: {
  db: QuerySurface;
  namespace: string | null;
  sliceSize: number;
}): Promise<CandidateSnapshot[]> {
  const { db, namespace, sliceSize } = input;
  if (!Number.isInteger(sliceSize) || sliceSize <= 0) {
    throw new Error(`sliceSize must be a positive integer, got ${String(sliceSize)}`);
  }
  const result = await db.query<CandidateRow>(UNROUTED_SQL, [namespace, sliceSize]);
  return result.rows.map((row) => ({
    ...row,
    first_said_at: iso(row.first_said_at),
    last_said_at: iso(row.last_said_at),
  }));
}

/**
 * Writes one run's header and decisions on the caller's client. It does not
 * begin or commit: the caller owns the transaction.
 *
 * @param input - The client, the run id, the header, and the decisions.
 */
export async function writeRoutingRun(input: {
  client: PoolClient;
  runId: string;
  run: RoutingRunRecord;
  decisions: readonly RoutingDecisionRecord[];
}): Promise<void> {
  const { client, runId, run, decisions } = input;
  await client.query(
    `INSERT INTO routing_runs
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
  for (const decision of decisions) {
    await client.query(
      `INSERT INTO routing_decisions
         (run_id, candidate_id, namespace, destination, agreement,
          authority_tier, restates, drove_decision, reasons, raw, served_model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
      [
        runId,
        decision.candidateId,
        decision.namespace,
        decision.destination,
        decision.agreement,
        decision.authorityTier,
        decision.restates,
        decision.droveDecision,
        JSON.stringify(decision.reasons),
        JSON.stringify(decision.raw),
        decision.servedModel,
      ],
    );
  }
}

/**
 * Keeps only the candidates that still carry no routing decision, under a
 * transaction-scoped advisory lock (released at COMMIT or ROLLBACK).
 *
 * Why: the slice is read outside any transaction and the classifier runs
 * before the write, while the queue runs more than one job at once and
 * `routing_decisions` is unique only per `(run_id, candidate_id)`. Two
 * overlapping `dream.route` jobs would otherwise both apply the same
 * candidate. The lock serialises the check-then-write, so this MUST be the
 * first statement inside the write transaction, before any insert.
 *
 * @param input - The transaction's client and the candidate ids to claim.
 * @returns The input ids that have no decision yet.
 */
export async function claimUnrouted(input: {
  client: PoolClient;
  candidateIds: readonly string[];
}): Promise<Set<string>> {
  const { client, candidateIds } = input;
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('openbrain:dream.route'))`);
  const result = await client.query<{ candidate_id: string }>(
    `SELECT DISTINCT candidate_id FROM routing_decisions WHERE candidate_id = ANY($1::uuid[])`,
    [candidateIds],
  );
  const routed = new Set(result.rows.map((row) => row.candidate_id));
  return new Set(candidateIds.filter((id) => !routed.has(id)));
}
