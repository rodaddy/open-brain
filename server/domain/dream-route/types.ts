/**
 * Contract for the DREAM route step: a committed matrix of destinations, a Jev
 * question set built from it, and a decision made in code from the answers.
 *
 * Design: `_plans/1469-dream-route.md`. Jev routes; it does not judge. No single
 * answer decides a destination -- agreement between independent picks does, the
 * same rule the skill router uses. A candidate with no agreement stays a
 * candidate, so a wrong model costs nothing but a missed commit.
 */

/**
 * Where a candidate can go. `steering` never creates a memory.
 *
 * "Says the same thing as another item" is NOT a destination: a restated
 * decision is still a decision. It is the `restates` flag on the decision, and
 * the apply step turns a restatement into a reinforcement row instead of a
 * second memory (`docs/dream-design.md:584-621`).
 */
export const DESTINATIONS = [
  "rule",
  "decision",
  "fact",
  "correction",
  "steering",
] as const;
export type Destination = (typeof DESTINATIONS)[number];

/** One committed row of the matrix. */
export interface MatrixRow {
  readonly name: Destination;
  /** What belongs here, in plain words. This is the text Jev matches. */
  readonly line: string;
  /** Whether routing here writes a durable memory. */
  readonly commits: boolean;
}

export interface RouteMatrix {
  readonly rows: readonly MatrixRow[];
  /** First 12 hex characters of the SHA-256 of the matrix file bytes. */
  readonly fingerprint: string;
}

/**
 * R3 authority resolved from the SOURCE, never from a model
 * (`docs/code-brain-design.md:127-149`). `decided` is the operator's own words.
 */
export type AuthorityTier = "decided" | "observed";

/** The subset of a `candidate_memory` row the route step reads. */
export interface RouteCandidate {
  readonly id: string;
  readonly namespace: string;
  readonly candidateType: "decision" | "correction" | "fact" | "preference";
  readonly content: string;
  readonly operatorText: string | null;
  readonly unitKind: "exchange" | "fragment";
  readonly anchorKind: "typed" | "askuserquestion" | "orphan" | null;
}

/** How strongly the independent picks agreed. `none` means do nothing. */
export type Agreement = "high" | "low" | "none";

/** Every cutoff in one place. All guesses until a run record sets them. */
export interface RouteThresholds {
  /** A Choice pick votes when its winning probability is at least this. */
  readonly pickAt: number;
  /** A per-row yes/no votes when its probability of yes is at least this. */
  readonly yesAt: number;
  /** "restates another item in this batch" counts at or above this. */
  readonly restatedAt: number;
  /** "this drove a decision" counts at or above this. */
  readonly droveDecisionAt: number;
  /** The run record that measured these, or "" while they are guesses. */
  readonly measuredIn: string;
}

/** What code concluded about one candidate from one request's answers. */
export interface RouteDecision {
  readonly candidateId: string;
  /** `null` when agreement is `none`. */
  readonly destination: Destination | null;
  readonly agreement: Agreement;
  readonly authorityTier: AuthorityTier;
  readonly restates: boolean;
  readonly droveDecision: boolean;
  /** Plain sentences saying why, for the history table and for a reader. */
  readonly reasons: readonly string[];
  /** Every answer flattened to the one value that drove the decision. */
  readonly raw: Readonly<Record<string, number | string>>;
}

/** Where a cohort row came from, weakest precedence first. */
export type CohortSource = "neighbour" | "draw" | "labelled";

export interface FrozenRow {
  ordinal: number;
  candidateId: string;
  namespace: string;
  contentHash: string;
  source: CohortSource;
  neighbourOf: string | null;
  snapshot: CandidateSnapshot;
}

export interface CandidateSnapshot {
  id: string;
  namespace: string;
  candidate_type: string;
  content: string;
  content_hash: string;
  operator_text: string | null;
  unit_kind: string;
  anchor_kind: string | null;
  first_said_at: string | null;
  last_said_at: string | null;
  source_turn_ids: string[];
}
