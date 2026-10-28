/**
 * Owns the three statements DREAM REM used to execute from the maintenance
 * tier: the ungraded-candidate SELECT that feeds grading, the per-project
 * session count that feeds re-warming, and the UPDATE that flips a project's
 * cold cluster to `hot`.
 *
 * It exists so the maintenance tier holds no SQL text: server/maintenance/
 * dream-rem.ts takes this port instead of running the statements on its own
 * Pool (issue 1209). Design authority: `_plans/463-server-rewrite-charter.md`
 * reserves raw SQL for server/db repositories.
 */
import type pg from "pg";
import type { RemCandidateRow } from "../maintenance/dream-rem-grading.ts";
import { REM_REWARM_CAUSE } from "./tier-moves.ts";

/** One row of the per-project recent-activity count. */
export interface RemProjectActivityRow {
  namespace: string;
  repo: string;
  sessions: string;
}

export interface DreamRemRepository {
  /**
   * The batch of ungraded, unreviewed candidates REM grades, oldest first with
   * uncertain ones ahead of the rest.
   */
  selectUngradedCandidates(values: {
    namespace: string | null;
    batchSize: number;
  }): Promise<RemCandidateRow[]>;

  /** Recent activity by project, counted in DISTINCT sessions. */
  selectRecentProjectActivity(values: {
    namespace: string | null;
    windowDays: string;
  }): Promise<RemProjectActivityRow[]>;

  /**
   * Warm one project's cold cluster, returning how many rows flipped.
   */
  warmProjectCluster(values: { repo: string; rowLimit: number }): Promise<number>;
}

export function createDreamRemRepository(pool: pg.Pool): DreamRemRepository {
  return {
    async selectUngradedCandidates(values) {
      const { rows } = await pool.query<RemCandidateRow>(
        `SELECT c.id, c.namespace, c.candidate_type, c.content, c.content_hash,
            c.uncertain, c.uncertainty_reason, c.model,
            o.session_count, o.occurrence_count,
            (SELECT count(*) FROM candidate_reinforcement r
              WHERE r.candidate_id = c.id)::text AS reinforcement_count
       FROM candidate_memory c
       LEFT JOIN content_occurrences o
              ON o.namespace = c.namespace
             AND o.content_hash = c.content_hash
      WHERE c.machine_grade IS NULL
        AND c.reviewed_at IS NULL
        AND ($1::text IS NULL OR c.namespace = $1)
      ORDER BY c.uncertain DESC, c.created_at ASC
      LIMIT $2`,
        [values.namespace, values.batchSize],
      );
      return rows;
    },

    async selectRecentProjectActivity(values) {
      const { rows } = await pool.query<RemProjectActivityRow>(
        `SELECT namespace, repo, count(DISTINCT session_ref)::text AS sessions
       FROM ob_raw_turns
      WHERE repo IS NOT NULL
        AND session_ref IS NOT NULL
        AND occurred_at >= now() - ($2 || ' days')::interval
        AND ($1::text IS NULL OR namespace = $1)
      GROUP BY namespace, repo`,
        [values.namespace, values.windowDays],
      );
      return rows;
    },

    // COLDEST FIRST. A cold entry is the one the operator cannot currently
    // reach, so a flip buys the most there; a warm entry already ranks in
    // results. Ordering by recency alone would spend the budget on entries that
    // were already easy to find.
    //
    // `tier IS DISTINCT FROM 'hot'` means an already-hot entry is not
    // rewritten, so the pass converges: each run warms the next slice and a run
    // over a fully-warmed project writes nothing.
    //
    // Every flip also appends its `tier_moves` row (#1469 item 5,
    // `_plans/1469-dream-route.md`). `picked` is the selection the UPDATE
    // already made, lifted into its own CTE so the pre-update tier is readable:
    // it is evaluated once and both the UPDATE and the history INSERT use that
    // one result, so the rows warmed and the moves recorded cannot disagree.
    // The selection predicates, ordering, and limit are unchanged, and because
    // `tier IS DISTINCT FROM 'hot'` still gates it, a converged pass writes no
    // history either.
    async warmProjectCluster(values) {
      const warmed = await pool.query(
        `WITH picked AS (
          SELECT id, tier FROM thoughts
           WHERE tags @> ARRAY[$1::text]
             AND tier IS DISTINCT FROM 'hot'
             AND archived_at IS NULL
           ORDER BY (tier = 'cold') DESC, updated_at DESC
           LIMIT $2
        ), moved AS (
          UPDATE thoughts
             SET tier = 'hot', updated_at = now()
           WHERE id IN (SELECT id FROM picked)
          RETURNING id, tier
        ), history AS (
          INSERT INTO tier_moves
            (entry_id, source_table, from_tier, to_tier, cause, routing_run_id)
          SELECT moved.id, 'thoughts', picked.tier, moved.tier, $3, NULL
            FROM moved JOIN picked ON picked.id = moved.id
        )
        SELECT id FROM moved`,
        [values.repo, values.rowLimit, REM_REWARM_CAUSE],
      );
      return warmed.rowCount ?? 0;
    },
  };
}
