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
 *
 * ADDED AFTER ROUND TWO, and NOT measured by it — the asymmetry the operator
 * named on 2026-07-29. Round two measured p1/p4/p6 as scoring prompts; tasks 4
 * and 5 below are new, so the composition as a whole is UNVERIFIED against a
 * bake-off. That is an argument for the 50-item pilot before the full 1,827,
 * not against the change.
 *
 *   THE TOOL CHAIN IS ASYMMETRIC. Terra reads all of it; the operator reads
 *   none of it. "I just need a synopsis. I don't need the entire tool called
 *   chain, but Terra on the other hand can take the entire tool called chain
 *   and make something useful of it. I'm not going to read it." So the earlier
 *   "ignore tool: lines" instruction was removed — it told the grader to
 *   discard exactly what it is best placed to use — and the synopsis exists to
 *   be what the operator reads in its place.
 *
 *   CANNED REPLIES ARE A TYPING-COST FIX, NOT A CORRECTNESS FIX. "I don't need
 *   Terra to be right or you to be right. I just need options that make logical
 *   sense in the pre-canned things, so I don't have to sit here and manually
 *   type out sentence after sentence." They are therefore spread across the
 *   plausible reactions rather than argued for one, and they became REQUIRED
 *   (min 3) rather than optional.
 *
 * HOW THESE RELATE TO THE FIXED reason_code VOCABULARY (`grading-reasons.ts`,
 * migration 042) — they are different axes and both are kept:
 *
 *   reason_code   why the OPERATOR disagrees. Fixed list, stable code, so
 *                 "which defect does he hit most" is a GROUP BY. 042's header
 *                 has the measurement: his 8 real notes were five sentences
 *                 expressing three ideas, retyped with a typo and a new
 *                 phrasing each time, sharing not one word — ungreppable.
 *   canned_replies why TERRA scored it that way. Generated per item, prose,
 *                 NO code — they are a starting point for his note, never an
 *                 aggregation key. Generating codes here would reintroduce
 *                 exactly the 1,827-unique-strings problem 042 killed.
 *
 * Both fill the same editable note textarea on click, which is the interaction
 * 042 already established at his request: "so the can'd response if i click
 * one, should allow me to put it into the notes for adjustment".
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
  3. "tool:" lines -- the tool calls used to get there

An item marked [AskUserQuestion] is an OPERATOR turn, not an agent turn. The
agent had to stop and ask; the operator had to choose. The choice is his, and
it is a decision by construction -- score it as operator speech unless the
answer was an explicit non-answer.

READ THE ENTIRE TOOL CHAIN. You get it in full because you can use it and the
operator will not read it. Operator, 2026-07-29: "Terra on the other hand can
take the entire tool called chain and make something useful of it. I'm not
going to read it." What the agent actually DID lives in those calls -- "I
verified X" with a query behind it is a different event from the same sentence
with nothing behind it. Your synopsis is what the operator reads instead.`;

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

Do six things for each item, in order.

1. QUOTE: find the single most important sentence the OPERATOR said. If he said
   nothing substantive, use an empty string.
2. LABEL: classify as exactly one of DECISION, CORRECTION, PREFERENCE,
   QUESTION, NARRATION.
3. SCORE: rate 0-10 how valuable the quoted sentence is to remember long-term.
   ${ANCHORS}
   The score must be justified by the quote and the label. Do not score high
   without a quote that supports it.
4. SYNOPSIS: ONE line -- what the agent actually did in response, read off the
   tool chain. This replaces the chain for the operator, so it must carry what
   he would have learned by reading it: what was run, what came back, whether
   the agent's claims are backed by it. "Ran three greps, found nothing, said
   it was missing" is useful. "Investigated the issue" is not -- that is the
   agent's own summary restated, which he can already see.
5. AGENT_BEHAVIOR: "good", "bad", or "neutral" -- did the agent do the right
   thing? good = it did what was asked, or correctly pushed back. bad = the
   operator is visibly frustrated, correcting a mistake, or the agent did the
   wrong thing. neutral = routine. This is INDEPENDENT of the score: a
   high-value memory often records BAD agent behavior, and those are among the
   most worth keeping because they record what not to repeat.
6. CANNED REPLIES: 3-4 short phrases the operator clicks INSTEAD OF TYPING.

   THE JOB IS TO SAVE HIM TYPING, NOT TO BE RIGHT. Operator, 2026-07-29: "I
   don't need Terra to be right or you to be right. I just need options that
   make logical sense in the pre-canned things, so I don't have to sit here and
   manually type out sentence after sentence." He types only when the options
   are bad or he wants to say something with force.

   So SPREAD them across the plausible reactions to THIS item -- do not write
   three phrasings of the same opinion:
     - one for agreeing with your score, naming the reason
     - one or two for the obvious ways your score is wrong (too high, too low)
     - one for "this matters, but for a different reason than you gave"
   Terse, specific to this item, in his register. Not generic.
   Examples of the shape wanted:
     ["keeps a rule I'd forget", "already covered elsewhere", "only mattered that day"]
     ["agent got this wrong, worth keeping", "my ask was vague", "fine, routine"]

${OPERATOR_VOICE}

RULES:
- Grade every item you are given, using the ids from the input.
- Use the FULL 0-10 range where warranted. Do not compress toward one value and
  do not spread artificially -- report what you actually judge.
- Read the whole tool chain. Score the OPERATOR's words; use the chain to write
  the synopsis and to judge agent_behavior.
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
        required: [
          "id",
          "score",
          "label",
          "quote",
          "synopsis",
          "agent_behavior",
          "canned_replies",
        ],
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
          /** One line: what the agent DID, read off the tool chain. */
          synopsis: { type: "string" },
          /** Matches candidate_grade.agent_behavior (migration 042). */
          agent_behavior: {
            type: "string",
            enum: ["good", "bad", "neutral"],
          },
          /**
           * REQUIRED, and at least three. Optional in round two, where a model
           * that skipped them cost nothing. Here they are the operator's
           * click-instead-of-type path, so an item returning none is an item he
           * has to hand-write -- which is the exact cost this exists to remove.
           */
          canned_replies: {
            type: "array",
            items: { type: "string" },
            minItems: 3,
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
