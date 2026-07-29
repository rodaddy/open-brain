/**
 * The REM grading prompt — round three. Issue #435.
 *
 * WHERE THIS CAME FROM. Round two measured 6 prompts x 5 model/effort configs
 * over the same 50 real exchanges: 30 nodes, 1,037,106 subagent tokens, 8.5
 * minutes. Results and findings are recorded at
 * `_plans/435-436-dream-hosted-rem.md:201-239`. That document specifies round
 * three exactly, and this file is that specification and nothing more:
 *
 *   "p1's anchoring + p4's quote/label mechanism + p6's canned replies, on
 *    terra low. One prompt combining the three things that measurably worked."
 *
 * The three source prompts are quoted verbatim from the round-two workflow so
 * the composition is traceable rather than reconstructed from a summary.
 *
 * WHAT EACH PIECE IS DOING, and the measurement behind it:
 *
 *   ANCHORING (from p1). Worked examples pinning 10/7/3/0. p1 was the only
 *   prompt where all four model configs both used the full 0-10 range AND
 *   agreed on the mean (4.4-5.4). Round one's best was 7 distinct values with
 *   means scattered. Anchoring is what fixes scale saturation.
 *
 *   QUOTE-THEN-LABEL (from p4). Quote the operator's most important sentence,
 *   label it, THEN score — and the score must be justified by the quote. This
 *   is what stops a high score with nothing behind it, and the quote is
 *   directly useful on the review page.
 *
 *   CANNED REPLIES (from p6). 2-4 terse, item-specific phrases in the
 *   operator's voice for agreeing or disagreeing with the score. This is the
 *   operator's commenting mechanism on the generated page, not decoration.
 *
 * THE ONE THING DELIBERATELY LEFT OUT — READ BEFORE ADDING IT BACK. The
 * operator's standing rules ("everything passes", "I'd rather more not good
 * shit get in", "sometimes me saying okay is the equivalent of doubt") are NOT
 * used as a scoring rubric. Measured, round two finding #2
 * (`_plans/435-436-dream-hosted-rem.md:226-229`): p5 fed those rules as the
 * rubric and inflated harder than any other prompt — mean 8.4 on luna-low, 8.2
 * on terra-low. "Everything passes" reads to a grader as "score everything
 * high."
 *
 * Those rules are correct as INGEST POLICY and wrong as a SCORING instruction.
 * p6 carried them too, so here they inform only the canned replies — what the
 * operator might say — never the number. If a future change puts them back in
 * front of the score, it is re-running a measured failure.
 *
 * WHAT THE SCORE IS NOT. It is not a filter. Under the 2026-07-28 "let
 * everything pass" decision (`src/candidate-review.ts:23-29`), the queue
 * predicate is `reviewed_at IS NULL` and `machine_grade` affects sort order
 * only. A low score never suppresses an item; it just sinks it. REM writes
 * `machine_grade`, never `review_action` — that separation is structural
 * (`src/dream-rem.ts:12-13`, `037_candidate_memory_uncertainty.sql:43-46`), and
 * the disagreement between the two IS the metric that tunes this prompt.
 *
 * ACCURACY EXPECTATION, set by the operator 2026-07-29: this does not need to
 * be an 80-95% match. It needs to be close enough to be worth correcting. The
 * operator reviews every interaction on the page regardless; a wrong guess
 * costs a click, and the disagreement it produces is training data.
 */

/**
 * The unit being graded, and why it is shaped this way.
 *
 * An exchange is HEADED BY THE OPERATOR'S TURN (`feat(041)`: "re-cut the
 * extraction unit so the operator's turn heads it"), followed by what the agent
 * put on screen, then any tool calls used to get there. That order is the unit
 * the operator actually judges — the interaction, not the artifact.
 *
 * AN AskUserQuestion ANSWER IS AN OPERATOR TURN. Settled in `feat(043)`
 * ("AskUserQuestion answers head exchanges, badged as AUQ") and carried in the
 * schema as `anchor_kind='askuserquestion'`. It looks agent-initiated because
 * the agent raised the question, but the operator had to stop and choose, so
 * the choice is his. It anchors an exchange exactly like a typed turn.
 */
const UNIT_SHAPE = `Each item is one INTERACTION, in this order:
  1. the OPERATOR's turn -- what he typed, or the option he chose
  2. "agent:" lines -- what the agent put on his screen in reply
  3. "tool:" lines -- tool calls used to get there, if any

An item marked [AskUserQuestion] is an OPERATOR turn, not an agent turn. The
agent had to stop and ask; the operator had to choose. The choice is his, and
it is a decision by construction -- score it as operator speech unless the
answer was an explicit non-answer.`;

/**
 * The anchored scale, verbatim from round two's p1.
 *
 * The examples are real operator turns from this corpus. Keep them real: an
 * invented example calibrates the model against fiction, and the whole point of
 * anchoring is that these are the actual distribution.
 */
const ANCHORS = `The scale is ANCHORED by these examples -- calibrate against them:
  10 = "never do timeout waits, correct subagents that use workflows are ALWAYS
       better" -- a durable rule that changes future behavior.
   7 = "we also keep all three in the different dream states, is that not
       right?" -- a design question that pins down an architectural fact.
   3 = "are those the new issues from today" -- a real question, but the answer
       is transient and re-derivable.
   0 = a bare path, an acknowledgement with no content, or pure tool output.`;

/**
 * The operator's standing rules — for the CANNED REPLIES only.
 *
 * Verbatim from round two, in his own words. See the header: these must never
 * reach the scoring instruction. They are here so the canned replies sound like
 * something he would actually click, which is the only job they have.
 */
const OPERATOR_VOICE = `The operator's standing positions, in his own words --
use these ONLY to phrase the canned replies, never to set the score:
- "everything passes" at ingest; the tier system filters later, reversibly.
- "I'd rather more not good shit get in than any shit that should be there not
  get in." Recall beats precision.
- "sometimes me saying okay is the equivalent of doubt." A two-word operator
  turn can carry the whole signal. NEVER score on length.
- What matters is the INTERACTION: what the operator asked and what the agent
  did about it.`;

/** The instruction block sent with every batch. */
export const REM_GRADING_PROMPT = `${UNIT_SHAPE}

Do four things for each item, in order.

1. QUOTE: find the single most important sentence the OPERATOR said. If he said
   nothing substantive, use an empty string.
2. LABEL: classify as exactly one of DECISION, CORRECTION, PREFERENCE,
   QUESTION, NARRATION.
3. SCORE: rate 0-10 how valuable the quoted sentence is to remember long-term.
   ${ANCHORS}
   The score must be justified by the quote and the label. Do not score high
   without a quote that supports it.
4. CANNED REPLIES: 2-4 short phrases the operator could click to record WHY he
   agrees or disagrees with your score. They must be specific to THIS item, not
   generic, and written as he would say them, terse.
   Examples of the shape wanted:
     ["keeps a rule I'd forget", "already covered elsewhere", "only mattered that day"]
     ["agent got this wrong, worth keeping", "my ask was vague", "fine, routine"]

${OPERATOR_VOICE}

RULES:
- Grade every item you are given, using the ids from the input.
- Use the FULL 0-10 range where warranted. Do not compress toward one value and
  do not spread artificially -- report what you actually judge.
- Ignore lines beginning "tool:" when scoring, unless the operator's turn is
  only intelligible with them.
- Return everything through the structured output. Do NOT write files.`;

/**
 * Structured return contract, carried over from round two unchanged.
 *
 * Schema-validated at the tool-call layer so a malformed return is retried by
 * the model rather than silently parsed into a null grade. Round one lost items
 * to parse failures; round two lost none where the schema was enforced.
 *
 * `score` is an integer 0-10 here. `machine_grade` in the database is the
 * four-value review vocabulary (promoted/rejected/duplicate/inconclusive) per
 * `037`, so the mapping from score to grade belongs in the RemGrader
 * implementation, not in the prompt. The model reports judgement; the code
 * decides what that means for the column.
 */
export const REM_GRADING_SCHEMA = {
  type: "object",
  required: ["grades"],
  properties: {
    grades: {
      type: "array",
      description: "One entry per input item, same order, same ids",
      items: {
        type: "object",
        required: ["id", "score", "label", "quote"],
        properties: {
          id: { type: "string" },
          score: { type: "integer", minimum: 0, maximum: 10 },
          label: {
            type: "string",
            enum: [
              "DECISION",
              "CORRECTION",
              "PREFERENCE",
              "QUESTION",
              "NARRATION",
            ],
          },
          quote: { type: "string" },
          canned_replies: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 4,
          },
        },
      },
    },
  },
} as const;

/**
 * The model round two selected, and the reason it is `low`.
 *
 * Terra low == Terra med, measured: 11 distinct score values on both, means 5.0
 * vs 5.2 (`_plans/435-436-dream-hosted-rem.md:230-231`). The extra thinking
 * budget bought nothing, so low is the REM model. Sonnet low deflated across
 * every prompt and lost items -- 46 and 49 of 50 on p4/p6, and it returned 51
 * on p3, meaning it invented an id.
 */
export const REM_MODEL = "gpt-5.6-terra" as const;
export const REM_EFFORT = "low" as const;
