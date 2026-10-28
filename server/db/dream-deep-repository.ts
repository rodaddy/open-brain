/**
 * Owns the four statements DREAM Deep used to execute from the maintenance
 * tier: the unreviewed-queue depth count, the one-page candidate SELECT, the
 * source-turn read for that page, and the context-window read around those
 * source turns.
 *
 * It exists so the maintenance tier holds no SQL text: server/maintenance/
 * dream-deep.ts takes this port instead of running the statements on its own
 * Pool (issue 1209). Design authority: `_plans/463-server-rewrite-charter.md`
 * reserves raw SQL for server/db repositories.
 */
import type pg from "pg";

/** One unreviewed candidate on the review page, with its occurrence receipts. */
export interface CandidateRow {
  id: string;
  namespace: string;
  candidate_type: string;
  content: string;
  uncertain: boolean;
  uncertainty_reason: string | null;
  model: string | null;
  authority_tier: string | null;
  created_at: Date;
  first_said_at: Date | null;
  last_said_at: Date | null;
  machine_grade: string | null;
  machine_grade_model: string | null;
  source_turn_ids: string[];
  session_count: string | null;
  occurrence_count: string | null;
  occ_first_seen_at: Date | null;
  occ_last_seen_at: Date | null;
}

/** One raw turn, source or context. */
export interface TurnRow {
  id: string;
  role: string | null;
  content: string;
  occurred_at: Date;
  session_ref: string | null;
  session_seq: number | null;
  repo: string | null;
}

/** One session window to read context turns from, inclusive of both bounds. */
export interface TurnContextWindow {
  session_ref: string;
  lo: number;
  hi: number;
}

export interface DreamDeepRepository {
  /** Count unreviewed candidates behind this page. */
  countUnreviewedCandidates(values: { namespace: string | null }): Promise<number>;

  /**
   * Read one page of unreviewed candidates.
   *
   * THE QUEUE PREDICATE. `reviewed_at IS NULL`, and nothing else. No band, no
   * machine_grade filter, no uncertainty gate -- 037:59-63. If a future change
   * adds a WHERE clause here it is a suppression path and needs an operator
   * decision, not a commit.
   */
  selectCandidatePage(values: {
    namespace: string | null;
    pageSize: number;
  }): Promise<CandidateRow[]>;

  /**
   * Every source turn across the page, in one query.
   *
   * One query per page rather than one per bundle: the page is small by default
   * but that default is a policy dial, and a builder that issues 2N queries
   * degrades the moment someone raises it.
   */
  selectSourceTurns(values: {
    turnIds: string[];
    namespace: string | null;
  }): Promise<TurnRow[]>;

  /**
   * Context turns around every source turn, in one query.
   *
   * Context is read by (session_ref, session_seq) window. session_seq is THE
   * ordering key (036) -- turn_index is per-batch and broken, and
   * parent_turn_uuid dangles on 24% of rows, so neither can order a window. A
   * source turn whose session_seq is NULL (the 036 backfill gap, re-run in 039)
   * simply gets no context rather than getting wrong context.
   */
  selectContextTurns(values: {
    windows: TurnContextWindow[];
    namespace: string | null;
  }): Promise<TurnRow[]>;
}

export function createDreamDeepRepository(pool: pg.Pool): DreamDeepRepository {
  return {
    async countUnreviewedCandidates(values) {
      const depth = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n
       FROM candidate_memory
      WHERE reviewed_at IS NULL
        AND ($1::text IS NULL OR namespace = $1)`,
        [values.namespace],
      );
      return Number(depth.rows[0]?.n ?? 0);
    },

    async selectCandidatePage(values) {
      const candidates = await pool.query<CandidateRow>(
        `SELECT c.id, c.namespace, c.candidate_type, c.content,
            c.uncertain, c.uncertainty_reason, c.model, c.authority_tier,
            c.created_at, c.first_said_at, c.last_said_at,
            c.machine_grade, c.machine_grade_model, c.source_turn_ids,
            o.session_count, o.occurrence_count,
            o.first_seen_at AS occ_first_seen_at,
            o.last_seen_at  AS occ_last_seen_at
       FROM candidate_memory c
       LEFT JOIN content_occurrences o
              ON o.namespace = c.namespace
             AND o.content_hash = c.content_hash
      WHERE c.reviewed_at IS NULL
        AND ($1::text IS NULL OR c.namespace = $1)
      ORDER BY c.uncertain DESC, c.created_at ASC
      LIMIT $2`,
        [values.namespace, values.pageSize],
      );
      return candidates.rows;
    },

    async selectSourceTurns(values) {
      const sourceTurns = await pool.query<TurnRow>(
        `SELECT id, role, content, occurred_at, session_ref, session_seq, repo
       FROM ob_raw_turns
      WHERE id = ANY($1::uuid[])
        AND ($2::text IS NULL OR namespace = $2)`,
        [values.turnIds, values.namespace],
      );
      return sourceTurns.rows;
    },

    async selectContextTurns(values) {
      const ctx = await pool.query<TurnRow>(
        `SELECT DISTINCT t.id, t.role, t.content, t.occurred_at,
            t.session_ref, t.session_seq, t.repo
       FROM ob_raw_turns t
       JOIN unnest($1::text[], $2::int[], $3::int[]) AS w(session_ref, lo, hi)
         ON t.session_ref = w.session_ref
        AND t.session_seq BETWEEN w.lo AND w.hi
      WHERE ($4::text IS NULL OR t.namespace = $4)`,
        [
          values.windows.map((w) => w.session_ref),
          values.windows.map((w) => w.lo),
          values.windows.map((w) => w.hi),
          values.namespace,
        ],
      );
      return ctx.rows;
    },
  };
}
