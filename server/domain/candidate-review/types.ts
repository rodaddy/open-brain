/**
 * The grading vocabulary, the row shapes, and the input validators. Issue #394,
 * carried across in the L6 decomposition (issue 864).
 *
 * WHY THE SQL LIVES IN THIS MODULE AND NOT IN THE SERVER. Every rule that
 * matters is a data rule: which rows are the queue, what a grade may say, who is
 * allowed to write which column. Putting them in a request handler makes them
 * testable only through a socket. Here they are ordinary functions over a `pg`
 * client, so a test can prove "a machine identity cannot write review_action"
 * without standing up a listener.
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
 *     (037:107-114). 'inconclusive' is load-carrying, not filler: 037:35-37
 *     exists so "I cannot tell" cannot collapse into rejected, because
 *     "treating 'unsure' as 'no' is exactly the silent data loss this migration
 *     exists to stop."
 *
 * NAMESPACE IS A SECURITY BOUNDARY, applied on every single query in this
 * module including the writes, per the repo standing rule that any ID-based read
 * or mutation carries an auth-derived namespace predicate. A grade addressed to
 * an id in another namespace does not 403 loudly -- it matches zero rows and is
 * reported as not-found, which leaks nothing about what exists elsewhere.
 */

import type pg from "pg";
import {
  AGENT_BEHAVIORS,
  type AgentBehavior,
  findReason,
  REASON_CODES,
} from "../grading-reasons.ts";

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
 * How large one queue page may be.
 *
 * 50, from dream-design.md:825-827 ("20 is reviewable, 200 gets skipped"). The
 * default is deliberately smaller: the maximum stops a client asking for 1,104,
 * the default is what an operator actually meets.
 */
export const MAX_QUEUE_LIMIT = 50;
export const DEFAULT_QUEUE_LIMIT = 20;

/**
 * How many turns of conversation to show on each side of a source turn.
 *
 * The distiller extracts with 3 preceding turns visible
 * (distill-window.ts DEFAULT_CONTEXT_WINDOW = 3, the graphiti
 * last_n=3 precedent). The reviewer needs at least that much to reconstruct
 * the same judgement, plus the following turns the distiller never saw --
 * because "was this actually the decision?" is frequently answered by what
 * came next. Asymmetric on purpose, and wider than the distiller's window:
 * the operator has room the distiller did not.
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
   * How the operator authored the head (migration 043): 'typed', when he wrote
   * it unprompted; 'askuserquestion', when he picked from options THE AGENT
   * wrote; 'orphan', when nothing of his heads the row. NULL on a fragment,
   * which has no head at all.
   *
   * Carried to the page rather than inferred there because the two operator
   * kinds are NOT equivalent evidence -- a menu choice is shaped by the options
   * offered -- and the operator asked for that to stay visible: "that's kind of
   * a hybrid and should be treated more like it came from me i think, with that
   * note that it is AUQ".
   */
  anchor_kind: string | null;
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
 * server/domain/grading-reasons.ts and REJECTED if unknown, for the same reason
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
 * one, in the REM sweep module. The two sets never intersect, so this check is
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
  // Requires a separator AND a digit-led tail, so "production-host" and "m4" are safe.
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
export const CANDIDATE_COLUMNS = `
  c.id, c.namespace, c.candidate_type, c.content, c.content_hash,
  c.uncertain, c.uncertainty_reason, c.authority_tier, c.model,
  c.machine_grade, c.machine_grade_model, c.created_at, c.source_turn_ids,
  c.unit_kind, c.anchor_turn_id, c.operator_text, c.anchor_kind
`;

export interface CandidateRow {
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
  anchor_kind: string | null;
}

export type Queryable = Pick<pg.Pool, "query">;

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

export const iso = (d: Date | null | undefined): string | null =>
  d instanceof Date ? d.toISOString() : null;

/** Normalize a requested page size into the range the queue reads accept. */
export function clampLimit(value: unknown, fallback = DEFAULT_QUEUE_LIMIT): number {
  const n =
    typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_QUEUE_LIMIT);
}

/** Normalize an offset. Negative offsets are a client bug, not a wraparound. */
export function clampOffset(value: unknown): number {
  const n =
    typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

/** Re-throw a per-item validation failure naming the item it came from. */
export function withIndex<T>(index: number, run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof ReviewInputError) {
      throw new ReviewInputError(`grades[${index}]: ${err.message}`, err.status);
    }
    throw err;
  }
}

/**
 * Read the single row a statement was written to return.
 *
 * Every caller here issues a statement that returns exactly one row by
 * construction (`SELECT gen_random_uuid()`, an `INSERT ... RETURNING` of one
 * tuple, an aggregate with no GROUP BY). Throwing on absence states that
 * expectation instead of asserting it away, so a driver that ever returns
 * nothing produces a named failure rather than a property read on undefined.
 */
export function requireRow<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`${what} returned no row`);
  }
  return row;
}
