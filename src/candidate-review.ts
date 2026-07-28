/**
 * The operator's grading surface, minus the HTTP. Issue #394.
 *
 * WHAT THIS IS FOR. 1,104 candidates sit in candidate_memory with reviewed_at
 * IS NULL (measured 2026-07-28 on the dogfood clone: 1,104 total, 1,104
 * unreviewed, 830 flagged uncertain). Nothing has ever graded one. That is the
 * loop 033_candidate_memory.sql:88-91 named as the reason the table exists --
 * "producing candidates nobody judges is the same failure as not producing
 * them" -- and it is still open. This module is the read and write side of
 * closing it.
 *
 * WHY THE SQL LIVES HERE AND NOT IN THE SERVER. Every rule that matters is a
 * data rule: which rows are the queue, what a grade may say, who is allowed to
 * write which column. Putting them in a request handler makes them testable
 * only through a socket. Here they are ordinary functions over a `pg` client,
 * so a test can prove "a machine identity cannot write review_action" without
 * standing up a listener. scripts/grading-server-run.ts is the thin shell over
 * this, mirroring how scripts/dream-light-run.ts shells over src/dream-light.ts.
 *
 * THE THREE INVARIANTS THIS MODULE ENFORCES, all of them from
 * 037_candidate_memory_uncertainty.sql:43-57:
 *
 *  1. `reviewed_at IS NULL` IS the operator's queue. Not a confidence band.
 *     dream-design.md:775-781 specifies a 0.2-0.5 band review page; that table
 *     is SUPERSEDED for this build by the governing operator decision of
 *     2026-07-28 ("let everything pass"), encoded in 037:59-63: uncertain and
 *     machine_grade "are advisory only -- they sort the queue so doubtful items
 *     surface first, never filter it." So the queue predicate is the null
 *     check, and `uncertain` only reaches ORDER BY.
 *
 *  2. NOTHING HERE WRITES machine_grade. It is REM's column. A grading UI that
 *     could write it would be the model grading its own training data
 *     (037:50-52). `gradeCandidate` names five columns in its UPDATE and
 *     machine_grade is not one of them; `assertNotMachineIdentity` refuses the
 *     write outright if the caller presents as a model.
 *
 *  3. review_action is exactly promoted|rejected|duplicate|inconclusive
 *     (037:107-114). 'inconclusive' is load-bearing, not filler: 037:35-37
 *     exists so "I cannot tell" cannot collapse into rejected, because
 *     "treating 'unsure' as 'no' is exactly the silent data loss this migration
 *     exists to stop."
 *
 * ATTENTION BUDGET IS A HARD CONSTRAINT, NOT A PREFERENCE.
 * dream-design.md:825-827: "The metric to watch is not REM cost but how many
 * items land on the nightly page. Roughly: 20 is reviewable, 200 gets skipped."
 * So the queue read is capped (MAX_QUEUE_LIMIT) and paginated. Handing the
 * operator all 1,104 rows at once is the documented way to get zero of them
 * graded.
 *
 * REINFORCEMENT COUNTS ARE COMPUTED, NEVER STORED. dream-design.md:686 is
 * explicit: "Reinforcement count must never be denormalized onto the candidate
 * row or cached." So `content_occurrences` is joined live on content_hash at
 * read time (:688-692 "Cheap enough to compute every time, so it is never
 * wrong"). That join is also what makes gbrain-style receipts possible --
 * :709-712, "0.3 baseline, reinforced three times across sessions" instead of
 * an unexplained number.
 *
 * NAMESPACE IS A SECURITY BOUNDARY, applied on every single query in this file
 * including the writes, per the repo standing rule that any ID-based read or
 * mutation carries an auth-derived namespace predicate. A grade addressed to an
 * id in another namespace does not 403 loudly -- it matches zero rows and is
 * reported as not-found, which leaks nothing about what exists elsewhere.
 */

import type pg from "pg";

/**
 * The review vocabulary, verbatim from
 * 037_candidate_memory_uncertainty.sql:107-114. Duplicated here rather than
 * read from the database because a UI that offers a value the CHECK constraint
 * rejects fails at write time, in front of the operator, after they have
 * already made the judgement -- the worst possible place to discover a typo.
 */
export const REVIEW_ACTIONS = [
  "promoted",
  "rejected",
  "duplicate",
  "inconclusive",
] as const;

export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/**
 * Hard ceiling on one queue page.
 *
 * 50, from dream-design.md:825-827 ("20 is reviewable, 200 gets skipped"). The
 * default is deliberately below the ceiling: the ceiling stops a client asking
 * for 1,104, the default is what an operator actually meets.
 */
export const MAX_QUEUE_LIMIT = 50;
export const DEFAULT_QUEUE_LIMIT = 20;

/**
 * How many turns of conversation to show on each side of a source turn.
 *
 * The distiller extracts with 3 preceding turns visible
 * (src/distill-window.ts:76 DEFAULT_CONTEXT_WINDOW = 3, the graphiti
 * last_n=3 precedent). The reviewer needs at least that much to reconstruct
 * the same judgement, plus the following turns the distiller never saw --
 * because "was this actually the decision?" is frequently answered by what
 * came next. Asymmetric on purpose, and wider than the distiller's window:
 * the operator is not on a token budget, the distiller was.
 */
export const CONTEXT_BEFORE = 4;
export const CONTEXT_AFTER = 3;

/** A raw turn as shown to the reviewer. Content is already redacted at rest. */
export interface ReviewTurn {
  id: string;
  role: string;
  content: string;
  session_ref: string | null;
  session_seq: number | null;
  repo: string | null;
  occurred_at: string | null;
  is_human_prompt: boolean;
  /** True when this turn is one of the candidate's own source_turn_ids. */
  is_source: boolean;
}

/** One item on the grading page: the claim, its doubt, and its evidence. */
export interface ReviewItem {
  id: string;
  namespace: string;
  candidate_type: string;
  content: string;
  content_hash: string;
  uncertain: boolean;
  uncertainty_reason: string | null;
  authority_tier: string | null;
  model: string | null;
  /** REM's guess. DISPLAY ONLY -- see invariant 2 in the module header. */
  machine_grade: string | null;
  machine_grade_model: string | null;
  created_at: string | null;
  source_turn_ids: string[];
  /**
   * Source turns plus surrounding conversation, in transcript order.
   *
   * A candidate with an empty array here is UNGRADEABLE and the UI must say so
   * rather than presenting a bare claim -- judging "Operator approved: 'ok'"
   * without seeing what was approved is not grading, it is guessing.
   */
  context: ReviewTurn[];
  /**
   * Live cross-session corroboration count from content_occurrences, joined on
   * content_hash. Never denormalized (dream-design.md:686). Null when Light has
   * not swept the matching content.
   */
  reinforcement: {
    occurrence_count: number;
    session_count: number;
    first_seen: string | null;
    last_seen: string | null;
  } | null;
}

export interface QueueResult {
  items: ReviewItem[];
  /** Total rows matching the queue predicate, so the UI can show "n of N". */
  total: number;
  /** Rows already graded in this namespace -- the other half of progress. */
  graded: number;
}

/** Thrown for a caller error the HTTP layer should surface as 4xx, not 500. */
export class ReviewInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ReviewInputError";
    this.status = status;
  }
}

/**
 * Validate a grade value against the migration's vocabulary.
 *
 * Rejects rather than coerces. A near-miss like "promote" or "pass" is an
 * integration bug in the caller, and silently mapping it to `promoted` would
 * write a label the operator never chose into the very table that is supposed
 * to be ground truth for a future automated promoter (037:78-81).
 */
export function parseReviewAction(value: unknown): ReviewAction {
  if (typeof value !== "string") {
    throw new ReviewInputError("action must be a string");
  }
  const found = REVIEW_ACTIONS.find((a) => a === value);
  if (!found) {
    throw new ReviewInputError(
      `unknown action ${JSON.stringify(value)}; expected one of ${REVIEW_ACTIONS.join(", ")}`,
    );
  }
  return found;
}

/**
 * Identity substrings that mark a grader as a machine.
 *
 * Deliberately a denylist over the model/agent names this system actually runs,
 * not an allowlist of humans: an allowlist would reject a new human operator
 * (a silent lockout that looks like a bug), while a denylist that misses a
 * novel model name still leaves that grade attributed and auditable in
 * graded_by. The structural guarantee is elsewhere and is absolute -- verified
 * 2026-07-28: `review_action` is written at exactly two sites, both in this
 * module (gradeCandidate and ungradeCandidate), and `machine_grade` at exactly
 * one, src/dream-rem.ts:334. The two sets never intersect, so this check is
 * defence in depth against a misconfigured caller, not the primary control.
 *
 * It is checked in TWO layers, because the substring list alone was measurably
 * insufficient (see the 2026-07-28 note below): names first, then
 * MACHINE_IDENTITY_PATTERNS for model-shaped identifiers whose family word is
 * not yet known. Both stay denylists -- a human handle must never be locked out.
 */
const MACHINE_IDENTITY_MARKERS = [
  "claude",
  "gpt",
  "qwen",
  "llama",
  "mistral",
  "gemini",
  "opus",
  "sonnet",
  "haiku",
  "codex",
  "rem",
  "machine",
  "model:",
  "bot",
  "agent",
  // Added 2026-07-28 after a review pass drove a grade through as "grok-4":
  // the list only covered the families this repo runs, and every frontier
  // family outside it was accepted in silence. Measured before the fix:
  // grok-4, deepseek-v3 and kimi-k2 were all ACCEPTED.
  "grok",
  "deepseek",
  "kimi",
  "gemma",
  "phi-",
  "mixtral",
  "command-r",
  "copilot",
  "cursor",
  "devin",
  "openai",
  "anthropic",
  "ollama",
  "llm",
  "assistant",
  "grader",
  "auto",
];

/**
 * Shapes that mark a grader as a machine even when the family name is unknown.
 *
 * A substring list can only ever name families that already exist, which is the
 * bypass above: the next model ships under a word nobody listed. These patterns
 * catch the STRUCTURE of a model identity instead, which changes far more slowly
 * than the names do.
 *
 * Kept narrow on purpose, because the design rejects locking out a human
 * (:200-207): a bare human handle ("rico", "rico-m4", "jane.doe") matches none
 * of these. What they match is a version-suffixed identifier -- the shape human
 * handles do not have and model identifiers almost always do.
 */
const MACHINE_IDENTITY_PATTERNS: readonly RegExp[] = [
  // name-v3, name-v3.1, name_v12 -- an explicit version suffix.
  /[-_.]v\d/,
  // name-4, name-4.5, name-70b, name-8x7b -- a trailing size/version number.
  // Requires a separator AND a digit-led tail, so "core01" and "m4" are safe.
  /[-_.]\d+(\.\d+)?[bkm]?$/,
  // 70b / 8x7b parameter counts anywhere in the string.
  /\d+x?\d*b\b/,
  // provider/model and provider:model routing forms.
  /[/:]/,
];

/**
 * Refuse a grade presented under a machine identity.
 *
 * 037:43-57 is the whole reason: "a machine writing there silently removes the
 * item from human review. The model would be grading its own training data and
 * marking it done." graded_by is defined as the HUMAN label (037:83-86), so a
 * model-shaped value in it corrupts the one column that is supposed to be
 * ground truth. Failing the request is correct -- a machine that wanted to
 * record an opinion has machine_grade, and REM owns that path.
 */
export function assertNotMachineIdentity(gradedBy: string): void {
  const lowered = gradedBy.toLowerCase();
  const hit =
    MACHINE_IDENTITY_MARKERS.find((m) => lowered.includes(m)) ??
    MACHINE_IDENTITY_PATTERNS.find((p) => p.test(lowered))?.source;
  if (hit) {
    throw new ReviewInputError(
      `graded_by ${JSON.stringify(gradedBy)} looks like a machine identity (matched ${JSON.stringify(hit)}); ` +
        "review_action is the human ground-truth label -- a model records its opinion in machine_grade, which this API never writes",
      403,
    );
  }
}

/** Normalize and validate the grader identity. */
export function parseGradedBy(value: unknown): string {
  if (typeof value !== "string") {
    throw new ReviewInputError("graded_by must be a string");
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new ReviewInputError("graded_by must not be empty");
  }
  if (trimmed.length > 200) {
    throw new ReviewInputError("graded_by must be 200 characters or fewer");
  }
  assertNotMachineIdentity(trimmed);
  return trimmed;
}

/**
 * Columns every candidate read returns. One list so the queue, the
 * inconclusive queue, and a single-item fetch cannot drift into showing the
 * operator different fields for the same row.
 *
 * machine_grade IS selected -- the operator should see REM's guess before
 * deciding, because disagreement is the measurement (037:88-94). Selecting it
 * is safe; only writing it is forbidden.
 */
const CANDIDATE_COLUMNS = `
  c.id, c.namespace, c.candidate_type, c.content, c.content_hash,
  c.uncertain, c.uncertainty_reason, c.authority_tier, c.model,
  c.machine_grade, c.machine_grade_model, c.created_at, c.source_turn_ids
`;

interface CandidateRow {
  id: string;
  namespace: string;
  candidate_type: string;
  content: string;
  content_hash: string;
  uncertain: boolean;
  uncertainty_reason: string | null;
  authority_tier: string | null;
  model: string | null;
  machine_grade: string | null;
  machine_grade_model: string | null;
  created_at: Date | null;
  source_turn_ids: string[];
}

type Queryable = Pick<pg.Pool, "query">;

const iso = (d: Date | null | undefined): string | null =>
  d instanceof Date ? d.toISOString() : null;

/**
 * Fetch source turns plus their surrounding conversation for a set of
 * candidates, in one round trip.
 *
 * WHY ONE QUERY FOR ALL CANDIDATES. A page is up to 50 candidates; per-candidate
 * context queries would be 50 round trips to render one screen. The lateral
 * join does it once.
 *
 * WHY THE WINDOW IS COMPUTED FROM (session_ref, occurred_at, id) AND NOT
 * session_seq. session_seq is the documented ordering key (036) but it is
 * populated only by 036's one-shot backfill -- nothing on the insert path
 * assigns it, so turns ingested since carry NULL (measured 2026-07-28: 59 of
 * 3,795). src/distill-window.ts:25-39 reaches the same conclusion and orders by
 * the expression 036:57-63 computes session_seq FROM, which is still a perfect
 * total order on the live corpus. Using it here keeps the reviewer's view
 * identical to what the distiller saw, which is the point of showing it at all.
 */
async function fetchContext(
  db: Queryable,
  namespace: string,
  candidates: CandidateRow[],
): Promise<Map<string, ReviewTurn[]>> {
  const byCandidate = new Map<string, ReviewTurn[]>();
  if (candidates.length === 0) return byCandidate;

  const allSourceIds = [
    ...new Set(candidates.flatMap((c) => c.source_turn_ids)),
  ];
  if (allSourceIds.length === 0) return byCandidate;

  // Anchors: the source turns themselves, with their position in the session's
  // total order. row_number() over the whole session is what lets the window
  // below be expressed as a numeric range rather than a correlated timestamp
  // comparison per neighbour.
  const { rows } = await db.query<{
    source_id: string;
    id: string;
    role: string;
    content: string;
    session_ref: string | null;
    session_seq: number | null;
    repo: string | null;
    occurred_at: Date | null;
    is_human_prompt: boolean;
  }>(
    `WITH anchors AS (
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
      ORDER BY a.source_id, n.occurred_at NULLS LAST, n.id`,
    [namespace, allSourceIds, CONTEXT_BEFORE, CONTEXT_AFTER],
  );

  // Group by source turn first, then fold into candidates. A candidate with
  // several source turns in one session would otherwise show overlapping
  // windows as duplicate turns.
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

  for (const c of candidates) {
    const sourceSet = new Set(c.source_turn_ids);
    const seen = new Set<string>();
    const merged: ReviewTurn[] = [];
    for (const sid of c.source_turn_ids) {
      for (const t of bySource.get(sid) ?? []) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        merged.push({ ...t, is_source: sourceSet.has(t.id) });
      }
    }
    merged.sort((a, b) => {
      const at = a.occurred_at ?? "";
      const bt = b.occurred_at ?? "";
      if (at !== bt) return at < bt ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    byCandidate.set(c.id, merged);
  }
  return byCandidate;
}

/**
 * Live reinforcement counts, joined on content_hash.
 *
 * content_hash is comparable across tables because one function produces it
 * everywhere: src/embedding.ts:482 contentHash, applied by ingest
 * (src/tools/ingest-raw-turn.ts:125), by Light into content_occurrences, and by
 * the distiller onto the candidate. Computed on every read by design
 * (dream-design.md:686-692).
 */
async function fetchReinforcement(
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

async function hydrate(
  db: Queryable,
  namespace: string,
  rows: CandidateRow[],
): Promise<ReviewItem[]> {
  const [context, reinforcement] = await Promise.all([
    fetchContext(db, namespace, rows),
    fetchReinforcement(db, namespace, [
      ...new Set(rows.map((r) => r.content_hash)),
    ]),
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
    context: context.get(r.id) ?? [],
    reinforcement: reinforcement.get(r.content_hash) ?? null,
  }));
}

/** Clamp a requested page size into the attention budget. */
export function clampLimit(
  value: unknown,
  fallback = DEFAULT_QUEUE_LIMIT,
): number {
  const n =
    typeof value === "string"
      ? Number(value)
      : typeof value === "number"
        ? value
        : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_QUEUE_LIMIT);
}

/** Clamp an offset. Negative offsets are a client bug, not a wraparound. */
export function clampOffset(value: unknown): number {
  const n =
    typeof value === "string"
      ? Number(value)
      : typeof value === "number"
        ? value
        : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

/**
 * The grading queue: unreviewed candidates, doubtful ones first.
 *
 * ORDER BY uncertain DESC, created_at matches idx_candidate_memory_uncertain_first
 * (037:141-143) exactly, so the partial index serves the page. The sort is the
 * ONLY thing `uncertain` is allowed to do here (037:59-63).
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
      ORDER BY c.uncertain DESC, c.created_at, c.id
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
 * Regrading one is an ordinary `gradeCandidate` call: the UPDATE below has no
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

export interface GradeResult {
  id: string;
  review_action: ReviewAction;
  reviewed_at: string;
  graded_by: string;
  /** REM's guess at grade time, so the caller can show live agreement. */
  machine_grade: string | null;
  /** null when there was no machine guess to agree or disagree with. */
  agreed: boolean | null;
}

/**
 * Record a human grade.
 *
 * COLUMNS WRITTEN: review_action, reviewed_at, graded_by, and -- only when a
 * note is supplied -- uncertainty_reason. NOT machine_grade, NOT
 * machine_grade_model, NOT uncertain. That list is the enforcement of invariant
 * 2, and it is enforced by the UPDATE statement itself rather than by a check,
 * because a column that is never named cannot be written by a malformed
 * request.
 *
 * reviewed_at and review_action are set in the SAME statement because
 * candidate_memory_review_paired (033:104-105) rejects either one alone -- a
 * half-written review would make "unreviewed" queries silently wrong.
 *
 * WHY A NOTE GOES TO uncertainty_reason. There is no operator-note column, and
 * inventing one would need a migration this agent does not own (the 038-039
 * range belongs to STAGES). uncertainty_reason is already free text describing
 * why an item is doubtful (037:76-77), which is exactly what a note on an
 * `inconclusive` grade is. The write is prefixed with the grader so a
 * distiller-written reason is never confused with an operator-written one.
 *
 * @returns null when no row matched -- unknown id, or an id in another
 *   namespace. Both collapse to the same answer deliberately: distinguishing
 *   them would confirm the existence of a row the caller may not read.
 */
export async function gradeCandidate(
  db: Queryable,
  input: {
    namespace: string;
    id: string;
    action: ReviewAction;
    gradedBy: string;
    note?: string | null;
  },
): Promise<GradeResult | null> {
  const note = typeof input.note === "string" ? input.note.trim() : "";
  const stampedNote =
    note === "" ? null : `[${input.gradedBy}] ${note}`.slice(0, 2000);

  const { rows } = await db.query<{
    id: string;
    review_action: ReviewAction;
    reviewed_at: Date;
    graded_by: string;
    machine_grade: string | null;
  }>(
    `UPDATE candidate_memory
        SET review_action = $3,
            reviewed_at = now(),
            graded_by = $4,
            uncertainty_reason = COALESCE($5, uncertainty_reason)
      WHERE namespace = $1 AND id = $2
      RETURNING id, review_action, reviewed_at, graded_by, machine_grade`,
    [input.namespace, input.id, input.action, input.gradedBy, stampedNote],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    review_action: row.review_action,
    reviewed_at: row.reviewed_at.toISOString(),
    graded_by: row.graded_by,
    machine_grade: row.machine_grade,
    agreed:
      row.machine_grade === null
        ? null
        : row.machine_grade === row.review_action,
  };
}

/**
 * Undo the most recent grade on one candidate: put it back in the queue.
 *
 * THE ONLY DESTRUCTIVE-LOOKING OPERATION HERE, and it is deliberate and
 * bounded. A keyboard-driven grader WILL mis-hit a key; without undo the
 * operator's only recovery is to leave a wrong label in the table that a future
 * promoter will train on. Clearing all three review columns together keeps
 * candidate_memory_review_paired satisfied and restores the row to exactly its
 * pre-grade state -- it deletes no content, only the judgement.
 *
 * It cannot clear machine_grade, and does not try to: that is REM's column and
 * the operator never set it.
 */
export async function ungradeCandidate(
  db: Queryable,
  input: { namespace: string; id: string },
): Promise<{ id: string } | null> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE candidate_memory
        SET review_action = NULL, reviewed_at = NULL, graded_by = NULL
      WHERE namespace = $1 AND id = $2 AND reviewed_at IS NOT NULL
      RETURNING id`,
    [input.namespace, input.id],
  );
  return rows[0] ?? null;
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
}

/** Counts for the progress readout. One query, one scan. */
export async function fetchStats(
  db: Queryable,
  options: { namespace: string },
): Promise<ReviewStats> {
  const { rows } = await db.query<{
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
  }>(
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
    [options.namespace],
  );
  const r = rows[0]!;
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
  };
}
