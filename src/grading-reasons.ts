/**
 * The canned grading reasons, and the agent-behavior axis. Migration 042.
 *
 * ONE DEFINITION, TWO CONSUMERS, AND THAT IS THE ENTIRE POINT OF THE FILE.
 * src/grading-server.ts validates a submitted reason_code against this list;
 * src/grading-page.ts builds its buttons from the same list, serialized into the
 * page. If the vocabulary lived in both places, the failure mode is specific and
 * ugly: the page offers a button whose code the server rejects, so the operator
 * discovers it at SEND -- after judging a whole batch -- and the WHOLE batch
 * rolls back (submitGradeBatch is one transaction). That is the same argument
 * REVIEW_ACTIONS is duplicated-from-the-migration-with-a-comment for in
 * candidate-review.ts:89-95: a UI offering a value the write path rejects fails
 * at the worst possible moment.
 *
 * WHY CODES AND NOT PROSE. Migration 042's header has the measurement: the
 * operator's 8 real notes are five sentences expressing three ideas, retyped by
 * hand with a typo and a new phrasing each time. "this by itself isn't, but the
 * surronding messages will make for useful info in whole" and "combined with
 * surrounding messages???" are the same judgement and share not one word, so no
 * grep finds both. A code makes "which extraction defect does he hit most" a
 * GROUP BY instead of a reading exercise.
 *
 * THE CODE DOES NOT REPLACE THE NOTE. Clicking a reason INSERTS its text into
 * the note textarea, where it is fully editable, and the code is recorded
 * alongside whatever the note finally says. Operator, verbatim, 2026-07-28: "so
 * the can'd response if i click one, should allow me to put it into the notes
 * for adjustment and/or the note section stays to allow me to add a little
 * color". So `text` here is a STARTING POINT for the operator's own words, not a
 * canonical string to be matched later -- which is exactly why the code has to
 * be recorded separately: the moment he edits the text, the text stops
 * identifying the reason and only the code still does.
 *
 * WHY THE SET IS SMALL. There are 1,104 items to grade and
 * dream-design.md:825-827 is blunt about the constraint -- "20 is reviewable,
 * 200 gets skipped". A reason list long enough to need reading is a list that
 * gets ignored, and an ignored list collects no data. Four to six per action is
 * the budget: scannable at a glance, one keystroke or click, no submenu.
 *
 * WHERE THE SET COMES FROM. The four that map directly onto the operator's own
 * notes are marked below with the note they came from -- those are evidence, not
 * invention. The rest are judgement calls about what an operator needs to say
 * fast, and each carries its reasoning. They are a starting vocabulary, expected
 * to change once there are counts to look at; 042 stores reason_code as
 * unconstrained TEXT precisely so that changing it is an edit to this file
 * rather than a migration, and so codes retired from here stay readable in rows
 * that already carry them.
 */

// TYPE-ONLY import, and it must stay that way. candidate-review.ts imports the
// validators in this file, so a value import here closes a runtime cycle --
// measured: pulling REVIEW_ACTIONS in as a value threw "Cannot access
// 'REVIEW_ACTIONS' before initialization" at module load. `import type` erases,
// so the two modules share the vocabulary's TYPE without either one having to
// be evaluated first.
import type { ReviewAction } from "./candidate-review.ts";

/** One canned reason: what it is called, what it types, and where it applies. */
export interface GradingReason {
  /** The stable identifier written to candidate_grade.reason_code. */
  code: string;
  /** Button text. Short enough to scan a row of them without reading. */
  label: string;
  /**
   * The default note text inserted into the textarea. The operator edits it
   * freely afterwards; the code is what survives the edit.
   */
  text: string;
  /**
   * Which grades this reason is offered for. The page filters the buttons to
   * the currently-selected action, because "already known" under `promoted` is
   * noise and "shows reasoning" under `duplicate` is nonsense. Listing every
   * action is legitimate for a reason that genuinely applies everywhere.
   */
  appliesTo: readonly ReviewAction[];
}

/**
 * The vocabulary.
 *
 * Ordered within each action by how often the operator's own 8 notes suggest
 * he'd reach for it, so the most likely button is leftmost and the scan is
 * usually one item long.
 */
export const GRADING_REASONS: readonly GradingReason[] = [
  // --- from the operator's real notes -------------------------------------
  // These four are the measured ones. Each cites the note it generalizes.

  {
    // "this by itself isn't, but the surronding messages will make for useful
    // info in whole" and "combined with surrounding messages???" -- 2 of his 5
    // notes, the single most common thing he needed to say. It is also the exact
    // complaint migration 041 re-cut the extraction unit to answer, so counting
    // it is how we find out whether the re-cut worked: this code appearing on
    // `exchange` rows means the exchange is still cut too small.
    code: "needs-surrounding-context",
    label: "needs context",
    text: "This by itself isn't useful, but the surrounding messages make it useful as a whole.",
    appliesTo: ["inconclusive", "rejected"],
  },
  {
    // "show's logic" and "circular but has a point and states facts" -- the
    // value is the reasoning, not the conclusion. Offered on promote AND on
    // inconclusive because both of his notes carrying this idea were graded
    // inconclusive, not promoted: he saw the reasoning and still could not tell
    // whether it was worth keeping.
    code: "shows-reasoning",
    label: "shows reasoning",
    text: "Shows the logic behind the decision, which is the part worth keeping.",
    appliesTo: ["promoted", "inconclusive"],
  },
  {
    // "circular but has a point and states facts" -- the only note that led to a
    // straight promote. A durable statement about how something actually is.
    code: "states-fact",
    label: "states a fact",
    text: "States a durable fact worth remembering.",
    appliesTo: ["promoted", "inconclusive"],
  },
  {
    // "logic to fix an issue" -- his other promote. Distinct from states-fact:
    // this is a diagnosis-and-repair, which is the shape most likely to be
    // needed again verbatim.
    code: "fixes-an-issue",
    label: "fixes an issue",
    text: "Captures the reasoning that fixed a real problem.",
    appliesTo: ["promoted"],
  },

  // --- judgement calls, each with its reason -------------------------------

  {
    // The single largest category of junk in the corpus. Measured 2026-07-28:
    // 612 of 1,104 fragment candidates are agent `fact` rows, and the sampled
    // content is dominated by transient status ("Pushing and opening the PR").
    // A status line is true when written and worthless a minute later, so it
    // needs a one-click rejection or it will be typed out 600 times.
    code: "progress-narration",
    label: "progress narration",
    text: "Transient status about what was happening at the time, not a durable memory.",
    appliesTo: ["rejected"],
  },
  {
    // Tool output and mechanical chatter that got swept into the unit. Kept
    // apart from progress-narration on purpose: they imply different fixes.
    // Narration means the classifier admitted the wrong sentence; tool noise
    // means the WINDOW is wrong, which is a distiller-side bug in
    // src/distill-exchange.ts rather than a scoring one.
    code: "tool-noise",
    label: "tool noise",
    text: "This is tool output or mechanical chatter, not something anyone said or decided.",
    appliesTo: ["rejected"],
  },
  {
    // The operator already knows it, or a newer memory replaces it. Separate
    // from `duplicate` the ACTION, which means "this row duplicates another
    // row": this is "the SYSTEM already knows this", which can be true with no
    // duplicate candidate anywhere in the table.
    code: "already-known",
    label: "already known",
    text: "Already known, or superseded by something newer.",
    appliesTo: ["rejected", "duplicate"],
  },
  {
    // Distinct from needs-surrounding-context, and the distinction is the whole
    // value: this one says the surrounding context WOULD NOT help either --
    // there is no judgement to recover. That is a signal to drop the unit, where
    // needs-surrounding-context is a signal to widen it.
    code: "too-fragmentary",
    label: "too fragmentary",
    text: "Not enough here to judge, and more context wouldn't help.",
    appliesTo: ["rejected", "inconclusive"],
  },
  {
    // dream-design.md treats decision records as the highest-value artifact, and
    // 166 of the operator's 167 fragment candidates are `decision` rows. Worth
    // its own code so "did we capture the decisions" is answerable directly.
    code: "good-decision-record",
    label: "good decision record",
    text: "A decision worth being able to look up later, with the reason attached.",
    appliesTo: ["promoted"],
  },
  {
    // The operator corrected the agent and the correction is the durable part.
    // This is the code most likely to co-occur with agent_behavior='bad', and
    // that pairing -- promoted memory, bad behavior -- is exactly the
    // combination that would have been unrecoverable if 042 had folded the two
    // axes into one column.
    code: "correction-worth-keeping",
    label: "correction worth keeping",
    text: "A correction the agent should not need again.",
    appliesTo: ["promoted"],
  },
  {
    // "I cannot tell" needs a way to say WHY it cannot be told, or
    // `inconclusive` becomes an undifferentiated pile. 037:35-37 keeps
    // 'inconclusive' first-class precisely so unsure does not collapse into no;
    // this keeps the same distinction one level down.
    code: "unsure-value",
    label: "unsure it's worth it",
    text: "Real enough, but I can't tell whether it's worth keeping.",
    appliesTo: ["inconclusive"],
  },
  {
    // The row genuinely restates another candidate. The natural partner to the
    // `duplicate` action, which otherwise has only already-known offered on it.
    code: "same-as-another",
    label: "same as another item",
    text: "Says the same thing as another candidate already in the queue.",
    appliesTo: ["duplicate"],
  },
] as const;

/** Fast lookup by code. Built once; the list is a module constant. */
const BY_CODE = new Map(GRADING_REASONS.map((r) => [r.code, r]));

/** Every valid reason code. Exported for tests and for the 400 message. */
export const REASON_CODES: readonly string[] = GRADING_REASONS.map(
  (r) => r.code,
);

/** Look one up. Undefined for an unknown code -- callers reject, never coerce. */
export function findReason(code: string): GradingReason | undefined {
  return BY_CODE.get(code);
}

/**
 * The reasons offered for one action.
 *
 * The page filters its buttons through this so the operator sees four to six
 * relevant reasons instead of twelve mostly-irrelevant ones. Server-side
 * validation deliberately does NOT apply this filter -- see
 * `parseReasonCode` -- because appliesTo is an attention aid, not a data rule.
 */
export function reasonsFor(action: ReviewAction): readonly GradingReason[] {
  return GRADING_REASONS.filter((r) => r.appliesTo.includes(action));
}

/**
 * The agent-behavior vocabulary. Closed set, CHECKed in 042.
 *
 * Three values because three is the whole space of the question the operator
 * asked -- "a good interaction and things to keep doing, or i'm pissed and the
 * agent did the wrong thing" -- plus the unremarkable middle. There is no fourth
 * answer to add later, which is why 042 can afford a CHECK constraint here while
 * reason_code deliberately has none.
 */
export const AGENT_BEHAVIORS = ["good", "bad", "neutral"] as const;

export type AgentBehavior = (typeof AGENT_BEHAVIORS)[number];

/** Button text for each behavior, so page and any future report agree. */
export const AGENT_BEHAVIOR_LABELS: Record<AgentBehavior, string> = {
  good: "agent did well",
  bad: "agent did wrong",
  neutral: "unremarkable",
};

/**
 * Everything the page needs, as one JSON-serializable payload.
 *
 * The page is a hand-written HTML string with no bundler (see grading-page.ts),
 * so the only way it can share this module is by having the values inlined at
 * build time. Serializing from here rather than hand-copying the array into the
 * template is what makes "one definition" true rather than aspirational.
 */
export const GRADING_REASON_PAYLOAD = {
  reasons: GRADING_REASONS,
  behaviors: AGENT_BEHAVIORS,
  behaviorLabels: AGENT_BEHAVIOR_LABELS,
};
