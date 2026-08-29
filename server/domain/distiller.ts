/**
 * DISTILL -- raw turns into candidate_memory proposals. Issue #382.
 *
 * This is the stage the whole pipeline was waiting on. Measured on the live
 * dogfood clone 2026-07-28: ob_raw_turns held 3,795 rows, every one with
 * distilled_at IS NULL, and candidate_memory held 0. Capture worked; nothing
 * consumed it. Nothing downstream -- REM, Deep, the review page -- can run
 * against an empty table, so this module is the critical path.
 *
 * WHAT A ROW HERE IS. A PROPOSAL, never memory. 033_candidate_memory.sql:20-27
 * is explicit: nothing in candidate_memory is recalled, has authority, or is
 * promoted by being written. This module therefore writes content, provenance,
 * and doubt -- and never `review_action`, `reviewed_at`, or `graded_by`. Those
 * three are the operator's, and 037_candidate_memory_uncertainty.sql:43-57
 * explains why in structural rather than stylistic terms: review_action is
 * paired to reviewed_at by constraint, so any machine writing it silently
 * removes the item from the human queue.
 *
 * THE GOVERNING DECISION (operator, 2026-07-28): let everything pass. Nothing
 * is pre-filtered on a guess. The extractor is deliberately GENEROUS, and where
 * it is unsure it sets `uncertain = true` with a reason and emits the candidate
 * anyway. The rationale is the same asymmetry that removed the length floor
 * from Light (src/dream-light.ts:159-190): the tier system is the precision
 * filter, applied later, reversibly, on months of usage evidence. Content that
 * never entered has no usage history to be judged by and no path back.
 *
 * THE MODEL IS AN INJECTED DEPENDENCY, and that is not merely good hygiene --
 * it is forced by the environment. There is no generation endpoint available:
 * 127.0.0.1:8791 serves embeddings only (docs/full-send-derivation-spec.md:212)
 * and LiteLLM is banned. A hardcoded HTTP client would therefore be a hardcoded
 * client to nothing. So {@link DistillModel} is the seam, and
 * {@link ruleBasedDistiller} is a real, deterministic implementation of it that
 * runs tonight with zero model access.
 *
 * A rule-based extractor is not a placeholder standing in for the "real" one.
 * It is the measurement baseline: the 2026-07-24 Qwen3.5-4B-4bit run mislabelled
 * 112 of 214 candidates as `preference` (docs/dream-design.md:230-239), so
 * "a model would do better" is a hypothesis, and the only way to test it is to
 * grade both against the same corpus. This gives the grading page something to
 * grade on day one.
 */

import type { BackgroundTraceRecorder } from "../../src/background-tracing.ts";
import { contentHash } from "../../src/embedding.ts";
import { isHarnessNoise } from "../../src/tools/ingest-raw-turn.ts";
import type { DistillTurn, DistillUnit } from "./distill-window.ts";

/**
 * The candidate taxonomy, exactly as constrained by
 * 033_candidate_memory.sql:98-99. Wider than GRADUATE_TYPES on purpose -- see
 * that migration's comment on why a correction is captured even though
 * promotion has no path for it yet (#431).
 */
export const CANDIDATE_TYPES = [
  "decision",
  "correction",
  "fact",
  "preference",
] as const;
export type CandidateType = (typeof CANDIDATE_TYPES)[number];

/** One proposal, before it is written. Content is already redacted at source. */
export interface DistillCandidate {
  candidate_type: CandidateType;
  content: string;
  /**
   * The turns this claim was made in. Cardinality > 0 is a table constraint
   * (033_candidate_memory.sql:112-113) and an auditability requirement: a
   * candidate with no source cannot be re-derived or checked.
   *
   * This holds the CURRENT turn only. Context turns made the claim readable;
   * they did not make it. Attributing them here would make provenance a lie and
   * would make the reverse-provenance index (idx_candidate_memory_source_turns)
   * return every candidate that merely happened nearby.
   */
  source_turn_ids: string[];
  /** Did the producer doubt this? ADVISORY only -- it never gates the write. */
  uncertain: boolean;
  /** Why it was doubted. What makes the flag actionable to a reviewer. */
  uncertainty_reason?: string;
}

/** What the model is asked to extract from. */
export interface DistillRequest {
  /** The one turn to extract from. */
  current: DistillTurn;
  /** Preceding turns, READ-ONLY context. Never a source of candidates. */
  context: readonly DistillTurn[];
}

export interface DistillResponse {
  candidates: DistillCandidate[];
  /** Provider-reported usage for an LLM-backed extractor. */
  usageDetails?: Record<string, number>;
}

/**
 * The extraction seam.
 *
 * An implementation MUST honour one rule, borrowed from graphiti
 * (graphiti_core/prompts/extract_nodes_and_edges.py:8, "Only extract entities
 * from CURRENT MESSAGES - PREVIOUS MESSAGES are context only"): every returned
 * candidate's `source_turn_ids` contains `request.current.id` and nothing else.
 * {@link runDistillUnit} enforces this rather than trusting it, because a model
 * that quietly attributes context turns would corrupt provenance in a way that
 * is invisible until someone audits a candidate months later.
 */
export type DistillModel = (req: DistillRequest) => Promise<DistillResponse>;

/** Names the producer in `candidate_memory.model`. Required for ethereal-run comparison. */
export interface NamedDistillModel {
  name: string;
  /** Set only for a server-side LLM implementation; deterministic rules stay spans. */
  observationType?: "generation";
  extract: DistillModel;
}

// --------------------------------------------------------------------------
// The rule-based extractor
// --------------------------------------------------------------------------

/**
 * Tool-call stubs and structural markers. Real content that ingest correctly
 * stored, carrying no claim.
 *
 * Measured 2026-07-28: 1,325 of 2,172 assistant turns (61%) are `[tool_use: X]`
 * stubs left by transcript flattening -- raw-turns.ts records that a tool ran
 * and discards the input. They are legitimately in the corpus (the fact a tool
 * ran is part of the reply chain) and they are useful as WINDOW CONTEXT, but a
 * candidate whose content is "[tool_use: Bash]" is not a claim about anything.
 *
 * Same shape as Light's UNCOUNTABLE (src/dream-light.ts:88-95), deliberately
 * duplicated rather than shared: Light decides what to COUNT, this decides what
 * to EXTRACT FROM. Coupling them would mean a change to one silently retunes
 * the other, and they answer different questions.
 */
const NO_CLAIM_PATTERNS: readonly RegExp[] = [
  /^\[tool_use:\s*[^\]]*\]$/i,
  /^\[tool_result[^\]]*\]$/i,
  /^\[(?:image|attachment|file)[^\]]*\]$/i,
];

function carriesNoClaim(text: string): boolean {
  return NO_CLAIM_PATTERNS.some((p) => p.test(text.trim()));
}

/**
 * Bare acknowledgement shapes -- the SHORT operator turns.
 *
 * These are NOT dropped. Per the governing decision they are emitted as
 * `decision` candidates flagged uncertain, because src/dream-light.ts:161-176
 * establishes measured-from-the-corpus why: a few characters can be the whole
 * decision, converting a proposal into an authorization, and the same string is
 * assent after one turn and doubt after another. Only the surrounding turns
 * distinguish them -- which is exactly what the context window supplies and
 * what the reviewer will see on the grading page.
 *
 * Measured 2026-07-28 across 263 operator turns: median length 100 characters,
 * with a real tail of sub-16-character turns ("go", "go for it", "try it").
 */
const ACK_RE =
  /^(?:ok(?:ay)?|k|yes|yep|yeah|ya|sure|go|go ahead|go for it|do it|try it|run it|proceed|continue|correct|right|exactly|perfect|nice|great|good|thanks|thank you|ty|got it|understood|agreed|approved|lgtm|ship it|send it|yup|sounds good|makes sense|\.|\+1)\b[\s.!,]*$/i;

/**
 * Correction markers in operator speech.
 *
 * Grounded, not guessed: measured 2026-07-28, 155 of 263 operator turns (59%)
 * contain at least one of these stems. That high a hit rate is why the
 * resulting candidates are flagged uncertain -- a marker proves the turn is
 * ARGUING with something, not that the extractor identified what.
 */
const CORRECTION_RE =
  /\b(?:no,|nope|wrong|incorrect|not (?:that|what|it|right|true)|don'?t|do not|never|stop|actually|instead|rather than|that'?s not|isn'?t|shouldn'?t|mistake|fix that|undo|revert|i said|you (?:didn'?t|missed|broke|forgot))\b/i;

/**
 * Decision / directive markers.
 *
 * Deliberately includes bare imperatives ("use X", "switch to Y") because the
 * operator's decisions in this corpus are overwhelmingly phrased as commands
 * rather than as "I have decided that".
 */
const DECISION_RE =
  /\b(?:decid|decision|we(?:'| a)?re going with|going with|let'?s|lets |i want|i'?d like|from now on|going forward|the rule is|must|should|use |switch|move (?:it|that|this) to|make (?:it|that|this)|set |always|by design|on purpose|deliberat)\b/i;

/**
 * Preference markers -- taste and standing policy rather than a point decision.
 *
 * NARROW on purpose. `preference` was the 2026-07-24 run's failure mode: 112 of
 * 214 candidates were mislabelled with it, including an OAuth redirect URI and
 * a Caddyfile procedure (docs/dream-design.md:230-239). A wide preference rule
 * reproduces exactly that error, so this one requires an explicit statement of
 * liking or disliking and everything else falls through to decision or fact.
 */
const PREFERENCE_RE =
  /\b(?:i (?:prefer|like|love|hate|don'?t like|dislike|want)\b|prefer\b|rather have|my preference|i'?m not a fan|pet peeve|drives me (?:nuts|crazy))/i;

/**
 * Assistant turns that report a checkable outcome rather than narrate intent.
 *
 * Grounded in the corpus shape: assistant speech turns split cleanly into
 * results ("2370 pass, 0 fail", "Committed `caabc14`, clean tree") and
 * narration ("Let me see what the results page gives me", "Checking the..."),
 * and only the first kind states something durable.
 */
const RESULT_RE =
  /\b(?:pass(?:ed|ing|es)?|fail(?:ed|ing|s)?|confirmed|verified|committed|landed|works?|working|fixed|done|complete|green|clean|found|resolved|reproduc|root cause|turns out|the (?:answer|reason|cause|bug) is|measured|zero |0 fail)\b/i;

/**
 * Narration markers -- the assistant announcing what it is ABOUT to do.
 *
 * Measured in the corpus as the dominant assistant speech shape ("Let me get
 * them properly.", "Running the counts.", "Testing the ledger commands."). A
 * statement of intent is not a durable fact, so these are emitted uncertain
 * rather than confidently -- still emitted, per the governing decision.
 */
const NARRATION_RE =
  /^(?:let me|i'?ll|i am going to|i'?m going to|now |next,? |checking|running|testing|looking|reading|trying|writing|building|starting|verifying)\b/i;

/**
 * How much one rendered part holds before ANOTHER PART BEGINS.
 *
 * renderExchangeParts (distill-exchange.ts) packs whole turns up to this size
 * and then starts the next part, so a large exchange becomes several linked
 * parts and keeps every turn. Per the operator: "It's there so if something's
 * too big it can split it up over multiple entries properly. That's the whole
 * reason why I set it up that way."
 *
 * Renamed on 2026-07-30, when the helper beside it that shortened a
 * candidate's stored text and appended a marker was deleted. That helper
 * justified itself by saying src/embedding.ts refused input over 32,000
 * characters; measurement that day showed the configured embedder accepts far
 * more, and long text is now embedded in overlapping segments instead. On the
 * live clone, 740 of 5,434 stored candidates carried that helper's marker.
 *
 * Rendering decides how a review page is laid out. Storage keeps what was said.
 */
export const CANDIDATE_PART_CHARS = 4000;

/** Collapse the whitespace a transcript carries so a review page reads cleanly. */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A short, human-readable trace of what the claim followed.
 *
 * Attached ONLY to acknowledgement candidates, and only from the nearest
 * preceding speech turn. Without it, a stored candidate reading "go for it" is
 * unreviewable -- the reviewer would have to go fetch the source turns to learn
 * what was authorized. Bounded hard because this is context, not the claim.
 */
function nearestSpeechContext(context: readonly DistillTurn[]): string | null {
  for (let i = context.length - 1; i >= 0; i--) {
    const t = context[i];
    if (t === undefined) continue;
    if (t.role !== "user" && t.role !== "assistant") continue;
    const text = normalizeWhitespace(t.content);
    if (text.length === 0 || carriesNoClaim(text)) continue;
    return text.length > 300 ? `${text.slice(0, 300).trimEnd()}…` : text;
  }
  return null;
}

/**
 * The deterministic, model-free extractor. The default {@link DistillModel}.
 *
 * GENEROUS BY CONSTRUCTION: every speech turn that carries any claim at all
 * yields exactly one candidate. There is no scoring, no threshold, and no
 * "probably not worth it" branch -- those are precisely the pre-filters the
 * governing decision of 2026-07-28 removed. What the extractor is unsure about
 * it records in `uncertain` / `uncertainty_reason` and emits regardless.
 *
 * One candidate per turn, not several: splitting a turn into multiple claims
 * requires understanding it, which is the job of the model this seam exists to
 * accept. Emitting the turn as one claim is the honest rule-based answer and
 * keeps `content_hash` dedupe meaningful.
 */
export const RULE_BASED_DISTILLER_NAME = "rule-based-distiller/v1";

export const ruleBasedDistiller: NamedDistillModel = {
  name: RULE_BASED_DISTILLER_NAME,
  extract: async (req: DistillRequest): Promise<DistillResponse> => {
    const turn = req.current;
    const text = normalizeWhitespace(turn.content);

    // Nothing to make a claim out of. These are the only two rejections in the
    // whole extractor, and neither is a salience judgement: harness noise is
    // scaffolding ingest should not have stored (ingest-raw-turn.ts:55-64), and
    // a tool-call stub has had its content discarded upstream. Rejecting an
    // EMPTY string is not the same act as rejecting a SHORT one.
    if (text.length === 0 || isHarnessNoise(text) || carriesNoClaim(text)) {
      return { candidates: [] };
    }

    const classified =
      turn.role === "user"
        ? classifyOperatorTurn(text, req.context)
        : classifyAssistantTurn(text);

    return {
      candidates: [
        {
          candidate_type: classified.type,
          content: classified.content,
          source_turn_ids: [turn.id],
          uncertain: classified.uncertain,
          ...(classified.reason ? { uncertainty_reason: classified.reason } : {}),
        },
      ],
    };
  },
};

interface Classified {
  type: CandidateType;
  content: string;
  uncertain: boolean;
  reason?: string;
}

/**
 * Operator speech. The operator is the authority in this corpus, so their turns
 * default to `decision` rather than `fact`: a directive from Rico is a decision
 * even when phrased as an observation, and 033_candidate_memory.sql:20-27 makes
 * clear the type is a claim about KIND, not about authority.
 */
function classifyOperatorTurn(
  text: string,
  context: readonly DistillTurn[],
): Classified {
  // Bare acknowledgement. The context turn is what it authorized, so it is
  // carried INTO the content -- otherwise the candidate is unreviewable.
  if (ACK_RE.test(text)) {
    const prior = nearestSpeechContext(context);
    return {
      type: "decision",
      content: prior
        ? `Operator approved: "${text}"\n\nIn response to: ${prior}`
        : `Operator said: "${text}"`,
      uncertain: true,
      reason: prior
        ? "short acknowledgement -- reads as authorization of the preceding turn, but assent and doubt are the same string and only the reviewer can tell which"
        : "short acknowledgement with no preceding speech turn in the window -- what it responds to is unknown",
    };
  }

  if (CORRECTION_RE.test(text)) {
    return {
      type: "correction",
      content: text,
      uncertain: true,
      reason:
        "matched a correction marker -- the turn is arguing with something, but a rule cannot tell what was corrected or whether the correction stuck",
    };
  }

  if (PREFERENCE_RE.test(text)) {
    return {
      type: "preference",
      content: text,
      uncertain: false,
    };
  }

  if (DECISION_RE.test(text)) {
    return { type: "decision", content: text, uncertain: false };
  }

  // Fell through every marker. Still emitted -- an operator turn with no marker
  // is often a question or a piece of background, and both can be durable.
  return {
    type: "decision",
    content: text,
    uncertain: true,
    reason:
      "operator turn with no decision, correction, or preference marker -- captured because operator speech is authoritative, but the kind of claim is unresolved",
  };
}

/** Assistant speech. Defaults to `fact`: the assistant reports, it does not decide. */
function classifyAssistantTurn(text: string): Classified {
  if (NARRATION_RE.test(text) && !RESULT_RE.test(text)) {
    return {
      type: "fact",
      content: text,
      uncertain: true,
      reason:
        "assistant narration -- states intent rather than an outcome, so whether it happened is not established by this turn",
    };
  }

  if (CORRECTION_RE.test(text)) {
    return {
      type: "correction",
      content: text,
      uncertain: true,
      reason:
        "assistant turn matched a correction marker -- may be self-correction, may be restating the operator's correction (mem0's asymmetry rule: an assistant turn confirming what the operator already said is not a new claim)",
    };
  }

  if (RESULT_RE.test(text)) {
    return { type: "fact", content: text, uncertain: false };
  }

  return {
    type: "fact",
    content: text,
    uncertain: true,
    reason:
      "assistant turn with no clear outcome marker -- captured, but whether it states anything durable is unresolved",
  };
}

// --------------------------------------------------------------------------
// Unit-level driver
// --------------------------------------------------------------------------

/** A candidate that has cleared the provenance and content guards. */
export interface PreparedCandidate extends DistillCandidate {
  namespace: string;
  content_hash: string;
  model: string;
}

/**
 * Run one unit through the model and validate what comes back.
 *
 * The guards are here rather than at the write, because a violation is a
 * PRODUCER bug and must be attributable to the producer. In order:
 *
 *  - provenance: every candidate's source_turn_ids is forced to exactly the
 *    current turn. A model attributing context turns is silently corrupting the
 *    audit trail, so the value is REPLACED rather than rejected -- dropping the
 *    candidate would lose real content over a provenance error, which inverts
 *    the governing decision.
 *  - type: an unknown candidate_type would violate
 *    candidate_memory_type_check. Coerced to the role's default rather than
 *    dropped, same reasoning.
 *  - content: empty content violates candidate_memory_content_check. This one
 *    IS dropped, because there is nothing to keep.
 */
export async function runDistillUnit(
  model: NamedDistillModel,
  unit: DistillUnit,
  trace?: BackgroundTraceRecorder,
): Promise<PreparedCandidate[]> {
  const request = {
    current: unit.current,
    context: unit.context,
  };
  const observe = () => model.extract(request);
  const options = {
    input: {
      current_turn_id: unit.current.id,
      context_turn_ids: unit.context.map((turn) => turn.id),
    },
    output: (response: DistillResponse) => ({
      candidate_ids: response.candidates.map(
        (_candidate, index) => `${unit.current.id}:${index}`,
      ),
      candidate_hashes: response.candidates.map((candidate) =>
        contentHash(normalizeWhitespace(candidate.content ?? "")),
      ),
      candidate_count: response.candidates.length,
    }),
    metadata: { namespace: unit.current.namespace },
  };
  const response =
    trace && model.observationType === "generation"
      ? await trace.generation("distill.extract", observe, {
          ...options,
          model: model.name,
          usageDetails: (result) => result.usageDetails,
        })
      : trace
        ? await trace.span("distill.extract", observe, options)
        : await observe();

  const out: PreparedCandidate[] = [];
  for (const candidate of response.candidates) {
    const content = normalizeWhitespace(candidate.content ?? "");
    if (content.length === 0) continue;

    const type: CandidateType = (CANDIDATE_TYPES as readonly string[]).includes(
      candidate.candidate_type,
    )
      ? candidate.candidate_type
      : unit.current.role === "user"
        ? "decision"
        : "fact";

    out.push({
      namespace: unit.current.namespace,
      candidate_type: type,
      content,
      // contentHash is the SAME function ingest applies to turns
      // (src/tools/ingest-raw-turn.ts:125) and the one content_occurrences
      // keys on, so a candidate hash and a turn hash are directly comparable.
      content_hash: contentHash(content),
      // Forced, not trusted -- see the provenance guard note above.
      source_turn_ids: [unit.current.id],
      uncertain: Boolean(candidate.uncertain),
      ...(candidate.uncertainty_reason
        ? { uncertainty_reason: candidate.uncertainty_reason }
        : {}),
      model: model.name,
    });
  }
  return out;
}
