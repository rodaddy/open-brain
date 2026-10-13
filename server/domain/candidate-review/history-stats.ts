/**
 * The grading history and the progress readout. Issue #394, carried across in
 * the L6 decomposition (issue 864).
 *
 * These are the two read surfaces that are ABOUT the grading rather than about
 * the candidates: what the operator has already judged, and how far through the
 * corpus that judging is.
 */

import type { AgentBehavior } from "../grading-reasons.ts";
import {
  clampLimit,
  clampOffset,
  iso,
  type Queryable,
  requireRow,
  type ReviewAction,
} from "./types.ts";

/** One entry of the grading history, with enough content to recognise the item. */
export interface GradeHistoryItem {
  grade_id: string;
  candidate_id: string;
  action: ReviewAction;
  note: string | null;
  /**
   * The canned reason, or null (migration 042). Returned alongside the note the
   * operator may have edited beyond recognition -- that is the whole point of
   * keeping the code separately, so the history can still say WHY.
   */
  reason_code: string | null;
  agent_behavior: AgentBehavior | null;
  graded_by: string;
  batch_id: string | null;
  created_at: string;
  superseded_at: string | null;
  candidate_type: string;
  content: string;
  uncertain: boolean;
  uncertainty_reason: string | null;
  machine_grade: string | null;
  /**
   * How the graded row's head was authored (043). In the history because "which
   * kind of head did I actually grade?" is the question that makes these grades
   * comparable -- a typed anchor and a menu choice are different evidence, and
   * without the column the history cannot tell them apart after the fact.
   */
  anchor_kind: string | null;
}

export interface GradeHistoryResult {
  items: GradeHistoryItem[];
  total: number;
  /** Batches newest-first, so the page can offer "undo the last one". */
  batches: Array<{
    batch_id: string;
    size: number;
    created_at: string;
    /** False once any row of the batch has been superseded or removed. */
    live: boolean;
  }>;
}

interface HistoryRow {
  grade_id: string;
  candidate_id: string;
  action: ReviewAction;
  note: string | null;
  reason_code: string | null;
  agent_behavior: AgentBehavior | null;
  graded_by: string;
  batch_id: string | null;
  created_at: Date;
  superseded_at: Date | null;
  candidate_type: string;
  content: string;
  uncertain: boolean;
  uncertainty_reason: string | null;
  machine_grade: string | null;
  anchor_kind: string | null;
}

/**
 * Recent grades, newest first, with the candidate content beside them.
 *
 * This is the "change" surface. Finding an item to re-grade by candidate id is
 * not something an operator can do; finding it by reading the claim they graded
 * ten minutes ago is. Content is joined in for that reason alone, and the join
 * is namespace-scoped on BOTH sides -- the grade row and the candidate -- so a
 * mismatched pair cannot leak content across a namespace boundary.
 *
 * Superseded rows are INCLUDED and flagged. Seeing that an item was graded twice,
 * and what the first answer was, is exactly the history 040 exists to keep.
 */
export async function fetchGradeHistory(
  db: Queryable,
  options: { namespace: string; limit?: number; offset?: number },
): Promise<GradeHistoryResult> {
  const limit = clampLimit(options.limit);
  const offset = clampOffset(options.offset);

  const counts = await db.query<{ total: string }>(
    `SELECT count(*) AS total FROM candidate_grade WHERE namespace = $1`,
    [options.namespace],
  );

  const { rows } = await db.query<HistoryRow>(
    `SELECT g.id AS grade_id, g.candidate_id, g.action, g.note, g.graded_by,
            g.reason_code, g.agent_behavior,
            g.batch_id, g.created_at, g.superseded_at,
            c.candidate_type, c.content, c.uncertain, c.uncertainty_reason,
            c.machine_grade, c.anchor_kind
       FROM candidate_grade g
       JOIN candidate_memory c
         ON c.id = g.candidate_id AND c.namespace = $1
      WHERE g.namespace = $1
      ORDER BY g.created_at DESC, g.id DESC
      LIMIT $2 OFFSET $3`,
    [options.namespace, limit, offset],
  );

  const batches = await db.query<{
    batch_id: string;
    size: string;
    created_at: Date;
    live_rows: string;
  }>(
    `SELECT batch_id, count(*) AS size, max(created_at) AS created_at,
            count(*) FILTER (WHERE superseded_at IS NULL) AS live_rows
       FROM candidate_grade
      WHERE namespace = $1 AND batch_id IS NOT NULL
      GROUP BY batch_id
      ORDER BY max(created_at) DESC
      LIMIT 20`,
    [options.namespace],
  );

  return {
    items: rows.map((r) => ({
      grade_id: r.grade_id,
      candidate_id: r.candidate_id,
      action: r.action,
      note: r.note,
      reason_code: r.reason_code,
      agent_behavior: r.agent_behavior,
      graded_by: r.graded_by,
      batch_id: r.batch_id,
      created_at: r.created_at.toISOString(),
      superseded_at: iso(r.superseded_at),
      candidate_type: r.candidate_type,
      content: r.content,
      uncertain: r.uncertain,
      uncertainty_reason: r.uncertainty_reason,
      machine_grade: r.machine_grade,
      anchor_kind: r.anchor_kind ?? null,
    })),
    total: Number(counts.rows[0]?.total ?? 0),
    batches: batches.rows.map((b) => ({
      batch_id: b.batch_id,
      size: Number(b.size),
      created_at: b.created_at.toISOString(),
      live: Number(b.live_rows) === Number(b.size),
    })),
  };
}

export interface ReviewStats {
  namespace: string;
  total: number;
  ungraded: number;
  graded: number;
  uncertain_ungraded: number;
  by_action: Record<string, number>;
  /**
   * Human-vs-machine agreement over rows where BOTH exist.
   *
   * This is the number 037:88-94 says the two-column split exists to produce:
   * "Agreement between this and review_action is how we find out whether the
   * machine can be trusted, and that number only exists while the two stay
   * independent." Null until there is at least one comparable pair -- reporting
   * 0% from zero samples would read as "the machine is always wrong."
   *
   * `distinct_machine_grades` extends that same "do not report a number that
   * reads as something it is not" rule to the DEGENERATE case, which is the
   * live one: measured on the dogfood clone 2026-07-28, REM's heuristic grader
   * assigned `inconclusive` to 1103 of 1104 candidates (99.91%). A constant
   * predictor has no discrimination, so `rate` against it measures only the
   * operator's own action mix -- grade everything `promoted` and the rate is 0%,
   * grade everything `inconclusive` and it is 100%, and neither says anything
   * about the machine. Exposing the count of distinct grades actually emitted
   * lets the page say so rather than presenting a meaningless percentage as
   * evidence. It is a description of the existing grader, NOT a fix to it: the
   * missing signal is the one-off rule dream-design.md:817-821 marks as an open
   * hole with an explicit "do not invent a rule for it during implementation."
   */
  machine_agreement: {
    compared: number;
    agreed: number;
    rate: number | null;
    /**
     * Distinct machine_grade values among THE COMPARED ROWS -- the same set
     * `rate` is computed over, not the whole table. Scoping matters: the clone
     * holds exactly one non-`inconclusive` machine grade, so a table-wide count
     * reports 2 and hides the degeneracy until the operator happens to grade
     * that single row. 1 means the grader was constant across everything
     * compared, so `rate` is not a trust measurement.
     */
    distinct_machine_grades: number;
  };
  /**
   * Live grades per canned reason (migration 042). Keyed by code; codes never
   * used are absent rather than zero, so the readout shows what the operator
   * actually reaches for instead of a wall of zeroes across twelve buttons.
   *
   * This is the number the codes exist to produce. A high
   * `needs-surrounding-context` on `exchange` rows says the re-cut in 041 is
   * still cutting too small; a high `progress-narration` says the classifier is
   * admitting transient status. Both are extraction defects that free-text notes
   * could only ever suggest.
   *
   * Counted over LIVE grades only (superseded_at IS NULL), matching what
   * `by_action` reports off candidate_memory: a superseded reason is a mind the
   * operator changed, and counting it would double-count one judgement.
   */
  by_reason_code: Record<string, number>;
  /**
   * Live grades per behavior rating. Rating is optional, so the count of rated
   * rows is deliberately NOT the graded count -- `rated` says how much of the
   * second axis actually exists, which is the number that tells you whether the
   * control is being used at all.
   */
  agent_behavior: {
    rated: number;
    by_value: Record<string, number>;
  };
  /**
   * Rows per anchor_kind (043), split ungraded/graded.
   *
   * This is the readout that says whether the AskUserQuestion fix actually
   * landed. Before 043 all 6 AUQ turns in the corpus headed NOTHING -- each was
   * swept into the agent body of the preceding exchange -- so an
   * `askuserquestion` count of 0 against a corpus known to contain them is the
   * regression, and it is invisible in every other number here.
   *
   * Keyed by the value, with 'fragment' standing in for SQL NULL: a fragment has
   * no head at all, and a JSON object cannot key on null. Naming it rather than
   * dropping it keeps the four buckets summing to `total`, so a reader can tell
   * "no AUQ rows exist" from "the breakdown lost some rows".
   */
  by_anchor_kind: Record<string, { total: number; ungraded: number }>;
}

interface CountRow {
  total: string;
  ungraded: string;
  graded: string;
  uncertain_ungraded: string;
  promoted: string;
  rejected: string;
  duplicate: string;
  inconclusive: string;
  compared: string;
  agreed: string;
  distinct_machine_grades: string;
}

/** The main scan over candidate_memory: one row of ungrouped FILTER counts. */
async function fetchCounts(db: Queryable, namespace: string): Promise<CountRow> {
  const { rows } = await db.query<CountRow>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE reviewed_at IS NULL) AS ungraded,
            count(*) FILTER (WHERE reviewed_at IS NOT NULL) AS graded,
            count(*) FILTER (WHERE reviewed_at IS NULL AND uncertain) AS uncertain_ungraded,
            count(*) FILTER (WHERE review_action = 'promoted') AS promoted,
            count(*) FILTER (WHERE review_action = 'rejected') AS rejected,
            count(*) FILTER (WHERE review_action = 'duplicate') AS duplicate,
            count(*) FILTER (WHERE review_action = 'inconclusive') AS inconclusive,
            count(*) FILTER (WHERE review_action IS NOT NULL AND machine_grade IS NOT NULL) AS compared,
            count(*) FILTER (WHERE review_action IS NOT NULL AND machine_grade = review_action) AS agreed,
            count(DISTINCT machine_grade) FILTER (WHERE review_action IS NOT NULL)
              AS distinct_machine_grades
       FROM candidate_memory
      WHERE namespace = $1`,
    [namespace],
  );
  return requireRow(rows, "review stats counts");
}

/**
 * A SECOND QUERY, over candidate_grade rather than candidate_memory, because
 * that is where 042 put these columns. Folding it into the main scan is not
 * possible without a join that would multiply the FILTER counts by the number
 * of grade rows per candidate -- a regrade would silently double every number
 * in the readout. Two small scans that are each correct beat one that is
 * subtly wrong the first time anyone changes their mind.
 */
async function fetchAxes(
  db: Queryable,
  namespace: string,
): Promise<Pick<ReviewStats, "by_reason_code" | "agent_behavior">> {
  const axes = await db.query<{
    reason_code: string | null;
    agent_behavior: string | null;
    n: string;
  }>(
    `SELECT reason_code, agent_behavior, count(*) AS n
       FROM candidate_grade
      WHERE namespace = $1 AND superseded_at IS NULL
      GROUP BY reason_code, agent_behavior`,
    [namespace],
  );

  const byReason: Record<string, number> = {};
  const byBehavior: Record<string, number> = {};
  let rated = 0;
  for (const a of axes.rows) {
    const n = Number(a.n);
    if (a.reason_code !== null) {
      byReason[a.reason_code] = (byReason[a.reason_code] ?? 0) + n;
    }
    if (a.agent_behavior !== null) {
      byBehavior[a.agent_behavior] = (byBehavior[a.agent_behavior] ?? 0) + n;
      rated += n;
    }
  }
  return {
    by_reason_code: byReason,
    agent_behavior: { rated, by_value: byBehavior },
  };
}

/**
 * A THIRD scan, over candidate_memory again rather than folded into the first.
 * GROUP BY anchor_kind cannot coexist with the ungrouped FILTER counts in one
 * statement, and adding a GROUPING SETS to that query would make every existing
 * number in the readout depend on getting a new clause right. A second count(*)
 * over the same table is cheap; a subtly wrong `graded` is not.
 */
async function fetchAnchorKinds(
  db: Queryable,
  namespace: string,
): Promise<ReviewStats["by_anchor_kind"]> {
  const anchors = await db.query<{
    anchor_kind: string | null;
    total: string;
    ungraded: string;
  }>(
    `SELECT anchor_kind,
            count(*) AS total,
            count(*) FILTER (WHERE reviewed_at IS NULL) AS ungraded
       FROM candidate_memory
      WHERE namespace = $1
      GROUP BY anchor_kind`,
    [namespace],
  );

  const byAnchorKind: ReviewStats["by_anchor_kind"] = {};
  for (const a of anchors.rows) {
    // NULL is a fragment: 041 gave every exchange row a kind, and 043 backfilled
    // the ones that predate it, so the only rows left NULL are the 1,104
    // fragments that have no head to describe.
    const key = a.anchor_kind ?? "fragment";
    const entry = byAnchorKind[key] ?? { total: 0, ungraded: 0 };
    entry.total += Number(a.total);
    entry.ungraded += Number(a.ungraded);
    byAnchorKind[key] = entry;
  }
  return byAnchorKind;
}

/** Counts for the progress readout. */
export async function fetchStats(
  db: Queryable,
  options: { namespace: string },
): Promise<ReviewStats> {
  const r = await fetchCounts(db, options.namespace);
  const axes = await fetchAxes(db, options.namespace);
  const byAnchorKind = await fetchAnchorKinds(db, options.namespace);

  const compared = Number(r.compared);
  const agreed = Number(r.agreed);
  return {
    namespace: options.namespace,
    total: Number(r.total),
    ungraded: Number(r.ungraded),
    graded: Number(r.graded),
    uncertain_ungraded: Number(r.uncertain_ungraded),
    by_action: {
      promoted: Number(r.promoted),
      rejected: Number(r.rejected),
      duplicate: Number(r.duplicate),
      inconclusive: Number(r.inconclusive),
    },
    machine_agreement: {
      compared,
      agreed,
      rate: compared === 0 ? null : agreed / compared,
      distinct_machine_grades: Number(r.distinct_machine_grades),
    },
    by_reason_code: axes.by_reason_code,
    agent_behavior: axes.agent_behavior,
    by_anchor_kind: byAnchorKind,
  };
}
