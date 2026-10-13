/**
 * Semantic near-dupe merge for candidates. Issue #398. RUNS IN REM. A merge
 * deletes the duplicate row, writes candidate_reinforcement (038), advances
 * last_said_at and never first_said_at, and leaves confidence untouched.
 *
 * See docs/decisions/candidate-dedupe-merge-is-reversible-not-suppression.md
 */

import type pg from "pg";
import {
  VECTOR_SEARCH_EF_SEARCH,
  VECTOR_SEARCH_ITERATIVE_SCAN,
} from "../db/vector-search.ts";
/**
 * The subset of the maintenance queue logger this module calls; declared here
 * so the domain tier does not import maintenance. The runner's
 * MaintenanceQueueLogger satisfies it structurally.
 */
export interface CandidateDedupeLogger {
  info(message: string, fields: Record<string, string | number>): void;
  warn(message: string, fields: Record<string, string | number>): void;
  error(message: string, fields: Record<string, string | number>): void;
}

/**
 * Cosine DISTANCE at or below which two candidates are the same claim. Do NOT
 * raise it, and do NOT reuse the tiering module's DEFAULT_DUP_THRESHOLD (0.08,
 * a different question against a different corpus).
 *
 * See docs/decisions/candidate-dedupe-threshold-is-settled-not-fitted.md
 */
export const CANDIDATE_DUP_DISTANCE = 0.09;

/** Candidates examined per dedupe pass. Bounded, like every other sweep here. */
export const DEFAULT_DEDUPE_BATCH = 200;

export interface CandidateDedupeSummary {
  /** Candidates examined as potential duplicates. */
  examined: number;
  /** Duplicates absorbed into a survivor. */
  merged: number;
  /** Reinforcement rows written (merged minus any that hit the dedupe index). */
  reinforced: number;
  /** Candidates with no embedding, so unmergeable by similarity. Reported, not hidden. */
  skipped_no_embedding: number;
}

export interface CandidateDedupeDeps {
  pool: pg.Pool;
  logger: CandidateDedupeLogger;
  namespace?: string;
  batchSize?: number;
  /** Cosine distance cutoff. Defaults to {@link CANDIDATE_DUP_DISTANCE}. */
  distance?: number;
}

interface MergeRow {
  dup_id: string;
  survivor_id: string;
  namespace: string;
  dup_content_hash: string;
  dup_occurred_at: Date | null;
  dup_source_turn_ids: string[];
  dup_model: string | null;
  distance: number;
}

/**
 * The pairing query. Exported so a live-Postgres test can EXPLAIN it and prove
 * the nearest-survivor lookup is served by
 * candidate_memory_embedding_unreviewed_hnsw (migration 051, issue 1488).
 *
 * Pair each candidate with its single nearest neighbour inside the threshold,
 * restricted to a strictly OLDER survivor. The `<` on (said_at, id) is a
 * strict total order, so it enforces oldest-wins AND makes the relation
 * antisymmetric: A and B can never absorb each other.
 *
 * The nearest survivor is found by an ordered index lookup (LATERAL ... ORDER
 * BY distance LIMIT 1): a candidate has one claim, so it reinforces one
 * survivor, not every neighbour it happens to be near. Two consequences of the
 * index: ties in distance are no longer broken by survivor id (an index order
 * cannot carry a second key), and HNSW is approximate, so a rare
 * near-duplicate can be missed in one pass and caught in a later one. Scanning
 * every unreviewed candidate instead (~295k on dogfood) is what REM must not
 * do to the database.
 *
 * THE CHAIN CASE, and why the survivor is resolved to the OLDEST member of its
 * cluster rather than to its nearest neighbour. Antisymmetry alone does not
 * prevent A <- B <- C: B can be both a duplicate (of A) and the nearest
 * survivor (for C). Merging that naively deletes B while C's reinforcement row
 * points at it -- the row then CASCADEs away with B (038) and C's restatement
 * is silently lost, which is exactly the data loss the reversibility guarantee
 * promises cannot happen.
 *
 * The recursive term walks each pair's survivor edge to its terminal node.
 * Because every edge strictly decreases (said_at, id), the walk is finite and
 * lands on a candidate that is nobody's duplicate -- so the survivor of a
 * chain is its oldest member, every reinforcement in the cluster points there,
 * and nothing that gets deleted is ever a reinforcement target.
 */
export const CANDIDATE_MERGE_PAIRS_SQL = `WITH RECURSIVE scoped AS (
       SELECT id, namespace, content_hash, embedding, model,
              COALESCE(first_said_at, created_at) AS said_at,
              COALESCE(last_said_at, first_said_at, created_at) AS last_at,
              source_turn_ids
         FROM candidate_memory
        WHERE reviewed_at IS NULL
          AND embedding IS NOT NULL
          AND ($1::text IS NULL OR namespace = $1)
     ),
     dups AS (
       SELECT id, namespace, content_hash, embedding, model, said_at,
              last_at, source_turn_ids
         FROM scoped
        ORDER BY said_at DESC, id DESC
        LIMIT $2
     ),
     nearest AS (
       SELECT d.id                 AS dup_id,
              s.id                 AS survivor_id,
              d.namespace          AS namespace,
              d.content_hash       AS dup_content_hash,
              d.last_at            AS dup_occurred_at,
              d.source_turn_ids    AS dup_source_turn_ids,
              d.model              AS dup_model,
              s.distance
         FROM dups d
         CROSS JOIN LATERAL (
           SELECT c.id, (c.embedding <=> d.embedding)::float8 AS distance
             FROM candidate_memory c
            WHERE c.reviewed_at IS NULL
              AND c.embedding IS NOT NULL
              AND c.namespace = d.namespace
              AND (COALESCE(c.first_said_at, c.created_at), c.id) < (d.said_at, d.id)
            ORDER BY c.embedding <=> d.embedding
            LIMIT 1
         ) s
        WHERE s.distance <= $3
     ),
     -- Walk each survivor edge to the terminal (oldest) node. The steps
     -- counter bounds the recursion explicitly rather than relying on the
     -- strictly-decreasing edge alone: a bound visible in the query is a
     -- bound that survives someone later changing the ordering expression.
     walk AS (
       SELECT dup_id, survivor_id AS terminal, 0 AS steps
         FROM nearest
       UNION ALL
       SELECT w.dup_id, n.survivor_id, w.steps + 1
         FROM walk w
         JOIN nearest n ON n.dup_id = w.terminal
        WHERE w.steps < 32
     ),
     -- The terminal is the deepest node reached: the one that is nobody's
     -- duplicate, i.e. the oldest member of the cluster.
     terminal AS (
       SELECT DISTINCT ON (dup_id) dup_id, terminal
         FROM walk
        ORDER BY dup_id, steps DESC
     )
     SELECT n.dup_id, n.namespace, n.dup_content_hash, n.dup_occurred_at,
            n.dup_source_turn_ids, n.dup_model, n.distance,
            t.terminal AS survivor_id
       FROM nearest n
       JOIN terminal t ON t.dup_id = n.dup_id
      WHERE t.terminal <> n.dup_id`;

/**
 * Select each unreviewed duplicate paired with the oldest survivor of its
 * cluster. The filtered-HNSW settings are transaction-local, so the caller
 * must already be inside the transaction that runs this query.
 */
async function selectMergePairs(
  client: pg.PoolClient,
  deps: CandidateDedupeDeps,
  batchSize: number,
  distance: number,
): Promise<MergeRow[]> {
  await client.query("SELECT set_config('hnsw.ef_search', $1, true)", [
    VECTOR_SEARCH_EF_SEARCH,
  ]);
  await client.query("SELECT set_config('hnsw.iterative_scan', $1, true)", [
    VECTOR_SEARCH_ITERATIVE_SCAN,
  ]);
  const pairs = await client.query<MergeRow>(CANDIDATE_MERGE_PAIRS_SQL, [
    deps.namespace ?? null,
    batchSize,
    distance,
  ]);
  return pairs.rows;
}

/**
 * Lock the duplicate and survivor rows in id order.
 */
async function lockPairRows(
  client: pg.PoolClient,
  rows: readonly MergeRow[],
): Promise<void> {
  // on a query carrying DISTINCT ("FOR UPDATE is not allowed with DISTINCT
  // clause", SQLSTATE 0A000, observed on the real clone 2026-07-28), and
  // DISTINCT ON is what picks each duplicate's single nearest survivor -- so
  // the two cannot share a statement.
  //
  // Both the duplicates and the survivors are locked, in one ORDER BY id
  // statement. Ordering matters: two concurrent passes taking the same rows
  // in id order block rather than deadlock. Locking the SURVIVORS too is what
  // prevents the lost-update on last_said_at, and prevents a concurrent pass
  // from deleting a row this pass is about to reinforce into.
  if (rows.length > 0) {
    const lockIds = [...new Set(rows.flatMap((p) => [p.dup_id, p.survivor_id]))].sort();
    await client.query(
      `SELECT id FROM candidate_memory
      WHERE id = ANY($1::uuid[])
      ORDER BY id
        FOR UPDATE`,
      [lockIds],
    );
  }
}

async function applyMerge(
  client: pg.PoolClient,
  pair: MergeRow,
  summary: CandidateDedupeSummary,
): Promise<void> {
  // ON CONFLICT DO NOTHING against idx_candidate_reinforcement_dedupe
  // (038) is the idempotency guard, not application logic: replaying a
  // batch after a retry must not inflate reinforcement.
  const written = await client.query(
    `INSERT INTO candidate_reinforcement (
       namespace, candidate_id, dup_content_hash, dup_occurred_at,
       dup_source_turn_ids, similarity, model
     ) VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7)
     ON CONFLICT (candidate_id, dup_content_hash) DO NOTHING
     RETURNING id`,
    [
      pair.namespace,
      pair.survivor_id,
      pair.dup_content_hash,
      pair.dup_occurred_at,
      pair.dup_source_turn_ids,
      pair.distance,
      pair.dup_model,
    ],
  );
  if (written.rowCount && written.rowCount > 0) summary.reinforced++;

  // last_said_at advances, first_said_at does not. GREATEST rather than a
  // bare assignment because merges arrive in no particular order and an
  // older duplicate must not drag the survivor's recency backwards.
  await client.query(
    `UPDATE candidate_memory
        SET last_said_at = GREATEST(
              COALESCE(last_said_at, first_said_at, created_at),
              COALESCE($2::timestamptz, last_said_at, created_at))
      WHERE id = $1`,
    [pair.survivor_id, pair.dup_occurred_at],
  );

  // The duplicate row goes. Its claim survives in the survivor and its
  // provenance survives in candidate_reinforcement, so nothing is lost and
  // the merge can be undone. Guarded on reviewed_at IS NULL a second time
  // at the point of deletion: the SELECT above and this DELETE are in the
  // same transaction, but restating the invariant where the destructive
  // act happens is cheap and makes the guard impossible to lose in a later
  // refactor.
  const removed = await client.query(
    `DELETE FROM candidate_memory WHERE id = $1 AND reviewed_at IS NULL`,
    [pair.dup_id],
  );
  if (removed.rowCount && removed.rowCount > 0) summary.merged++;
}

/**
 * Run one bounded near-dupe merge pass.
 *
 * Pairing is done in SQL because the comparison is a vector operation the
 * database already indexes; pulling 1,104 embeddings into the process to
 * compare them in TypeScript would be slower and would still have to write the
 * result back through the same connection.
 *
 * ONLY UNREVIEWED CANDIDATES ARE TOUCHED. A candidate the operator has already
 * graded is ground truth; absorbing it into another row would rewrite the
 * training data the whole grading exercise exists to produce.
 */
export async function runCandidateDedupe(
  deps: CandidateDedupeDeps,
): Promise<CandidateDedupeSummary> {
  const batchSize = deps.batchSize ?? DEFAULT_DEDUPE_BATCH;
  const distance = deps.distance ?? CANDIDATE_DUP_DISTANCE;
  const summary: CandidateDedupeSummary = {
    examined: 0,
    merged: 0,
    reinforced: 0,
    skipped_no_embedding: 0,
  };

  const missing = await deps.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM candidate_memory
      WHERE reviewed_at IS NULL
        AND embedding IS NULL
        AND ($1::text IS NULL OR namespace = $1)`,
    [deps.namespace ?? null],
  );
  summary.skipped_no_embedding = Number(missing.rows[0]?.n ?? 0);

  const client = await deps.pool.connect();
  try {
    // One transaction: the HNSW settings are transaction-local, and the row
    // locks taken below only hold inside one.
    await client.query("BEGIN");
    const pairs = await selectMergePairs(client, deps, batchSize, distance);
    summary.examined = pairs.length;
    await lockPairRows(client, pairs);
    for (const pair of pairs) {
      await applyMerge(client, pair, summary);
    }

    await client.query("COMMIT");
  } catch (err) {
    // A ROLLBACK that itself fails is a DIFFERENT condition from the query
    // failure below, and it was the one nobody could see. `candidate_dedupe_failed`
    // names the original error, so an operator reading it reasonably assumes the
    // transaction was unwound; if the rollback also failed, the connection goes
    // back to the pool still inside an aborted transaction and the next borrower
    // fails for a reason that has nothing to do with its own work. Named here so
    // the two are distinguishable in the log. The error class only, matching the
    // sibling clause: a rollback error can quote row content.
    await client.query("ROLLBACK").catch((rollbackError: unknown) => {
      deps.logger.warn("candidate_dedupe_rollback_failed", {
        examined: summary.examined,
        reason: rollbackError instanceof Error ? rollbackError.name : "non_error",
      });
    });
    deps.logger.error("candidate_dedupe_failed", {
      examined: summary.examined,
      reason: err instanceof Error ? err.name : "non_error",
    });
    throw err;
  } finally {
    client.release();
  }

  deps.logger.info("candidate_dedupe_complete", {
    examined: summary.examined,
    merged: summary.merged,
    reinforced: summary.reinforced,
    skipped_no_embedding: summary.skipped_no_embedding,
    distance,
  });

  return summary;
}

export interface ReinforcementReceipt {
  /** How many restatements were absorbed. Computed live, never cached. */
  count: number;
  /** Earliest absorbed restatement. */
  first_at: string | null;
  /** Latest absorbed restatement. */
  last_at: string | null;
}

/**
 * Read the reinforcement receipt for a set of candidates.
 *
 * "Receipts on recall", the standing want borrowed from gbrain
 * (docs/dream-design.md:709-712): a weight becomes "0.3 baseline, reinforced
 * three times across sessions on Jun 12, Jul 3, Jul 19" instead of an
 * unexplained number.
 *
 * COMPUTED EVERY TIME, BY CONTRACT. dream-design.md:686 -- "Reinforcement count
 * must never be denormalized onto the candidate row or cached." The covering
 * index idx_candidate_reinforcement_candidate (038) makes count, first, and
 * last one index-only scan, which is what makes recomputation cheaper than the
 * staleness bug caching would introduce.
 */
export async function readReinforcement(
  pool: pg.Pool,
  candidateIds: readonly string[],
): Promise<Map<string, ReinforcementReceipt>> {
  const out = new Map<string, ReinforcementReceipt>();
  if (candidateIds.length === 0) return out;

  const rows = await pool.query<{
    candidate_id: string;
    n: string;
    first_at: Date;
    last_at: Date;
  }>(
    `SELECT candidate_id,
            count(*)::text        AS n,
            min(dup_occurred_at)  AS first_at,
            max(dup_occurred_at)  AS last_at
       FROM candidate_reinforcement
      WHERE candidate_id = ANY($1::uuid[])
      GROUP BY candidate_id`,
    [candidateIds],
  );

  for (const row of rows.rows) {
    out.set(row.candidate_id, {
      count: Number(row.n),
      first_at: row.first_at ? row.first_at.toISOString() : null,
      last_at: row.last_at ? row.last_at.toISOString() : null,
    });
  }
  return out;
}
