/**
 * EXCHANGE distillation -- the operator's turn heads every unit. Migration 041.
 *
 * THE DEFECT THIS REPLACES, measured on the live clone 2026-07-28 by joining
 * each candidate to the turn its source_turn_ids[1] names:
 *
 *   candidate_type | from operator turn | from agent turn
 *   decision       |        166         |       0
 *   correction     |         90         |     235
 *   fact           |          0         |     612
 *   preference     |          1         |       0
 *
 * 612 of 1,104 candidates are agent `fact` rows and NOT ONE traces to an
 * operator turn. That is not a classification bug to retune. src/distiller.ts
 * cuts ONE CANDIDATE PER SPEECH TURN, and 3,615 of 3,887 turns are the agent's
 * -- so a per-turn unit is dominated by the agent no matter what CORRECTION_RE
 * or RESULT_RE say. The ratio is the corpus shape, not the rules.
 *
 * The operator hit it live: the graded sentence was the AGENT's "Drizzle isn't a
 * dependency and there's no config -- planned, not in progress", while his own
 * turn ("I can't decide whether the DreamEngine curation logic should move to
 * TypeScript now or wait until after drizzle...") sat in the context panel,
 * ungraded. Grading the agent's middle sentence asks the operator to judge a
 * fragment of his own conversation.
 *
 * THE OPERATOR'S INSTRUCTION, verbatim (2026-07-28):
 *   "my part of the conversation should be the first thing, anything below that
 *    can be agent response and maybe tool calls to get there"
 *   "if I say my interaction is a yes, the surrounding agent calls should almost
 *    always auto go in"
 *   "then the decision is are they there a good interaction and things to keep
 *    doing, or i'm pissed and the agent did the wrong thing and don't do that"
 *
 * So the unit is the INTERACTION and the anchor is the operator's turn. One
 * grade covers the ask and what the agent did about it, which is the judgement
 * the operator is actually able to make.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not delete, update, or re-attribute the
 * existing 1,104 fragment rows, and it never writes review_action, reviewed_at,
 * graded_by, or machine_grade -- 037:43-57. The operator's 8 grades against
 * fragments are real measurements of the rule-based extractor and stay exactly
 * as they are; 041 marks the two populations apart so they can be compared.
 *
 * ORDERING KEY: (session_ref, occurred_at, id), the same expression
 * src/distill-window.ts:25-40 justifies at length. NOT session_seq directly --
 * re-measured 2026-07-28, 92 of 3,887 turns carry NULL session_seq because only
 * 036's one-shot backfill ever populated it and nothing on the insert path
 * assigns it. Cutting exchanges on a key that is NULL for 92 turns would drop
 * those turns into the wrong exchange or out of one entirely. The source
 * expression is still a perfect total order on the live corpus (3,887 turns,
 * 3,887 distinct (session_ref, occurred_at) pairs, zero ties).
 */

import { contentHash } from "./embedding.ts";
import { isHarnessNoise } from "./tools/ingest-raw-turn.ts";
import type { DistillTurn } from "./distill-window.ts";
import {
  CANDIDATE_TYPES,
  MAX_CANDIDATE_CHARS,
  type CandidateType,
} from "./distiller.ts";

/**
 * One exchange: the operator's turn, then everything that answered it.
 *
 * `anchor` is null ONLY for an orphan -- agent turns that appear before the
 * first operator turn of a session. Measured 2026-07-28: 10 of 32 sessions open
 * with agent turns and 7 sessions contain no operator turn at all, producing 17
 * orphan units against 272 anchored ones.
 */
export interface Exchange {
  /** The operator turn heading this exchange. Null for an orphan. */
  anchor: DistillTurn | null;
  /** Agent responses and tool calls that followed, in transcript order. */
  body: readonly DistillTurn[];
  /** Which session this was cut from. Carried so a caller can group without re-reading turns. */
  session_ref: string | null;
  /**
   * How the operator authored the head (migration 043).
   *
   * Derived from `anchor` by `anchorKindOf` and carried on the struct rather
   * than recomputed at each use, because `prepareExchange` may DEGRADE an
   * unusable anchor to an orphan -- and after that degrade the original turn is
   * gone, so a late recompute would report 'orphan' for a row whose anchor was
   * dropped and 'typed' for one whose anchor survived, with no way to tell the
   * two apart. Computing it once beside the anchor keeps the two in step.
   */
  anchor_kind: AnchorKind;
}

/**
 * An AskUserQuestion answer: the operator CHOSE rather than typed.
 *
 * The runtime delivers it as a `tool_result`, so it lands with `role='tool'` and
 * `is_human_prompt=false` -- indistinguishable, by those columns alone, from
 * command output. Measured 2026-07-28: 6 such turns in the corpus, every one
 * `role='tool'`, every one `is_human_prompt=false`.
 *
 * Left alone they become body text under whatever preceded them, so an explicit
 * operator decision reads as agent chatter. One of the six is the instruction to
 * leave `.claude/` untracked, which was acted on -- a decision by any definition.
 *
 * That is exactly the failure `tools/ingest-raw-turn.ts:23-25` records: capture
 * "had never once captured an AskUserQuestion answer -- the densest decision
 * content in the corpus".
 *
 * MATCHED ON CONTENT, and that is a known weakness. The prefix is a harness
 * string, not a contract, so a runtime that rewords it stops being detected.
 * `metadata` carries no marker for this shape today (checked 2026-07-28), so
 * there is nothing sturdier to key on yet. When ingest grows an explicit flag,
 * key on that and delete this. The prefix is anchored so operator prose merely
 * quoting the phrase mid-sentence cannot trip it.
 */
const AUQ_ANSWER_PREFIX = /^The user answered:/;

export function isAskUserQuestionAnswer(turn: DistillTurn): boolean {
  return (
    turn.role === "tool" && AUQ_ANSWER_PREFIX.test(turn.content.trimStart())
  );
}

/**
 * Is this the operator speaking?
 *
 * Two ways it can be true, and they are NOT equivalent evidence:
 *   - typed          the operator wrote it unprompted
 *   - askuserquestion the operator picked from options the AGENT authored
 *
 * Both head an exchange, because both are the operator deciding. They are told
 * apart by `anchorKindOf` rather than merged, since a menu choice is bounded by
 * the choices offered while a typed sentence is not -- the operator asked for
 * the distinction to stay visible: "that's kind of a hybrid and should be
 * treated more like it came from me i think, with that note that it is AUQ".
 */
function isOperatorTurn(turn: DistillTurn): boolean {
  return turn.is_human_prompt || isAskUserQuestionAnswer(turn);
}

/** How the operator authored this head. Null anchor means an orphan unit. */
export type AnchorKind = "typed" | "askuserquestion" | "orphan";

export function anchorKindOf(anchor: DistillTurn | null): AnchorKind {
  if (anchor === null) return "orphan";
  return anchor.is_human_prompt ? "typed" : "askuserquestion";
}

// --------------------------------------------------------------------------
// AskUserQuestion rendering
// --------------------------------------------------------------------------

/**
 * Trailing harness instruction on every AskUserQuestion tool_result.
 *
 * Verified byte-for-byte against all 6 live turns 2026-07-28 -- every one ends
 * with this exact sentence, em dashes and all. It is addressed to the AGENT, not
 * written by the operator, so leaving it in the rendered unit puts words in the
 * operator's mouth on the one row type that exists to carry HIS decision.
 */
const AUQ_TRAILER =
  /\s*Read the answers carefully\s*(?:--|—)\s*they may request clarification, changes, or that you not proceed\s*(?:--|—)\s*and follow what they actually say\.\s*$/;

/**
 * One question the AGENT asked and what the operator answered.
 *
 * `answer` is null when the operator picked nothing -- the harness writes the
 * literal `(no option selected)` there, which happens on 2 of the 6 live turns
 * and is a REAL answer ("none of your options"), not a missing one.
 */
interface AuqPair {
  question: string;
  answer: string | null;
  notes: string | null;
}

/**
 * The harness's own answer sentinel for "the operator chose no option".
 * Matched literally because the harness emits it literally, unquoted, which is
 * exactly what tells it apart from a quoted choice the operator actually made.
 */
const AUQ_NO_OPTION = "(no option selected)";

/**
 * Split an AskUserQuestion tool_result into its question/answer pairs.
 *
 * THE SHAPE, read off all 6 live turns rather than guessed (2026-07-28):
 *
 *   The user answered: "<question>"=<answer>[ notes: <free text>][, "<q2>"=<a2>…]
 *   Read the answers carefully -- ... -- and follow what they actually say.
 *
 * where `<answer>` is either a double-quoted option the agent authored or the
 * bare sentinel `(no option selected)`, and `notes:` carries free text the
 * operator TYPED. Two of the six carry only notes; one carries two pairs, the
 * second of which is a paragraph of the operator's own prose.
 *
 * PARSED RATHER THAN REGEX-STRIPPED because the pieces have different authors
 * and the whole point of the AUQ badge is that the reader can tell them apart:
 * the question is the AGENT's framing, the choice is bounded by options the
 * AGENT wrote, and only `notes:` is unbounded operator text. Rendering them
 * undifferentiated would collapse exactly the distinction the operator asked to
 * keep visible.
 *
 * Returns an empty array when the content does not parse -- the caller then
 * falls back to the raw text rather than inventing structure. A harness reword
 * degrades to "renders the wrapper", never to "loses the operator's words".
 */
export function parseAskUserQuestion(content: string): AuqPair[] {
  const trimmed = content.trimStart();
  const withoutPrefix = trimmed.replace(AUQ_ANSWER_PREFIX, "");
  if (withoutPrefix === trimmed) return [];
  const body = withoutPrefix.replace(AUQ_TRAILER, "").trim();
  if (body.length === 0) return [];

  const pairs: AuqPair[] = [];
  // Walk the string rather than splitting on `,` or `"`: an operator note can
  // and does contain both (live turn b37f553a carries a comma-rich paragraph
  // and turn 4404d155's answer is shouted prose). Only a scan that knows a
  // question is quoted and an `=` follows it can tell a separator from content.
  let i = 0;
  while (i < body.length) {
    const qStart = body.indexOf('"', i);
    if (qStart === -1) break;
    const qEnd = body.indexOf('"', qStart + 1);
    if (qEnd === -1) break;
    if (body[qEnd + 1] !== "=") {
      // Not a question/answer boundary -- a stray quote inside prose. Skip past
      // it rather than abandoning the parse, so one odd character in an operator
      // note cannot silently drop the pairs that follow it.
      i = qEnd + 1;
      continue;
    }
    const question = body.slice(qStart + 1, qEnd);

    let answer: string | null = null;
    let cursor = qEnd + 2;
    if (body[cursor] === '"') {
      const aEnd = body.indexOf('"', cursor + 1);
      if (aEnd === -1) break;
      answer = body.slice(cursor + 1, aEnd);
      cursor = aEnd + 1;
    } else if (body.startsWith(AUQ_NO_OPTION, cursor)) {
      cursor += AUQ_NO_OPTION.length;
    } else {
      // An unrecognised answer form. Take everything up to the next `, "` pair
      // boundary so a harness that stops quoting still surfaces the answer.
      const next = body.indexOf(', "', cursor);
      const stop = next === -1 ? body.length : next;
      answer = body.slice(cursor, stop).trim() || null;
      cursor = stop;
    }

    let notes: string | null = null;
    const rest = body.slice(cursor);
    const notesMatch = /^\s*notes:\s*/.exec(rest);
    if (notesMatch) {
      const after = rest.slice(notesMatch[0].length);
      const next = after.indexOf(', "');
      notes = (next === -1 ? after : after.slice(0, next)).trim() || null;
      cursor += notesMatch[0].length + (next === -1 ? after.length : next);
    }

    pairs.push({ question, answer, notes });
    const nextPair = body.indexOf(', "', cursor);
    if (nextPair === -1) break;
    i = nextPair + 2;
  }

  return pairs;
}

/**
 * Render an AskUserQuestion answer so THE OPERATOR'S DECISION LEADS.
 *
 * The raw content opens `The user answered: "<question the agent wrote>"=...`,
 * so rendering it verbatim puts the AGENT's question in the position every other
 * exchange gives to the operator's own words -- the same inversion 041 exists to
 * fix, one layer down. What the operator actually contributed is the choice and
 * the notes; the question is context for it.
 *
 * So: choice and notes first, the agent's question after and labelled as the
 * agent's. The AUQ marker is stated in the text as well as carried in
 * `anchor_kind`, because the row is read in two places -- the page, which has
 * the column, and anything reading `content` alone, which does not.
 *
 * Falls back to the raw text when the parse finds nothing, which is the safe
 * direction: an unrendered wrapper is ugly, a dropped decision is data loss. The
 * fallback still strips the harness prefix and trailer, so a turn that is
 * NOTHING BUT wrapper renders empty and prepareExchange degrades it to an orphan
 * -- otherwise "The user answered:" alone would count as operator words and
 * 041's candidate_memory_anchor_has_text would be satisfied by boilerplate.
 */
export function renderAskUserQuestionHead(content: string): string {
  const pairs = parseAskUserQuestion(content);
  if (pairs.length === 0) {
    return normalizeWhitespace(
      content
        .trimStart()
        .replace(AUQ_ANSWER_PREFIX, "")
        .replace(AUQ_TRAILER, ""),
    );
  }

  const blocks = pairs.map((pair) => {
    const lines: string[] = [];
    // The choice is the decision, so it is first even when it is "none of the
    // above" -- refusing every option offered is itself an answer, and 2 of the
    // 6 live turns are exactly that.
    lines.push(`CHOSE: ${pair.answer ?? "(none of the options offered)"}`);
    if (pair.notes) lines.push(`NOTED: ${pair.notes}`);
    // Attributed to the agent explicitly. Without the label a reader takes the
    // question for the operator's, which is the misattribution this whole
    // module is about.
    lines.push(`(agent asked: ${pair.question})`);
    return lines.join("\n");
  });

  return normalizeWhitespace(
    `[AskUserQuestion -- the operator chose from options the agent offered]\n${blocks.join("\n\n")}`,
  );
}

/**
 * The operator's words from a head turn, however it was authored.
 *
 * One function so the rendered `content` and the stored `operator_text` cannot
 * disagree about what the operator said -- they are read side by side on the
 * page, and a divergence there reads as the page lying about the row.
 */
export function operatorTextOf(anchor: DistillTurn): string {
  return isAskUserQuestionAnswer(anchor)
    ? renderAskUserQuestionHead(anchor.content)
    : normalizeWhitespace(anchor.content);
}

/**
 * Cut ordered turns into exchanges.
 *
 * THE CUT IS `is_human_prompt`, NOT `role = 'user'`. They agree perfectly on
 * today's corpus (measured 2026-07-28: user/true 272, assistant/false 2,226,
 * tool/false 1,389 -- no row disagrees), but they answer different questions.
 * `role` is a transport label a new runtime may reuse for anything; the ingest
 * schema (tools/ingest-raw-turn.ts:90-91) makes `is_human_prompt` the explicit
 * "a human typed this" flag. Anchoring on the flag means a runtime that ships a
 * human prompt under a novel role still heads an exchange, rather than silently
 * becoming body text under whatever came before it.
 *
 * THE WINDOW NEVER CROSSES A SESSION. Two sessions are two conversations, and
 * letting one session's agent turns become the body of another's operator turn
 * would fabricate a relationship the corpus does not contain -- the same
 * boundary rule buildUnits enforces (distill-window.ts:117-121).
 *
 * @param turns Turns already ordered by (session_ref, occurred_at, id).
 */
export function buildExchanges(turns: readonly DistillTurn[]): Exchange[] {
  const exchanges: Exchange[] = [];
  let current: { anchor: DistillTurn | null; body: DistillTurn[] } | null =
    null;
  let currentSession: string | null = null;
  let started = false;

  const flush = (): void => {
    if (current === null) return;
    // An orphan with no body cannot exist (it is created BY a body turn), and an
    // anchor with no body is a valid tail exchange -- see the tail note below.
    exchanges.push({
      anchor: current.anchor,
      body: current.body,
      session_ref: currentSession,
      anchor_kind: anchorKindOf(current.anchor),
    });
    current = null;
  };

  for (const turn of turns) {
    // A session boundary closes whatever was open, including a trailing orphan.
    if (!started || turn.session_ref !== currentSession) {
      flush();
      currentSession = turn.session_ref;
      started = true;
    }

    if (isOperatorTurn(turn)) {
      // Every operator turn opens a new exchange, which is the whole re-cut.
      flush();
      current = { anchor: turn, body: [] };
      continue;
    }

    if (current === null) {
      // THE HEAD CASE: agent turns before this session's first operator turn.
      // Captured as an orphan rather than dropped, per the governing "let
      // everything pass" decision (037:1-22) -- an agent turn nobody asked for
      // is still something that happened, and 17 of them exist on the live
      // corpus. It ranks below anchored exchanges because nobody asked for it,
      // which is an ORDERING consequence (041's queue index), not a filter.
      current = { anchor: null, body: [] };
    }
    current.body.push(turn);
  }

  // THE TAIL CASE: the last exchange of the corpus has no next operator turn to
  // close it. Flushing here is what keeps it -- and an operator turn with an
  // EMPTY body is still a valid exchange, because "the operator said something
  // and the agent never answered" is a real and gradeable interaction.
  flush();

  return exchanges;
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

/** Collapse transcript whitespace so a review page reads cleanly. */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * How much of the rendered exchange the BODY may occupy.
 *
 * MAX_CANDIDATE_CHARS (4,000, distiller.ts:214-224) is a hard ceiling for two
 * independent reasons: src/embedding.ts refuses input over 32,000 characters
 * without calling the provider, and a candidate is meant to be a claim a human
 * reads, not a transcript. Exchanges are far larger than fragments -- mean 13.4
 * turns, max 208, measured 2026-07-28 -- so truncation is the NORMAL case here
 * rather than the exception, and WHAT gets truncated is the load-bearing choice.
 *
 * The operator's words are never what gets cut. This budget is what is left for
 * the body after the head and the labels are laid down; if the head alone
 * exceeds the ceiling the body is dropped entirely rather than the head clipped.
 */
const HEAD_RESERVE = 1200;

/**
 * Longest single body turn rendered before it is clipped.
 *
 * Without a per-turn bound, one 200KB tool result (the ingest cap is 200,000
 * chars) consumes the entire body budget and the other 200 turns of a large
 * exchange render as nothing. Clipping per turn keeps the SHAPE of what the
 * agent did visible -- which is what the operator grades -- rather than one
 * turn's full text.
 */
const MAX_BODY_TURN_CHARS = 600;

/** Label a body turn by what it is, so the operator can skim the shape of the reply. */
function bodyLabel(turn: DistillTurn): string {
  if (turn.role === "tool") return "tool";
  if (turn.role === "assistant") return "agent";
  // An unrecognised role is labelled by its own name rather than coerced. A
  // denylist-shaped decision, matching isSpeech (distill-window.ts:99-107): a
  // role nobody has heard of must stay visible, not be relabelled into one of
  // the two we know.
  return turn.role || "unknown";
}

/**
 * Render one exchange as the operator will read it: HIS WORDS FIRST.
 *
 * The head is never truncated away. If the whole rendering exceeds
 * MAX_CANDIDATE_CHARS, the BODY is cut and says so -- the operator's own
 * sentence is the thing being graded, and clipping it would recreate exactly the
 * "judge a fragment of your own conversation" failure this module exists to fix.
 */
export function renderExchange(exchange: Exchange): string {
  // operatorTextOf, not raw content: an AskUserQuestion head arrives wrapped in
  // harness boilerplate that opens with the AGENT's question, so rendering it
  // verbatim would put agent text in the operator's position -- the exact
  // inversion this module exists to fix.
  const head =
    exchange.anchor === null ? null : operatorTextOf(exchange.anchor);

  const lines: string[] = [];
  if (head !== null && head.length > 0) {
    lines.push(`OPERATOR: ${head}`);
  } else {
    // An orphan has no operator turn at all. Saying so explicitly is what stops
    // the page rendering agent text in the position the operator's words occupy
    // everywhere else -- which would read as though he had said it.
    lines.push(
      "OPERATOR: (no operator turn -- agent activity before the first prompt of this session)",
    );
  }

  // Budget the body against what the head actually took, not against a guess.
  const headCost = lines[0]!.length + 2;
  const bodyBudget = Math.max(0, MAX_CANDIDATE_CHARS - Math.max(headCost, 0));

  const rendered: string[] = [];
  let used = 0;
  let omitted = 0;

  for (const turn of exchange.body) {
    const text = normalizeWhitespace(turn.content);
    if (text.length === 0) {
      omitted++;
      continue;
    }
    const clipped =
      text.length > MAX_BODY_TURN_CHARS
        ? `${text.slice(0, MAX_BODY_TURN_CHARS).trimEnd()} […]`
        : text;
    const line = `${bodyLabel(turn)}: ${clipped}`;
    if (used + line.length + 1 > bodyBudget) {
      omitted++;
      continue;
    }
    rendered.push(line);
    used += line.length + 1;
  }

  if (rendered.length > 0) {
    lines.push("", ...rendered);
  }
  if (omitted > 0) {
    // Counted, not silent. A reviewer must be able to tell a complete exchange
    // from one whose tail did not fit, without going back to ob_raw_turns.
    lines.push("", `[${omitted} further turn(s) omitted for length]`);
  }

  const out = lines.join("\n");
  // Final backstop. The head reserve makes this unreachable for any realistic
  // head, but a single pathological operator turn (the ingest cap is 200,000
  // chars) must still not violate the embedding limit. Even here the cut lands
  // at the END of the string, so the operator's opening words survive.
  if (out.length <= MAX_CANDIDATE_CHARS) return out;
  return `${out.slice(0, MAX_CANDIDATE_CHARS - 16).trimEnd()} […truncated]`;
}

// --------------------------------------------------------------------------
// Classification
// --------------------------------------------------------------------------

/**
 * Correction markers in operator speech. Same stems as distiller.ts:167-168,
 * deliberately duplicated rather than shared: that list classifies a lone turn,
 * this one classifies an exchange headed by a turn, and tuning one for its own
 * corpus must not silently retune the other. The 8 grades already collected are
 * against the fragment rules, so changing them would invalidate that data.
 */
const CORRECTION_RE =
  /\b(?:no,|nope|wrong|incorrect|not (?:that|what|it|right|true)|don'?t|do not|never|stop|actually|instead|rather than|that'?s not|isn'?t|shouldn'?t|mistake|fix that|undo|revert|i said|you (?:didn'?t|missed|broke|forgot))\b/i;

/** Preference markers. Narrow, for the reason distiller.ts:180-190 measured: `preference` was the 2026-07-24 run's failure mode at 112 of 214 mislabels. */
const PREFERENCE_RE =
  /\b(?:i (?:prefer|like|love|hate|don'?t like|dislike|want)\b|prefer\b|rather have|my preference|i'?m not a fan|pet peeve|drives me (?:nuts|crazy))/i;

/** Decision / directive markers, including bare imperatives -- the operator decides in commands. */
const DECISION_RE =
  /\b(?:decid|decision|we(?:'| a)?re going with|going with|let'?s|lets |i want|i'?d like|from now on|going forward|the rule is|must|should|use |switch|move (?:it|that|this) to|make (?:it|that|this)|set |always|by design|on purpose|deliberat)\b/i;

/** Bare acknowledgement shapes -- the short operator turns that are still whole decisions. */
const ACK_RE =
  /^(?:ok(?:ay)?|k|yes|yep|yeah|ya|sure|go|go ahead|go for it|do it|try it|run it|proceed|continue|correct|right|exactly|perfect|nice|great|good|thanks|thank you|ty|got it|understood|agreed|approved|lgtm|ship it|send it|yup|sounds good|makes sense|\.|\+1)\b[\s.!,]*$/i;

interface Classified {
  type: CandidateType;
  uncertain: boolean;
  reason?: string;
}

/**
 * Classify the exchange FROM THE OPERATOR'S TURN.
 *
 * This is the second half of the fix and it follows from the first. The type is
 * a claim about what KIND of thing this is (033:65-71), and what an exchange IS
 * was set by the operator when he opened it -- a question is a decision context,
 * a correction is a correction, whatever the agent then said. Classifying from
 * the agent's reply is how `fact` reached 612 while the operator's own 272 turns
 * produced 167 candidates: the agent reports, so everything looked like a fact.
 *
 * An orphan has no operator turn to classify from, so it is `fact` and uncertain
 * -- the honest answer, since nothing in it states an intent.
 *
 * AN AskUserQuestion HEAD IS CLASSIFIED FROM ITS RENDERED FORM, NOT ITS RAW
 * CONTENT (043). The raw string opens with the question THE AGENT WROTE, and
 * agent questions are dense in DECISION_RE stems ("Should services ever run
 * as...", "how should the registry schema express it?", "Track it?") -- so
 * matching the raw text classifies the exchange from the agent's framing, which
 * is the same misattribution 041 exists to end, one layer down. operatorTextOf
 * has already stripped the wrapper down to the choice and the notes.
 */
function classifyExchange(exchange: Exchange): Classified {
  if (exchange.anchor === null) {
    return {
      type: "fact",
      uncertain: true,
      reason:
        "orphan exchange -- agent activity before the first operator turn of the session, so no operator intent classifies it and nobody asked for it",
    };
  }

  const text = operatorTextOf(exchange.anchor);

  if (ACK_RE.test(text)) {
    // The body is what was authorized, and it is IN the content already -- which
    // is the structural win over the fragment unit, where an ack candidate read
    // "Operator approved: 'ok'" and the reviewer had to go find what was
    // approved. Still uncertain: assent and doubt are the same string.
    return {
      type: "decision",
      uncertain: true,
      reason:
        exchange.body.length > 0
          ? "short acknowledgement heading the exchange -- reads as authorization of the agent activity below it, but assent and doubt are the same string and only the reviewer can tell which"
          : "short acknowledgement with nothing following it in the session -- what it authorized never happened, or happened elsewhere",
    };
  }

  if (CORRECTION_RE.test(text)) {
    return {
      type: "correction",
      uncertain: true,
      reason:
        "the operator's turn matched a correction marker -- the exchange is arguing with something, but a rule cannot tell whether the correction stuck",
    };
  }

  if (PREFERENCE_RE.test(text)) {
    return { type: "preference", uncertain: false };
  }

  if (DECISION_RE.test(text)) {
    return { type: "decision", uncertain: false };
  }

  return {
    type: "decision",
    uncertain: true,
    reason:
      "operator turn with no decision, correction, or preference marker -- captured because operator speech is authoritative, but the kind of claim is unresolved",
  };
}

// --------------------------------------------------------------------------
// Candidate production
// --------------------------------------------------------------------------

/** One exchange prepared for the write. Shares candidate_memory's column vocabulary. */
export interface PreparedExchangeCandidate {
  namespace: string;
  candidate_type: CandidateType;
  content: string;
  content_hash: string;
  /** Every turn in the exchange: the operator's plus the whole body. */
  source_turn_ids: string[];
  /** The operator turn heading it. Null for an orphan. */
  anchor_turn_id: string | null;
  /** The operator's verbatim words, for 041's operator_text column. Null for an orphan. */
  operator_text: string | null;
  /**
   * 043's anchor_kind. Persisted so the page can badge an AskUserQuestion head
   * apart from a typed one without re-parsing `content` -- the two are not
   * equivalent evidence and the operator asked for the distinction by name.
   */
  anchor_kind: AnchorKind;
  uncertain: boolean;
  uncertainty_reason?: string;
  unit_kind: "exchange";
  model: string;
  session_ref: string | null;
}

/** Names the producer in candidate_memory.model, so exchange and fragment rows are attributable apart. */
export const EXCHANGE_DISTILLER_NAME = "exchange-distiller/v1";

/**
 * Turn one exchange into one candidate.
 *
 * EVERYTHING IS EMITTED. There is no length floor, no salience gate, and no
 * "probably not worth it" branch -- 037:1-22 and the operator's "for now they
 * all go into at least the REM session". Where the extractor is unsure it says
 * so in `uncertain`/`uncertainty_reason` and emits anyway.
 *
 * The ONE rejection is an exchange with nothing renderable in it at all: an
 * orphan whose every body turn is empty or harness scaffolding. That is not a
 * salience judgement, it is candidate_memory_content_check -- there is no
 * content to write. An exchange with a real operator turn is ALWAYS emitted,
 * however short, because a 2-character operator turn can be the whole decision
 * (dream-light.ts:161-176).
 */
export function prepareExchange(
  exchange: Exchange,
): PreparedExchangeCandidate | null {
  const anchor = exchange.anchor;

  const operatorText = anchor === null ? null : operatorTextOf(anchor);

  // An anchor whose content is empty or pure harness scaffolding cannot head
  // anything -- 041's candidate_memory_anchor_has_text would reject the row, and
  // rendering it would put an empty OPERATOR line above agent text. Degrade to
  // an orphan rather than dropping the body, which is real agent activity.
  const anchorUsable =
    anchor !== null &&
    operatorText !== null &&
    operatorText.length > 0 &&
    !isHarnessNoise(operatorText);

  const effective: Exchange = anchorUsable
    ? exchange
    : {
        anchor: null,
        body: exchange.body,
        session_ref: exchange.session_ref,
        // The kind is re-derived from the DEGRADED anchor, not carried over: a
        // row whose head was dropped genuinely has no operator turn, and
        // reporting it as 'typed' would promise the page an operator_text that
        // the same branch just set to null.
        anchor_kind: "orphan",
      };

  // Nothing to write at all. Only reachable for an unusable anchor with an empty
  // body -- an anchored exchange always renders its head.
  const hasBodyContent = effective.body.some(
    (t) => normalizeWhitespace(t.content).length > 0,
  );
  if (effective.anchor === null && !hasBodyContent) return null;

  const content = renderExchange(effective);
  if (content.trim().length === 0) return null;

  const classified = classifyExchange(effective);

  // Namespace comes from the turns themselves, never from a caller argument:
  // it is a security boundary, and a candidate must live in the namespace its
  // evidence does. The anchor is authoritative when present.
  const namespace = effective.anchor?.namespace ?? effective.body[0]?.namespace;
  if (namespace === undefined) return null;

  // EVERY turn in the exchange, head first then body in order. This is what
  // makes "the surrounding agent calls should almost always auto go in"
  // expressible: one grade, and provenance names the whole interaction. The
  // fragment unit deliberately named only the current turn (distiller.ts:64-74)
  // because its claim came from exactly one turn; an exchange's claim is the
  // interaction, so naming all of it is the honest attribution, not a looser one.
  const sourceTurnIds = [
    ...(effective.anchor ? [effective.anchor.id] : []),
    ...effective.body.map((t) => t.id),
  ];
  // candidate_memory_source_turns_check requires cardinality > 0.
  if (sourceTurnIds.length === 0) return null;

  // Defence in depth against a type that would violate
  // candidate_memory_type_check -- coerced rather than dropped, so a
  // classification bug never costs real content.
  const type: CandidateType = (CANDIDATE_TYPES as readonly string[]).includes(
    classified.type,
  )
    ? classified.type
    : "decision";

  return {
    namespace,
    candidate_type: type,
    content,
    // The SAME hash function ingest and Light apply, so an exchange hash is
    // directly comparable to a turn hash in content_occurrences.
    content_hash: contentHash(content),
    source_turn_ids: sourceTurnIds,
    anchor_turn_id: effective.anchor?.id ?? null,
    operator_text: effective.anchor ? operatorText : null,
    anchor_kind: effective.anchor_kind,
    uncertain: classified.uncertain,
    ...(classified.reason ? { uncertainty_reason: classified.reason } : {}),
    unit_kind: "exchange",
    model: EXCHANGE_DISTILLER_NAME,
    session_ref: effective.session_ref,
  };
}

/** Cut and prepare in one call. The whole extractor, over an ordered turn list. */
export function extractExchanges(
  turns: readonly DistillTurn[],
): PreparedExchangeCandidate[] {
  const out: PreparedExchangeCandidate[] = [];
  for (const exchange of buildExchanges(turns)) {
    const prepared = prepareExchange(exchange);
    if (prepared !== null) out.push(prepared);
  }
  return out;
}
