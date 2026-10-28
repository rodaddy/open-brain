/**
 * Owns the one statement the maintenance sweep used to execute from the
 * maintenance tier: the due distill-lane batch SELECT.
 *
 * It exists so the maintenance tier holds no SQL text: server/maintenance/
 * maintenance-sweep.ts takes this port instead of running the statement on its
 * own Pool (issue 1209). Design authority: `_plans/463-server-rewrite-charter.md`
 * reserves raw SQL for server/db repositories.
 *
 * The producer keeps its own row mapping: this port returns the raw rows, and
 * maintenance-sweep.ts widens them into its DistillLaneBatch shape, which is a
 * maintenance-tier concern rather than a database one.
 */
import { DISTILL_ORDER_BY } from "../domain/distill-window.ts";
import type { QuerySurface } from "./transaction.ts";

/** One raw row of the distill lane batch SELECT. */
export interface DistillLaneBatchRow {
  lane_id: string | null;
  namespace: string;
  pending_turns: number;
  processable_turns: number;
  batch_hash: string;
  total_batches: number;
}

const DISTILL_LANE_BATCH_SQL = `WITH due_turns AS (
       SELECT id, lane_id, namespace, session_ref, occurred_at, created_at
         FROM ob_raw_turns
        WHERE distilled_at IS NULL
          AND retention_tier = 'live'
     ),
     due_sessions AS (
       SELECT lane_id, namespace, session_ref, min(occurred_at) AS first_due
         FROM due_turns
        GROUP BY lane_id, namespace, session_ref
     ),
     ranked_sessions AS (
       SELECT *, row_number() OVER (
                PARTITION BY lane_id, namespace
                ORDER BY first_due ASC NULLS LAST,
                         session_ref ASC NULLS LAST
              ) AS session_rank
         FROM due_sessions
     ),
     window_turns AS (
       SELECT t.id, t.lane_id, t.namespace, t.session_ref, t.occurred_at,
              t.content_hash, (t.distilled_at IS NULL) AS is_due
         FROM ob_raw_turns t
         JOIN ranked_sessions s
           ON s.lane_id IS NOT DISTINCT FROM t.lane_id
          AND s.namespace = t.namespace
          AND s.session_ref IS NOT DISTINCT FROM t.session_ref
          AND s.session_rank <= $1
        WHERE t.retention_tier = 'live'
     ),
     -- RANK ONLY WORK THAT NEEDS DOING (#747). turn_rank is compared against
     -- the batch bound downstream, so anything ranked here consumes a position
     -- in that window. Ranking already-distilled turns alongside due ones let
     -- finished work hold the whole window: measured 2026-08-25 on the dogfood
     -- corpus, 2,070 already-distilled turns pushed the first due turn to rank
     -- 1501 -- one past the bound -- so the producer selected 0 batches on
     -- every tick for 27 days while 189,725 turns waited. Because finished
     -- turns are re-ranked identically on each pass, the starvation was
     -- permanent rather than transient, and it worsens as a namespace grows:
     -- the four namespaces that kept working are simply small enough that all
     -- their turns fit under the bound.
     --
     -- The is_due column stays SELECTed because the FILTER clauses and
     -- batch_hash below still read it; this changes WHICH ROWS ARE RANKED,
     -- not the shape of the result.
     ranked_window_turns AS (
       SELECT *, row_number() OVER (
                PARTITION BY lane_id, namespace
                ORDER BY ${DISTILL_ORDER_BY}
              ) AS turn_rank
         FROM window_turns
        WHERE is_due
     ),
     lane_totals AS (
       SELECT lane_id, namespace, count(*)::int AS pending_turns,
              min(created_at) AS first_due
         FROM due_turns
        GROUP BY lane_id, namespace
     ),
     due_lanes AS (
       SELECT totals.lane_id, totals.namespace, totals.pending_turns,
              count(*) FILTER (
                WHERE w.is_due AND w.turn_rank <= $2
              )::int AS processable_turns,
              md5(string_agg(w.id::text || ':' || w.content_hash, ','
                             ORDER BY w.turn_rank)
                  FILTER (
                    WHERE w.is_due AND w.turn_rank <= $2
                  )) AS batch_hash,
              totals.first_due
         FROM lane_totals totals
         JOIN ranked_window_turns w
           ON w.lane_id IS NOT DISTINCT FROM totals.lane_id
          AND w.namespace = totals.namespace
        GROUP BY totals.lane_id, totals.namespace, totals.pending_turns,
                 totals.first_due
       HAVING count(*) FILTER (
                WHERE w.is_due AND w.turn_rank <= $2
              ) > 0
     )
     SELECT lane_id, namespace, pending_turns, processable_turns, batch_hash,
            count(*) OVER()::int AS total_batches
       FROM due_lanes
      ORDER BY first_due, lane_id
      LIMIT $3`;

export interface MaintenanceSweepRepository {
  /**
   * Select the due distill lane batches, newest-work-first by first_due.
   *
   * `maxSessions`, `maxTurns`, and `maxBatches` are the producer's own dials,
   * passed through as $1/$2/$3 unchanged.
   */
  selectDistillLaneBatches(values: {
    maxSessions: number;
    maxTurns: number;
    maxBatches: number;
  }): Promise<DistillLaneBatchRow[]>;
}

export function createMaintenanceSweepRepository(
  db: QuerySurface,
): MaintenanceSweepRepository {
  return {
    async selectDistillLaneBatches(values) {
      const { rows } = await db.query<DistillLaneBatchRow>(DISTILL_LANE_BATCH_SQL, [
        values.maxSessions,
        values.maxTurns,
        values.maxBatches,
      ]);
      return rows;
    },
  };
}
