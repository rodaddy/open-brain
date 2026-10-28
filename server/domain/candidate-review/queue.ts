/**
 * The operator's grading queue reads. Issue #394, carried across in the L6
 * decomposition (issue 864).
 *
 * This module is the read side of the unreviewed-candidate loop. Page size is
 * a hard constraint, not a preference, and reinforcement counts are computed
 * at read time rather than stored.
 *
 * See docs/decisions/candidate-review-queue-read-shape.md
 */

import {
  CANDIDATE_COLUMNS,
  type CandidateRow,
  clampLimit,
  clampOffset,
  CONTEXT_AFTER,
  CONTEXT_BEFORE,
  iso,
  type QueueResult,
  type Queryable,
  type ReviewItem,
  type ReviewTurn,
} from "./types.ts";

interface ContextRow {
  source_id: string;
  id: string;
  role: string;
  content: string;
  session_ref: string | null;
  session_seq: number | null;
  repo: string | null;
  occurred_at: Date | null;
  is_human_prompt: boolean;
}

/**
 * The window query.
 *
 * WHY ONE QUERY FOR ALL CANDIDATES. A page is up to 50 candidates;
 * per-candidate context queries would be 50 round trips to render one screen.
 * The lateral join does it once.
 *
 * WHY THE WINDOW IS COMPUTED FROM (session_ref, occurred_at, id) AND NOT
 * session_seq. session_seq is the documented ordering key (036) but it is
 * populated only by 036's one-shot backfill -- nothing on the insert path
 * assigns it, so turns ingested since carry NULL (measured 2026-07-28: 59 of
 * 3,795). The distill windowing module reaches the same conclusion and orders by
 * the expression 036:57-63 computes session_seq FROM, which is still a perfect
 * total order on the live corpus. Using it here keeps the reviewer's view
 * identical to what the distiller saw, which is the point of showing it at all.
 */
const CONTEXT_SQL = `WITH anchors AS (
       SELECT id, session_ref, occurred_at
         FROM ob_raw_turns
        WHERE namespace = $1 AND id = ANY($2::uuid[])
     ),
     seq AS (
       SELECT t.id, t.role, t.content, t.session_ref, t.session_seq, t.repo,
              t.occurred_at, t.is_human_prompt,
              row_number() OVER (
                PARTITION BY t.session_ref ORDER BY t.occurred_at, t.id
              ) AS rn
         FROM ob_raw_turns t
        WHERE t.namespace = $1
          AND t.session_ref IN (SELECT session_ref FROM anchors WHERE session_ref IS NOT NULL)
     ),
     anchored AS (
       SELECT s.id AS source_id, s.session_ref, s.rn
         FROM seq s
         JOIN anchors a ON a.id = s.id
     )
     SELECT a.source_id, n.id, n.role, n.content, n.session_ref, n.session_seq,
            n.repo, n.occurred_at, n.is_human_prompt
       FROM anchored a
       JOIN seq n
         ON n.session_ref IS NOT DISTINCT FROM a.session_ref
        AND n.rn BETWEEN a.rn - $3::int AND a.rn + $4::int
      ORDER BY a.source_id, n.occurred_at NULLS LAST, n.id`;

/**
 * Group returned turns by the source turn they surround.
 *
 * Grouped by source turn first, then folded into candidates, because a
 * candidate with several source turns in one session would otherwise show
 * overlapping windows as duplicate turns.
 */
function groupBySource(rows: ContextRow[]): Map<string, ReviewTurn[]> {
  const bySource = new Map<string, ReviewTurn[]>();
  for (const r of rows) {
    const list = bySource.get(r.source_id) ?? [];
    list.push({
      id: r.id,
      role: r.role,
      content: r.content,
      session_ref: r.session_ref,
      session_seq: r.session_seq,
      repo: r.repo,
      occurred_at: iso(r.occurred_at),
      is_human_prompt: r.is_human_prompt,
      is_source: false,
    });
    bySource.set(r.source_id, list);
  }
  return bySource;
}

/** Transcript order: time first, then id as the tiebreak. */
function byTranscriptOrder(a: ReviewTurn, b: ReviewTurn): number {
  const at = a.occurred_at ?? "";
  const bt = b.occurred_at ?? "";
  if (at !== bt) return at < bt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Fold one candidate's source windows into a single de-duplicated transcript. */
function mergeWindows(
  candidate: CandidateRow,
  bySource: Map<string, ReviewTurn[]>,
): ReviewTurn[] {
  const sourceSet = new Set(candidate.source_turn_ids);
  const seen = new Set<string>();
  const merged: ReviewTurn[] = [];
  for (const sid of candidate.source_turn_ids) {
    for (const t of bySource.get(sid) ?? []) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        merged.push({ ...t, is_source: sourceSet.has(t.id) });
      }
    }
  }
  merged.sort(byTranscriptOrder);
  return merged;
}

/**
 * Fetch source turns plus their surrounding conversation for a set of
 * candidates, in one round trip.
 */
export async function fetchContext(
  db: Queryable,
  namespace: string,
  candidates: CandidateRow[],
): Promise<Map<string, ReviewTurn[]>> {
  const byCandidate = new Map<string, ReviewTurn[]>();
  if (candidates.length === 0) return byCandidate;

  const allSourceIds = [...new Set(candidates.flatMap((c) => c.source_turn_ids))];
  if (allSourceIds.length === 0) return byCandidate;

  const { rows } = await db.query<ContextRow>(CONTEXT_SQL, [
    namespace,
    allSourceIds,
    CONTEXT_BEFORE,
    CONTEXT_AFTER,
  ]);

  const bySource = groupBySource(rows);
  for (const c of candidates) {
    byCandidate.set(c.id, mergeWindows(c, bySource));
  }
  return byCandidate;
}

/**
 * Live reinforcement counts, joined on content_hash.
 *
 * content_hash is comparable across tables because one function produces it
 * everywhere: normalizedContentHash, applied by raw-turn ingest,
 * by Light into content_occurrences, and by
 * the distiller onto the candidate. Computed on every read by design
 * (dream-design.md:686-692).
 */
export async function fetchReinforcement(
  db: Queryable,
  namespace: string,
  hashes: string[],
): Promise<Map<string, ReviewItem["reinforcement"]>> {
  const out = new Map<string, ReviewItem["reinforcement"]>();
  if (hashes.length === 0) return out;
  const { rows } = await db.query<{
    content_hash: string;
    occurrence_count: number | string;
    session_count: number | string;
    first_seen_at: Date | null;
    last_seen_at: Date | null;
  }>(
    `SELECT content_hash, occurrence_count, session_count, first_seen_at, last_seen_at
       FROM content_occurrences
      WHERE namespace = $1 AND content_hash = ANY($2::text[])`,
    [namespace, hashes],
  );
  for (const r of rows) {
    out.set(r.content_hash, {
      occurrence_count: Number(r.occurrence_count),
      session_count: Number(r.session_count),
      first_seen: iso(r.first_seen_at),
      last_seen: iso(r.last_seen_at),
    });
  }
  return out;
}

export async function hydrate(
  db: Queryable,
  namespace: string,
  rows: CandidateRow[],
): Promise<ReviewItem[]> {
  const [context, reinforcement] = await Promise.all([
    fetchContext(db, namespace, rows),
    fetchReinforcement(db, namespace, [...new Set(rows.map((r) => r.content_hash))]),
  ]);
  return rows.map((r) => ({
    id: r.id,
    namespace: r.namespace,
    candidate_type: r.candidate_type,
    content: r.content,
    content_hash: r.content_hash,
    uncertain: r.uncertain,
    uncertainty_reason: r.uncertainty_reason,
    authority_tier: r.authority_tier,
    model: r.model,
    machine_grade: r.machine_grade,
    machine_grade_model: r.machine_grade_model,
    created_at: iso(r.created_at),
    source_turn_ids: r.source_turn_ids ?? [],
    unit_kind: r.unit_kind ?? "fragment",
    anchor_turn_id: r.anchor_turn_id,
    operator_text: r.operator_text,
    // NOT defaulted. A NULL here means "this row predates 043 or is a fragment",
    // and coercing it to 'typed' would badge a row as operator-typed on no
    // evidence -- the one claim the badge exists to make honestly.
    anchor_kind: r.anchor_kind ?? null,
    context: context.get(r.id) ?? [],
    reinforcement: reinforcement.get(r.content_hash) ?? null,
  }));
}

/**
 * The grading queue: unreviewed candidates, OPERATOR-ANCHORED FIRST, then
 * doubtful, then oldest.
 *
 * The sort key is `(unit_kind <> 'exchange')`, orphans (anchor_turn_id IS NULL)
 * sort after anchored exchanges, `typed` and `askuserquestion` rank equally,
 * and fragments are ranked last rather than filtered out.
 *
 * See docs/decisions/candidate-review-queue-sort-order.md
 */
export async function fetchQueue(
  db: Queryable,
  options: { namespace: string; limit?: number; offset?: number },
): Promise<QueueResult> {
  const limit = clampLimit(options.limit);
  const offset = clampOffset(options.offset);

  const counts = await db.query<{ total: string; graded: string }>(
    `SELECT count(*) FILTER (WHERE reviewed_at IS NULL) AS total,
            count(*) FILTER (WHERE reviewed_at IS NOT NULL) AS graded
       FROM candidate_memory
      WHERE namespace = $1`,
    [options.namespace],
  );

  const { rows } = await db.query<CandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS}
       FROM candidate_memory c
      WHERE c.namespace = $1 AND c.reviewed_at IS NULL
      ORDER BY (c.unit_kind <> 'exchange'),
               (c.anchor_turn_id IS NULL),
               c.uncertain DESC,
               c.created_at, c.id
      LIMIT $2 OFFSET $3`,
    [options.namespace, limit, offset],
  );

  return {
    items: await hydrate(db, options.namespace, rows),
    total: Number(counts.rows[0]?.total ?? 0),
    graded: Number(counts.rows[0]?.graded ?? 0),
  };
}

/**
 * The "come back to these" queue the operator asked for by name.
 *
 * Reads rows already graded `inconclusive`, which are NOT in the main queue --
 * they have a reviewed_at. 037:146-149 created idx_candidate_memory_inconclusive
 * for exactly this: "the operator asked to be able to come back and grade them
 * later, so they need to be findable without scanning every reviewed row."
 *
 * Regrading one is an ordinary `gradeCandidate` call: the UPDATE has no
 * `reviewed_at IS NULL` guard on purpose, so a second pass overwrites the first.
 */
export async function fetchInconclusive(
  db: Queryable,
  options: { namespace: string; limit?: number; offset?: number },
): Promise<QueueResult> {
  const limit = clampLimit(options.limit);
  const offset = clampOffset(options.offset);

  const counts = await db.query<{ total: string }>(
    `SELECT count(*) AS total
       FROM candidate_memory
      WHERE namespace = $1 AND review_action = 'inconclusive'`,
    [options.namespace],
  );

  const { rows } = await db.query<CandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS}
       FROM candidate_memory c
      WHERE c.namespace = $1 AND c.review_action = 'inconclusive'
      ORDER BY c.reviewed_at DESC, c.id
      LIMIT $2 OFFSET $3`,
    [options.namespace, limit, offset],
  );

  return {
    items: await hydrate(db, options.namespace, rows),
    total: Number(counts.rows[0]?.total ?? 0),
    graded: Number(counts.rows[0]?.total ?? 0),
  };
}
