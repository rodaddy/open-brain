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
 *     (037:50-52). The single grade writer names three columns in its UPDATE and
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
 * THE OPERATOR JUDGEMENT LIVES IN candidate_grade (migration 040), NOT IN
 * candidate_memory. Operator decision, 2026-07-28: "i think we leave the output
 * into its own table for now and figure that out when i'm done." Two consequences
 * run through this module:
 *
 *  - The NOTE goes to candidate_grade.note. It used to overwrite
 *    candidate_memory.uncertainty_reason, which is the DISTILLER's statement about
 *    its own doubt; that compromise existed only because there was nowhere else to
 *    put it. NO path here writes uncertainty_reason any more: submitGradeBatch
 *    never did, and gradeCandidate -- which did, and destroyed distiller text in a
 *    measured reproduction on 2026-07-28 -- is now a wrapper over it. There is
 *    exactly one writer of a grade, so the two cannot drift apart again.
 *  - candidate_memory.review_action/reviewed_at/graded_by are still written, in
 *    the same transaction, because `reviewed_at IS NULL` remains the queue
 *    predicate. They are now a derived fast-path index of the live grade rather
 *    than the record itself.
 *
 * GRADES ARRIVE IN BATCHES, NOT KEYSTROKES. Operator decision, same session: the
 * page stages judgements locally and one Send commits them all. submitGradeBatch
 * is the whole submission in one transaction, undoBatch reverses one, and
 * fetchGradeHistory is how the operator finds something to change.
 *
 * NAMESPACE IS A SECURITY BOUNDARY, applied on every single query in this file
 * including the writes, per the repo standing rule that any ID-based read or
 * mutation carries an auth-derived namespace predicate. A grade addressed to an
 * id in another namespace does not 403 loudly -- it matches zero rows and is
 * reported as not-found, which leaks nothing about what exists elsewhere.
 */

import type pg from "pg";
import {
  AGENT_BEHAVIORS,
  type AgentBehavior,
  findReason,
  REASON_CODES,
} from "./grading-reasons.ts";

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
   * Which shape of unit produced this row (migration 041). 'exchange' is
   * operator-anchored -- the operator's turn plus the agent activity answering
   * it; 'fragment' is the original per-speech-turn unit. The page needs it to
   * know whether `operator_text` is the head or the row has no head at all.
   */
  unit_kind: string;
  /** The operator turn heading this exchange. Null for a fragment or an orphan. */
  anchor_turn_id: string | null;
  /**
   * The operator's verbatim words, so the page can LEAD with them.
   *
   * Null means there is no operator turn at the head -- a fragment, or an orphan
   * exchange. The UI must not substitute agent text into this position: doing so
   * is the defect 041 exists to fix, where the operator was asked to grade the
   * agent's middle sentence while his own turn sat in the context panel.
   */
  operator_text: string | null;
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
 * Validate a canned reason code (migration 042).
 *
 * NULL/absent is legitimate and common: a grade with only free text, or with no
 * note at all, carries no code. Anything present is checked against
 * src/grading-reasons.ts and REJECTED if unknown, for the same reason
 * parseReviewAction rejects "promote" -- a code the vocabulary does not contain
 * is a client bug, and storing it would create a silent bucket that no GROUP BY
 * names and no UI can explain.
 *
 * DELIBERATELY NOT CHECKED AGAINST `appliesTo`. A reason's action list is an
 * attention aid for the page (show four relevant buttons, not twelve), not a
 * data rule. Enforcing it server-side would mean the operator who picks
 * "needs context", then changes his mind from `inconclusive` to `rejected`,
 * loses the whole batch to a 400 -- punishing exactly the careful regrade the
 * page is built to make easy. The pairing is recorded as it happened; if a
 * combination turns out to be common, that is data about the vocabulary being
 * wrong, and 042 stores the code as free TEXT so fixing it is an edit rather
 * than a migration.
 */
export function parseReasonCode(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ReviewInputError("reason_code must be a string");
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!findReason(trimmed)) {
    throw new ReviewInputError(
      `unknown reason_code ${JSON.stringify(trimmed)}; expected one of ${REASON_CODES.join(", ")}`,
    );
  }
  return trimmed;
}

/**
 * Validate the agent-behavior axis (migration 042).
 *
 * Optional by design, and the asymmetry with `action` is the point: grading the
 * memory is the job, rating the agent is colour. Absent stays NULL rather than
 * defaulting to 'neutral' -- 042's header has the argument, that a manufactured
 * "the agent was fine" is indistinguishable in the counts from one the operator
 * actually made.
 *
 * Rejects an unknown value rather than dropping it, so a caller that believes it
 * recorded a behavior rating is told when it did not.
 */
export function parseAgentBehavior(value: unknown): AgentBehavior | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ReviewInputError("agent_behavior must be a string");
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const found = AGENT_BEHAVIORS.find((b) => b === trimmed);
  if (!found) {
    throw new ReviewInputError(
      `unknown agent_behavior ${JSON.stringify(trimmed)}; expected one of ${AGENT_BEHAVIORS.join(", ")}`,
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
 * module (submitGradeBatch, which gradeCandidate now delegates to, and
 * ungradeCandidate plus undoBatch's reconcile), and `machine_grade` at exactly
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
  c.machine_grade, c.machine_grade_model, c.created_at, c.source_turn_ids,
  c.unit_kind, c.anchor_turn_id, c.operator_text
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
  unit_kind: string;
  anchor_turn_id: string | null;
  operator_text: string | null;
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
    unit_kind: r.unit_kind ?? "fragment",
    anchor_turn_id: r.anchor_turn_id,
    operator_text: r.operator_text,
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
 * The grading queue: unreviewed candidates, OPERATOR-ANCHORED FIRST, then
 * doubtful, then oldest.
 *
 * WHY unit_kind LEADS THE SORT (migration 041). Measured on the live clone
 * 2026-07-28: 612 of the 1,104 fragment candidates are agent `fact` rows and not
 * one of them traces to an operator turn, while the operator's own 272 turns
 * produced 167 candidates between them. Ordering only on `uncertain` therefore
 * fills the page with the agent's sentences -- which is exactly what the
 * operator hit live, being asked to grade the agent's "Drizzle isn't a
 * dependency..." while his own turn sat unreviewed in the context panel.
 *
 * THE SORT KEY IS `(unit_kind <> 'exchange')`, NOT `unit_kind DESC`. An earlier
 * version of this used `unit_kind DESC` and was WRONG IN THE WRONG DIRECTION --
 * it put fragments first, because 'f' sorts after 'e' and DESC reverses that.
 * Caught 2026-07-28 by reading the actual first page off the live clone, where
 * the top five rows were all fragments with no operator_text. A boolean
 * expression says what is meant ("exchange first") instead of depending on the
 * alphabet happening to agree with the intent, and it stays correct if a third
 * unit_kind is ever added.
 *
 * FRAGMENTS ARE NOT REMOVED FROM THE QUEUE, only ranked last. They are 1,104
 * real candidates, 8 of them already graded, and the comparison between fragment
 * grades and exchange grades is the measurement that says whether the re-cut
 * helped. Filtering them out would destroy that, and `uncertain`/`unit_kind`
 * are advisory-only by the same rule 037:59-63 sets: they sort the queue, never
 * filter it.
 *
 * Within exchanges, orphans (anchor_turn_id IS NULL) sort after anchored ones:
 * nobody asked for them, so they are worth less of the operator's attention --
 * still gradeable, just later.
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
  /** The candidate_grade row this judgement was recorded as (migration 040). */
  grade_id: string;
  /**
   * The batch this single grade was submitted under. A single grade is a batch
   * of one, so it is undoable through the same /api/undo-batch path.
   */
  batch_id: string;
  /** The candidate_grade row this one superseded, when it was a regrade. */
  superseded_grade_id: string | null;
  /** The canned reason recorded, or null (migration 042). */
  reason_code: string | null;
  /** The optional agent-behavior rating, or null when not rated. */
  agent_behavior: AgentBehavior | null;
}

/**
 * Record a human grade for ONE candidate.
 *
 * THIS IS A THIN WRAPPER OVER submitGradeBatch, AND THAT IS THE FIX. Until
 * 2026-07-28 this function had its own UPDATE that wrote the operator's note
 * into candidate_memory.uncertainty_reason with
 * `uncertainty_reason = COALESCE($5, uncertainty_reason)`. That is the DISTILLER's
 * statement about its own doubt, and the write DESTROYED it -- measured against
 * the live clone: candidate 2e756e13 held "assistant turn with no clear outcome
 * marker..." and one POST /api/grade replaced it with the operator's sentence,
 * writing zero candidate_grade rows in the process. Migration 040 exists
 * precisely to end that compromise (040:10-15), but this route survived beside
 * the batch path as an unguarded back door to the behavior 040 removed.
 *
 * Delegating rather than repairing the UPDATE in place is deliberate: two write
 * shapes for one act of judgement is how they drift, and the divergence above is
 * that drift having already happened. There is now exactly ONE writer of a
 * grade, so the supersede-don't-overwrite rule, the batch id, the note column,
 * and the namespace predicate cannot differ between the single and batch paths.
 *
 * A single grade is submitted as a batch of one, so it gets its own batch_id and
 * is undoable through the same /api/undo-batch path as anything else.
 *
 * @returns null when no row matched -- unknown id, or an id in another
 *   namespace. Both collapse to the same answer deliberately: distinguishing
 *   them would confirm the existence of a row the caller may not read.
 */
export async function gradeCandidate(
  db: TransactionalDb,
  input: {
    namespace: string;
    id: string;
    action: ReviewAction;
    gradedBy: string;
    note?: string | null;
    reasonCode?: string | null;
    agentBehavior?: string | null;
  },
): Promise<GradeResult | null> {
  let submitted: BatchSubmitResult;
  try {
    submitted = await submitGradeBatch(db, {
      namespace: input.namespace,
      gradedBy: input.gradedBy,
      grades: [
        {
          candidateId: input.id,
          action: input.action,
          note: input.note ?? null,
          // Forwarded rather than validated here: the batch writer is the single
          // validation site, so the single and batch paths cannot accept
          // different vocabularies.
          reasonCode: input.reasonCode ?? null,
          agentBehavior: input.agentBehavior ?? null,
        },
      ],
    });
  } catch (err) {
    // The batch writer reports an unknown or cross-namespace id as a 404
    // ReviewInputError, because a batch names the item that failed. The single
    // route's contract is null-for-not-found and the HTTP layer turns that into
    // its own 404, so translate rather than letting the shapes diverge again.
    if (err instanceof ReviewInputError && err.status === 404) return null;
    throw err;
  }

  const result = submitted.results[0]!;
  return {
    id: result.candidate_id,
    review_action: result.action,
    // Read back from the row the transaction just wrote rather than restating
    // the input: reviewed_at is now()'s value inside that transaction.
    reviewed_at: result.created_at,
    graded_by: submitted.graded_by,
    machine_grade: result.machine_grade,
    agreed: result.agreed,
    grade_id: result.grade_id,
    batch_id: submitted.batch_id,
    superseded_grade_id: result.superseded_grade_id,
    reason_code: result.reason_code,
    agent_behavior: result.agent_behavior,
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

/**
 * A `pg` connection that can hold a transaction: the same `query` surface plus
 * `release`. `Queryable` alone is not enough for the batch writer -- a
 * `Pool.query` call takes an arbitrary connection from the pool, so BEGIN and
 * COMMIT issued through it can land on different sockets and the "all or
 * nothing" guarantee silently evaporates.
 */
export interface TransactionalDb extends Queryable {
  connect: () => Promise<Queryable & { release: (destroy?: boolean) => void }>;
}

/** One grade as the operator staged it in the page's local batch. */
export interface BatchGradeInput {
  candidateId: string;
  action: string;
  note?: string | null;
  /**
   * Which canned reason was picked, if any (migration 042).
   *
   * Independent of `note`. Clicking a reason seeds the note text, which the
   * operator then edits freely; the code identifies the reason after the text
   * has stopped matching it, which is the only reason to store both.
   */
  reasonCode?: string | null;
  /** The optional second axis: was the AGENT's conduct worth repeating? */
  agentBehavior?: string | null;
}

/** What happened to one item of a submitted batch. */
export interface BatchGradeResult {
  candidate_id: string;
  /** The candidate_grade row id this act of judgement was recorded as. */
  grade_id: string;
  action: ReviewAction;
  /** The candidate_grade row this one superseded, when it was a regrade. */
  superseded_grade_id: string | null;
  machine_grade: string | null;
  agreed: boolean | null;
  /**
   * Whether a note was recorded, NOT the note itself. The page already has the
   * text; echoing it back would put operator prose about real dialogue into
   * every response body and therefore into anything that logs one.
   */
  has_note: boolean;
  /**
   * The canned reason recorded, or null. Echoed back UNLIKE the note, because a
   * code is a closed-vocabulary label rather than operator prose about real
   * dialogue -- it is safe in a response body and in a log line, which is what
   * makes "counts by reason_code" observable without ever logging content.
   */
  reason_code: string | null;
  /** The behavior rating recorded, or null when the operator did not rate it. */
  agent_behavior: AgentBehavior | null;
  /**
   * When the grade row was written, as the transaction stamped it. Read back
   * from the INSERT rather than restated from the caller's clock, so the single
   * -grade wrapper can report a reviewed_at that is the row's actual value.
   */
  created_at: string;
}

export interface BatchSubmitResult {
  batch_id: string;
  graded_by: string;
  results: BatchGradeResult[];
}

/**
 * Hard ceiling on one submitted batch.
 *
 * The page holds staged grades in localStorage, so a batch can grow without
 * bound across sessions until the operator hits Send. One transaction holding
 * row locks on 1,104 candidates is not the failure mode to discover mid-slog,
 * and an operator who has staged 200 items without sending has lost the
 * review-before-commit property the batch exists for. Well above a working
 * session's realistic staging depth, well below "the whole table".
 */
export const MAX_BATCH_SIZE = 200;

/** Longest note accepted. Rejected rather than truncated -- see parseBatchGrade. */
const MAX_NOTE_LENGTH = 2000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate one staged grade into its normalized form.
 *
 * Runs BEFORE the transaction opens, for every item, so a batch whose fifth
 * item carries a bad action never issues a single write. Validating inside the
 * transaction would work -- the rollback would clean up -- but it would burn a
 * connection and take row locks to discover a client bug.
 */
function parseBatchGrade(
  value: unknown,
  index: number,
): {
  candidateId: string;
  action: ReviewAction;
  note: string | null;
  reasonCode: string | null;
  agentBehavior: AgentBehavior | null;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewInputError(`grades[${index}] must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const id = raw.candidateId ?? raw.candidate_id;
  if (typeof id !== "string" || !UUID_RE.test(id.trim())) {
    throw new ReviewInputError(`grades[${index}].candidateId must be a uuid`);
  }
  // Rejected rather than ignored: a caller that believes it recorded a machine
  // opinion here has to be told it did not. Same rule the single-grade route
  // applies, restated per item because a batch is where one bad element hides.
  if ("machine_grade" in raw || "machine_grade_model" in raw) {
    throw new ReviewInputError(
      `grades[${index}] carries machine_grade, which this API never writes -- it is REM's column (037:43-57)`,
      403,
    );
  }
  let action: ReviewAction;
  try {
    action = parseReviewAction(raw.action);
  } catch (err) {
    if (err instanceof ReviewInputError) {
      throw new ReviewInputError(
        `grades[${index}]: ${err.message}`,
        err.status,
      );
    }
    throw err;
  }
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (note.length > MAX_NOTE_LENGTH) {
    throw new ReviewInputError(
      `grades[${index}].note must be ${MAX_NOTE_LENGTH} characters or fewer`,
    );
  }
  // Both accepted in camelCase and snake_case, matching how candidateId already
  // is: the page speaks camelCase and a curl or a script speaks the column name.
  // Prefixing the index onto the failure is what makes a rejected batch
  // actionable -- "unknown reason_code" alone does not say which of 40 items.
  const reasonCode = withIndex(index, () =>
    parseReasonCode(raw.reasonCode ?? raw.reason_code),
  );
  const agentBehavior = withIndex(index, () =>
    parseAgentBehavior(raw.agentBehavior ?? raw.agent_behavior),
  );
  return {
    candidateId: id.trim(),
    action,
    note: note === "" ? null : note,
    reasonCode,
    agentBehavior,
  };
}

/** Re-throw a per-item validation failure naming the item it came from. */
function withIndex<T>(index: number, run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof ReviewInputError) {
      throw new ReviewInputError(
        `grades[${index}]: ${err.message}`,
        err.status,
      );
    }
    throw err;
  }
}

/**
 * Submit a whole batch of operator judgements in ONE transaction.
 *
 * WHY BATCHED AT ALL. Operator decision, 2026-07-28: "i would expect i fill it
 * out and hit send or something, that takes the current page out with the info
 * go'n to the server (NOT directly into the table(s))". The previous page wrote
 * on every keypress, which has no review-before-commit step -- a mis-hit key was
 * already in the table. Staging locally and sending once puts a deliberate
 * checkpoint between judgement and durability.
 *
 * WHY ONE TRANSACTION. A partially-applied batch is the worst possible outcome:
 * the operator sent 20 grades, some number landed, and the page cannot tell them
 * which. All-or-nothing means the answer to "did it work" is always yes or
 * always no, and a failure is retryable by pressing Send again.
 *
 * WHY A REGRADE SUPERSEDES INSTEAD OF OVERWRITING. 040's partial unique index
 * (idx_candidate_grade_current) permits exactly one live grade per candidate, so
 * a second grade MUST mark the first superseded or the INSERT violates the
 * index. That is the constraint doing the work the migration's rationale asks
 * for: "a regrade is a new row rather than an overwrite, so changing your mind
 * is recorded rather than erased."
 *
 * WHY candidate_memory IS STILL UPDATED. `reviewed_at IS NULL` is the queue
 * predicate fetchQueue uses (037:23-29). If only candidate_grade were written,
 * every graded item would come straight back on the next page load. The two
 * move together inside the same transaction so they cannot disagree.
 *
 * WHAT IS NOT WRITTEN. machine_grade and machine_grade_model, ever -- invariant
 * 2. And candidate_memory.uncertainty_reason, which the pre-040 single-grade
 * path overwrote as a documented compromise for having nowhere to put a note.
 * 040 gave the note its own column, so the distiller's stated reason for doubt
 * now survives the operator grading the row.
 */
export async function submitGradeBatch(
  db: TransactionalDb,
  input: {
    namespace: string;
    gradedBy: string;
    grades: unknown;
  },
): Promise<BatchSubmitResult> {
  const grader = parseGradedBy(input.gradedBy);

  if (!Array.isArray(input.grades)) {
    throw new ReviewInputError("grades must be an array");
  }
  if (input.grades.length === 0) {
    throw new ReviewInputError("grades must not be empty");
  }
  if (input.grades.length > MAX_BATCH_SIZE) {
    throw new ReviewInputError(
      `a batch may hold at most ${MAX_BATCH_SIZE} grades; received ${input.grades.length}`,
    );
  }

  const parsed = input.grades.map(parseBatchGrade);

  // A batch that grades the same candidate twice would have the second INSERT
  // collide with the first through the partial unique index -- inside the
  // transaction, so it would fail the whole submission with a constraint error
  // the operator cannot act on. Caught here, it names the duplicate.
  const seen = new Set<string>();
  for (const g of parsed) {
    if (seen.has(g.candidateId)) {
      throw new ReviewInputError(
        `candidate ${g.candidateId} appears twice in one batch; grade it once`,
      );
    }
    seen.add(g.candidateId);
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const batch = await client.query<{ batch_id: string }>(
      "SELECT gen_random_uuid() AS batch_id",
    );
    const batchId = batch.rows[0]!.batch_id;

    const results: BatchGradeResult[] = [];
    for (const g of parsed) {
      // The candidate_memory update comes FIRST and is the existence check: it
      // is namespace-scoped, so an id in another namespace matches zero rows and
      // the whole batch aborts. Doing it after the INSERT would let a
      // cross-namespace candidate_grade row be written and then rolled back --
      // correct, but it would have taken the write.
      const updated = await client.query<{
        id: string;
        machine_grade: string | null;
      }>(
        `UPDATE candidate_memory
            SET review_action = $3,
                reviewed_at = now(),
                graded_by = $4
          WHERE namespace = $1 AND id = $2
          RETURNING id, machine_grade`,
        [input.namespace, g.candidateId, g.action, grader],
      );
      const candidate = updated.rows[0];
      if (!candidate) {
        // Named, so the operator can remove the offending item and resend
        // rather than being told "something failed".
        throw new ReviewInputError(
          `candidate ${g.candidateId} not found in this namespace; the whole batch was rolled back`,
          404,
        );
      }

      // Supersede the live grade before inserting the new one. Both statements
      // are namespace-scoped even though candidate_id alone would match: the
      // predicate must not depend on the FK relationship staying correct.
      const superseded = await client.query<{ id: string }>(
        `UPDATE candidate_grade
            SET superseded_at = now()
          WHERE namespace = $1 AND candidate_id = $2 AND superseded_at IS NULL
          RETURNING id`,
        [input.namespace, g.candidateId],
      );

      const inserted = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO candidate_grade
           (namespace, candidate_id, action, note, graded_by, batch_id,
            reason_code, agent_behavior)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, created_at`,
        [
          input.namespace,
          g.candidateId,
          g.action,
          g.note,
          grader,
          batchId,
          g.reasonCode,
          g.agentBehavior,
        ],
      );

      results.push({
        candidate_id: g.candidateId,
        grade_id: inserted.rows[0]!.id,
        action: g.action,
        superseded_grade_id: superseded.rows[0]?.id ?? null,
        has_note: g.note !== null,
        // The code survives regardless of what the operator did to the note
        // text. That independence is the requirement -- editing the inserted
        // sentence must not erase which reason was chosen.
        reason_code: g.reasonCode,
        agent_behavior: g.agentBehavior,
        created_at: inserted.rows[0]!.created_at.toISOString(),
        machine_grade: candidate.machine_grade,
        agreed:
          candidate.machine_grade === null
            ? null
            : candidate.machine_grade === g.action,
      });
    }

    await client.query("COMMIT");
    return { batch_id: batchId, graded_by: grader, results };
  } catch (err) {
    // Best-effort: if the connection is already broken the ROLLBACK throws too,
    // and the original error is the one worth surfacing.
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the transaction is gone either way */
    }
    throw err;
  } finally {
    client.release();
  }
}

export interface UndoBatchResult {
  batch_id: string;
  /** candidate_grade rows removed. */
  removed: number;
  /** Previously-superseded rows restored to live. */
  restored: number;
  /** candidate_memory rows whose review columns were cleared or reverted. */
  candidates: number;
}

/**
 * Reverse a whole submitted batch. The operator's "undo".
 *
 * WHY WHOLE-BATCH AND NOT PER-ITEM. A batch is what the operator sent, so it is
 * the unit they remember. "Undo the last thing I did" after a Send means the
 * Send, not one card inside it -- and 040 added batch_id specifically so a
 * submission is reconstructable as a unit.
 *
 * WHY IT DELETES RATHER THAN SUPERSEDES. This is the one place rows leave
 * candidate_grade, and it is bounded: only rows carrying the given batch_id, in
 * the caller's namespace. Superseding them instead would leave the mistaken
 * batch permanently in the history as judgement the operator explicitly retracted
 * -- a batch sent by accident is not a changed mind, and recording it as one
 * poisons the very ground truth this table exists to collect. The append-only
 * property of 040 is about REGRADES; an undo is the operator saying "that did
 * not happen".
 *
 * RESTORING WHAT THE BATCH SUPERSEDED is what makes undo actually reversing.
 * If the batch was a regrade, its rows superseded earlier live grades; deleting
 * them without un-superseding would leave those candidates with a full grade
 * history and no live grade at all, which no other path can produce.
 *
 * candidate_memory is then reconciled from whatever grade is live afterwards --
 * the restored one if there was one, NULL if the batch was the first grade. That
 * is stronger than blindly clearing: a regrade undo puts the previous answer
 * back on the row, not an empty queue entry.
 */
export async function undoBatch(
  db: TransactionalDb,
  input: { namespace: string; batchId: string; gradedBy?: string },
): Promise<UndoBatchResult | null> {
  if (
    typeof input.batchId !== "string" ||
    !UUID_RE.test(input.batchId.trim())
  ) {
    throw new ReviewInputError("batchId must be a uuid");
  }
  const batchId = input.batchId.trim();
  // Undo is a write, so it carries the same identity guard as a grade: a
  // machine must not be able to retract the human's labels either.
  if (input.gradedBy !== undefined) parseGradedBy(input.gradedBy);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const removed = await client.query<{
      id: string;
      candidate_id: string;
      created_at: Date;
    }>(
      `DELETE FROM candidate_grade
        WHERE namespace = $1 AND batch_id = $2
        RETURNING id, candidate_id, created_at`,
      [input.namespace, batchId],
    );

    if (removed.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const candidateIds = [...new Set(removed.rows.map((r) => r.candidate_id))];

    // Un-supersede the most recent surviving grade per candidate. DISTINCT ON
    // picks it: several regrades in a row leave several superseded rows, and
    // restoring more than one would violate idx_candidate_grade_current.
    const restored = await client.query<{ id: string }>(
      `WITH latest AS (
         SELECT DISTINCT ON (candidate_id) id
           FROM candidate_grade
          WHERE namespace = $1
            AND candidate_id = ANY($2::uuid[])
            AND superseded_at IS NOT NULL
          ORDER BY candidate_id, created_at DESC, id DESC
       )
       UPDATE candidate_grade g
          SET superseded_at = NULL
         FROM latest
        WHERE g.id = latest.id
      RETURNING g.id`,
      [input.namespace, candidateIds],
    );

    // Reconcile candidate_memory from whatever grade is live now. The LEFT JOIN
    // is what makes this work for both cases in one statement: a restored grade
    // supplies the old answer, and no live grade sets the row back to unreviewed
    // so it returns to the queue.
    const reconciled = await client.query<{ id: string }>(
      `UPDATE candidate_memory c
          SET review_action = live.action,
              reviewed_at   = live.created_at,
              graded_by     = live.graded_by
         FROM (
           SELECT ids.id AS candidate_id, g.action, g.created_at, g.graded_by
             FROM unnest($2::uuid[]) AS ids(id)
             LEFT JOIN candidate_grade g
               ON g.candidate_id = ids.id
              AND g.namespace = $1
              AND g.superseded_at IS NULL
         ) live
        WHERE c.namespace = $1 AND c.id = live.candidate_id
      RETURNING c.id`,
      [input.namespace, candidateIds],
    );

    await client.query("COMMIT");
    return {
      batch_id: batchId,
      removed: removed.rows.length,
      restored: restored.rows.length,
      candidates: reconciled.rows.length,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the transaction is gone either way */
    }
    throw err;
  } finally {
    client.release();
  }
}

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

  const { rows } = await db.query<{
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
  }>(
    `SELECT g.id AS grade_id, g.candidate_id, g.action, g.note, g.graded_by,
            g.reason_code, g.agent_behavior,
            g.batch_id, g.created_at, g.superseded_at,
            c.candidate_type, c.content, c.uncertain, c.uncertainty_reason,
            c.machine_grade
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

  // A SECOND QUERY, over candidate_grade rather than candidate_memory, because
  // that is where 042 put these columns. Folding it into the scan above is not
  // possible without a join that would multiply the FILTER counts by the number
  // of grade rows per candidate -- a regrade would silently double every number
  // in the readout. Two small scans that are each correct beat one that is
  // subtly wrong the first time anyone changes their mind.
  const axes = await db.query<{
    reason_code: string | null;
    agent_behavior: string | null;
    n: string;
  }>(
    `SELECT reason_code, agent_behavior, count(*) AS n
       FROM candidate_grade
      WHERE namespace = $1 AND superseded_at IS NULL
      GROUP BY reason_code, agent_behavior`,
    [options.namespace],
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
    by_reason_code: byReason,
    agent_behavior: { rated, by_value: byBehavior },
  };
}
