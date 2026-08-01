/**
 * Semantic near-dupe merge for candidates. Issue #398. RUNS IN REM.
 *
 * Exact dedupe already exists: the unique index on (namespace, content_hash)
 * (033_candidate_memory.sql:117-118) collapses identical strings. It catches
 * nothing else. Measured over the 2026-07-24 20-batch run: 307 emitted, 214
 * stored -- 93 caught, ~30% exact overlap -- while paraphrases passed straight
 * through (docs/dream-design.md:542-557):
 *
 *     "the delta is 5 rows"
 *     "the real local-only delta is 5 rows, not 128"
 *
 * Same fact, different hash, both stored. Fifty rows for one fact, none of them
 * looking well-established, defeats the corroboration mechanism #394 and #396
 * depend on.
 *
 * WHAT A MERGE DOES, and what it deliberately does not do
 * (docs/dream-design.md:605-618):
 *
 *   - the duplicate row is DELETED and one row is written to
 *     candidate_reinforcement (038). Counting those rows IS the reinforcement.
 *   - the survivor's confidence is UNCHANGED. Nothing is added to anything --
 *     confidence answers "is this true", reinforcement answers "how well
 *     established", and one number cannot hold both (dream-design.md:559-578).
 *   - the survivor's last_said_at advances to the duplicate's occurred_at.
 *   - the survivor's first_said_at NEVER moves. The span is the evidence.
 *   - source_refs is NOT appended -- refs go to the history table, so a hot
 *     item's row does not grow without bound.
 *
 * IS DELETING THE DUPLICATE ROW A SUPPRESSION? No, and the distinction matters
 * under the 2026-07-28 "everything passes" decision. Suppression is content
 * never entering, or a claim being withheld from the operator's queue. A merge
 * withholds nothing: the surviving candidate carries the same claim, it stays
 * on the queue, and the merge is UNDOABLE -- candidate_reinforcement keeps the
 * duplicate's hash, its turns, and its time, which is everything needed to
 * re-extract it (dream-design.md:706-708). Reversibility is precisely what
 * licenses doing this autonomously when almost nothing else in DREAM is.
 *
 * SURVIVOR CHOICE IS OLDEST-WINS, and it is not arbitrary. The oldest candidate
 * is the one whose first_said_at is genuinely earliest, so keeping it preserves
 * the longest span. Keeping the newest would silently reset first_said_at on
 * every merge and destroy the exact signal #396 reads.
 *
 * THRESHOLD: 0.09 cosine DISTANCE. Settled, not a fitting problem
 * (dream-design.md:631-649). Do NOT reuse DEFAULT_DUP_THRESHOLD from
 * src/tiering.ts:33 -- that is 0.08, tuned for lane-event-to-durable
 * comparison, a different question against a different corpus. The doc is
 * explicit that the candidate-to-candidate path needs its own value and the
 * existing constant must not be changed.
 */

import type pg from "pg";
import type { MaintenanceQueueLogger } from "./maintenance-queue.ts";

/**
 * Cosine DISTANCE at or below which two candidates are the same claim.
 * 0.09 distance = 0.91 similarity, the operator's standing threshold for "is
 * this close enough to be the same thing" (docs/dream-design.md:631-649). It
 * is worth keeping because two independent lines of work landed on ~0.91 for
 * the same judgement, not because of where it was first observed.
 *
 * Risk direction, stated in the doc and preserved here: too loose merges
 * genuinely distinct facts, too tight leaves dupes. The history table makes the
 * loose case recoverable, but slightly too tight remains the safer default.
 *
 * MEASURED ON THIS CORPUS, 2026-07-28: it fires ZERO times. Over a 400-candidate
 * sample of the 1,104 real candidates (all embedded), the CLOSEST pair in the
 * whole sample is 0.1240 distance. At the settled 0.09 cutoff there are 0
 * pairs; at 0.20 there are 7; at 0.30 there are 29.
 *
 * That is a finding about the corpus, NOT a reason to loosen the threshold. It
 * is the same property Light measured from the other direction (one
 * cross-session repeat in 3,558 turns): the operator states a thing once, in
 * its own words, and does not restate it. The near-dupe problem #398 was
 * written against -- "fifty rows for one fact" across a 12,946-file backfill --
 * is a backfill-scale phenomenon that this 3-day capture has not reached.
 *
 * DO NOT RAISE THIS VALUE TO MAKE THE STAGE "DO SOMETHING". The doc calls 0.09
 * settled, not a fitting problem (dream-design.md:645-649), and loosening it to
 * 0.20 to capture 7 pairs would be tuning a merge threshold on the desire to
 * see output rather than on graded evidence -- exactly the error the 2026-07-28
 * governing decision exists to prevent. A merge that fires zero times suppresses
 * nothing, which is the correct behaviour when there is nothing to merge.
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
  logger: MaintenanceQueueLogger;
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
    await client.query("BEGIN");

    // Pair each candidate with its single nearest neighbour inside the
    // threshold, restricted to a strictly OLDER survivor. The `<` on
    // (said_at, id) is a strict total order, so it enforces oldest-wins AND
    // makes the relation antisymmetric: A and B can never absorb each other.
    //
    // DISTINCT ON keeps only the closest match per duplicate: a candidate has
    // one claim, so it reinforces one survivor, not every neighbour it happens
    // to be near.
    //
    // THE CHAIN CASE, and why the survivor is resolved to the OLDEST member of
    // its cluster rather than to its nearest neighbour. Antisymmetry alone does
    // not prevent A <- B <- C: B can be both a duplicate (of A) and the nearest
    // survivor (for C). Merging that naively deletes B while C's reinforcement
    // row points at it -- the row then CASCADEs away with B (038) and C's
    // restatement is silently lost, which is exactly the data loss the
    // reversibility guarantee promises cannot happen.
    //
    // The recursive term walks each pair's survivor edge to its terminal node.
    // Because every edge strictly decreases (said_at, id), the walk is finite
    // and lands on a candidate that is nobody's duplicate -- so the survivor of
    // a chain is its oldest member, every reinforcement in the cluster points
    // there, and nothing that gets deleted is ever a reinforcement target.
    const pairs = await client.query<MergeRow>(
      `WITH RECURSIVE scoped AS (
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
         SELECT DISTINCT ON (d.id)
                d.id                 AS dup_id,
                s.id                 AS survivor_id,
                d.namespace          AS namespace,
                d.content_hash       AS dup_content_hash,
                d.last_at            AS dup_occurred_at,
                d.source_turn_ids    AS dup_source_turn_ids,
                d.model              AS dup_model,
                (d.embedding <=> s.embedding)::float8 AS distance
           FROM dups d
           JOIN scoped s
             ON s.namespace = d.namespace
            AND (s.said_at, s.id) < (d.said_at, d.id)
            AND (d.embedding <=> s.embedding) <= $3
          ORDER BY d.id, (d.embedding <=> s.embedding) ASC, s.id ASC
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
        WHERE t.terminal <> n.dup_id`,
      [deps.namespace ?? null, batchSize, distance],
    );

    summary.examined = pairs.rows.length;

    // Lock the pair rows as a SEPARATE statement. Postgres rejects FOR UPDATE
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
    if (pairs.rows.length > 0) {
      const lockIds = [
        ...new Set(pairs.rows.flatMap((p) => [p.dup_id, p.survivor_id])),
      ].sort();
      await client.query(
        `SELECT id FROM candidate_memory
          WHERE id = ANY($1::uuid[])
          ORDER BY id
            FOR UPDATE`,
        [lockIds],
      );
    }

    for (const pair of pairs.rows) {
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

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
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
