/**
 * EXCHANGE distillation -- the operator's turn heads every unit. Migration 041.
 *
 * The unit is the INTERACTION, anchored on the operator's turn; ordering key is
 * (session_ref, occurred_at, id), NOT session_seq. This module never rewrites or
 * re-attributes the pre-041 fragment rows and never writes review_action,
 * reviewed_at, graded_by, or machine_grade (037:43-57).
 *
 * See docs/decisions/distill-exchange-operator-anchored-unit.md
 */

import { normalizedContentHash } from "../embedding/provider.ts";
import { isHarnessNoise } from "../capture/ingest-raw-turn.ts";
import type { DistillTurn } from "../domain/distill-window.ts";
import {
  CANDIDATE_TYPES,
  CANDIDATE_PART_CHARS,
  type CandidateType,
} from "../domain/distiller.ts";

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
 * An AskUserQuestion answer: the operator CHOSE rather than typed. Matched on an
 * anchored content prefix because the runtime delivers it as a `tool_result`,
 * so `role`/`is_human_prompt` cannot tell it from command output.
 *
 * See docs/decisions/distill-exchange-askuserquestion-rendering.md
 */
const AUQ_ANSWER_PREFIX = /^The user answered:/;

export function isAskUserQuestionAnswer(turn: DistillTurn): boolean {
  return turn.role === "tool" && AUQ_ANSWER_PREFIX.test(turn.content.trimStart());
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
 * Split an AskUserQuestion tool_result into its question/answer pairs, keeping
 * the agent-authored question, the bounded choice, and the operator-typed
 * `notes:` text apart. Returns an empty array when the content does not parse.
 *
 * See docs/decisions/distill-exchange-askuserquestion-rendering.md
 */
/** The AUQ body text, or null when the content is not an AUQ answer at all. */
function auqBodyOf(content: string): string | null {
  const trimmed = content.trimStart();
  const withoutPrefix = trimmed.replace(AUQ_ANSWER_PREFIX, "");
  if (withoutPrefix === trimmed) return null;
  const body = withoutPrefix.replace(AUQ_TRAILER, "").trim();
  return body.length === 0 ? null : body;
}

/** A scan result: what was read, and where the scan left the cursor. */
interface AuqScan<T> {
  value: T;
  cursor: number;
}

/**
 * Read the answer that follows `"<question>"=` at `cursor`.
 *
 * Returns null only for an unterminated quoted answer, which is a malformed
 * body the caller abandons rather than guessing at.
 */
function scanAuqAnswer(body: string, cursor: number): AuqScan<string | null> | null {
  if (body[cursor] === '"') {
    const aEnd = body.indexOf('"', cursor + 1);
    if (aEnd === -1) return null;
    return { value: body.slice(cursor + 1, aEnd), cursor: aEnd + 1 };
  }
  if (body.startsWith(AUQ_NO_OPTION, cursor)) {
    return { value: null, cursor: cursor + AUQ_NO_OPTION.length };
  }
  // An unrecognised answer form. Take everything up to the next `, "` pair
  // boundary so a harness that stops quoting still surfaces the answer.
  const next = body.indexOf(', "', cursor);
  const stop = next === -1 ? body.length : next;
  return { value: body.slice(cursor, stop).trim() || null, cursor: stop };
}

/** Read an optional `notes: <free text>` run starting at `cursor`. */
function scanAuqNotes(body: string, cursor: number): AuqScan<string | null> {
  const rest = body.slice(cursor);
  const notesMatch = /^\s*notes:\s*/.exec(rest);
  if (!notesMatch) return { value: null, cursor };
  const after = rest.slice(notesMatch[0].length);
  const next = after.indexOf(', "');
  const span = next === -1 ? after.length : next;
  return {
    value: (next === -1 ? after : after.slice(0, next)).trim() || null,
    cursor: cursor + notesMatch[0].length + span,
  };
}

export function parseAskUserQuestion(content: string): AuqPair[] {
  const body = auqBodyOf(content);
  if (body === null) return [];

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

    const answerScan = scanAuqAnswer(body, qEnd + 2);
    if (answerScan === null) break;
    const notesScan = scanAuqNotes(body, answerScan.cursor);

    pairs.push({ question, answer: answerScan.value, notes: notesScan.value });
    const nextPair = body.indexOf(', "', notesScan.cursor);
    if (nextPair === -1) break;
    i = nextPair + 2;
  }

  return pairs;
}

/**
 * Render an AskUserQuestion answer so THE OPERATOR'S DECISION LEADS: choice and
 * notes first, the agent's question after and labelled as the agent's. Falls
 * back to the raw text (prefix and trailer stripped) when the parse finds none.
 *
 * See docs/decisions/distill-exchange-askuserquestion-rendering.md
 */
export function renderAskUserQuestionHead(content: string): string {
  const pairs = parseAskUserQuestion(content);
  if (pairs.length === 0) {
    return normalizeWhitespace(
      content.trimStart().replace(AUQ_ANSWER_PREFIX, "").replace(AUQ_TRAILER, ""),
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
  let current: { anchor: DistillTurn | null; body: DistillTurn[] } | null = null;
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
 * Head size assumed when working out how much body fits alongside it.
 *
 * The head -- the operator's own words -- is REPEATED ON EVERY PART, so its
 * length has to be accounted for when packing turns into parts. This is that
 * accounting figure, and nothing more: a head longer than this is still
 * rendered in full, it simply leaves less room beside it, which pushes the
 * remaining turns into the next part rather than removing them.
 *
 * Until 2026-07-30 this value also CUT the head, appending a marker to any
 * operator turn past it -- measured that day, one real turn of 15,430
 * characters was stored as 1,200. Nothing that the operator said is shortened
 * here any more; his words are the thing being graded.
 */
const HEAD_PACKING_ESTIMATE = 1200;

/**
 * Turns are rendered WHOLE.
 *
 * Until 2026-07-30 a single turn longer than 600 characters was shortened here
 * and given a marker, on the reasoning that one huge tool result would
 * otherwise fill a part and crowd out the rest of the exchange. Measured on the
 * live clone that day: 3,789 of 5,434 stored candidates -- 70% -- carried that
 * marker, so the normal case was a damaged turn rather than a rescued one.
 *
 * Crowding is not solved by shortening, it is solved by SPLITTING, which
 * renderExchangeParts below already does: a turn that fills a part simply gets
 * its own part and the next turn starts the following one. Nothing is lost and
 * the sequence still reads in order.
 */

/**
 * A short SIGNPOST for parts 2..N of one exchange.
 *
 * NOT STORAGE, and not a shortened copy of anything. Part 1 of the same
 * exchange carries the operator's words in full, every part links to the same
 * anchor_turn_id, and operator_text on the row holds them as well. This exists
 * so a reader landing on part 4 can see whose exchange it belongs to.
 *
 * Uses the opening SENTENCE where the head has one, or the opening LINE
 * otherwise. When it has neither -- one unbroken run of characters, which is
 * what a pasted blob looks like -- there is no natural signpost inside it, so
 * the label names the exchange instead of quoting an arbitrary piece of it.
 */
function continuationSignpost(line: string): string {
  const sentence = /^.*?[.!?](?:\s|$)/.exec(line);
  if (sentence && sentence[0].length <= HEAD_PACKING_ESTIMATE) {
    return sentence[0].replace(/\s+$/, "");
  }
  const firstLine = line.split("\n", 1)[0] ?? line;
  if (firstLine.length <= HEAD_PACKING_ESTIMATE) {
    return firstLine.replace(/\s+$/, "");
  }
  return "(operator's words in full on part 1)";
}

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
 * SINGLE-PART RENDER. This produces the ONE row form and still bounds the body,
 * because most exchanges fit and a bounded render is what the review page shows.
 * When the body does not fit, renderExchangeParts below splits instead -- this
 * function's truncation marker is then never reached, and remains only for the
 * pathological head case it documents at the bottom.
 *
 * The head is never truncated away. The operator's own sentence is the thing
 * being graded, and clipping it would recreate exactly the "judge a fragment of
 * your own conversation" failure this module exists to fix.
 */
export function renderExchange(exchange: Exchange): string {
  // operatorTextOf, not raw content: an AskUserQuestion head arrives wrapped in
  // harness boilerplate that opens with the AGENT's question, so rendering it
  // verbatim would put agent text in the operator's position -- the exact
  // inversion this module exists to fix.
  const head = exchange.anchor === null ? null : operatorTextOf(exchange.anchor);

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

  // Every turn, whole, in order. This render used to drop turns that did not
  // fit a body budget and record them in a trailing "[N further turn(s)
  // omitted for length]" note -- honest about the loss, but the turns were
  // still gone. Measured on the live clone 2026-07-28: 154 of 963 exchanges
  // carried that note, between them dropping 1,579 turns.
  //
  // Nothing is dropped here now. An exchange too large to read comfortably in
  // one row is what renderExchangeParts is for -- it splits across linked
  // parts instead, which is the operator's design and the path production
  // uses (line 849).
  const rendered: string[] = [];
  for (const turn of exchange.body) {
    const text = normalizeWhitespace(turn.content);
    if (text.length === 0) continue;
    rendered.push(`${bodyLabel(turn)}: ${text}`);
  }

  if (rendered.length > 0) {
    lines.push("", ...rendered);
  }

  return lines.join("\n");
}

/**
 * Render one exchange across AS MANY PARTS AS ITS TURNS NEED. Nothing is cut:
 * parts are packed with WHOLE turns, and every part repeats the operator head.
 *
 * See docs/decisions/distill-exchange-parts-never-truncate.md
 */
/** The `OPERATOR:` line for an exchange, orphan wording included. */
function headLineOf(exchange: Exchange): string {
  const head = exchange.anchor === null ? null : operatorTextOf(exchange.anchor);
  return head !== null && head.length > 0
    ? `OPERATOR: ${head}`
    : "OPERATOR: (no operator turn -- agent activity before the first prompt of this session)";
}

/** Rendered body lines, whole turns, in order; empty turns contribute nothing. */
function bodyLinesOf(exchange: Exchange): string[] {
  const lines: string[] = [];
  for (const turn of exchange.body) {
    const text = normalizeWhitespace(turn.content);
    if (text.length === 0) continue;
    lines.push(`${bodyLabel(turn)}: ${text}`);
  }
  return lines;
}

/**
 * Pack whole body lines into parts of at most `budget` characters.
 *
 * A line longer than the whole allowance gets its OWN part rather than being
 * cut. Now that turns are rendered whole this is a normal case, not a
 * theoretical one, and it is exactly how a large tool result is kept.
 */
function packBodyLines(lines: readonly string[], budget: number): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used > 0 && used + line.length + 1 > budget) {
      parts.push(current.join("\n"));
      current = [];
      used = 0;
    }
    current.push(line);
    used += line.length + 1;
  }
  if (current.length > 0) parts.push(current.join("\n"));
  return parts;
}

export function renderExchangeParts(exchange: Exchange): string[] {
  const rawHeadLine = headLineOf(exchange);

  // THE HEAD IS NEVER SHORTENED. It is the operator's own words, and it is what
  // the exchange is being graded on.
  //
  // It is repeated on every part, though, which is what the previous code was
  // reacting to. Measured 2026-07-28: one exchange has a 15,430-char operator
  // turn, and repeating it verbatim made every part ~15,600 chars and left no
  // room beside it, so the packing loop fell to its one-line floor and emitted
  // 350 parts for 350 turns. Real problem -- the answer was to cut his words,
  // which is the wrong half to give up.
  //
  // Instead: PART 1 CARRIES THE HEAD IN FULL, and later parts carry a
  // continuation line naming the exchange. Every part still opens with operator
  // context rather than mid-conversation agent output (the "judge a fragment of
  // your own conversation" failure this module exists to fix), no part is
  // mostly a repeated header, and no character of what he said is discarded.
  const headLine = rawHeadLine;
  const headIsLong = rawHeadLine.length > HEAD_PACKING_ESTIMATE;
  // Later parts get a short reference back to the head instead of a second copy
  // of a very long one. For an ordinary head, repeating it is still clearest.
  const continuationHead = headIsLong
    ? `OPERATOR (continued): ${continuationSignpost(rawHeadLine)}`
    : rawHeadLine;

  // Empty turns are dropped rather than counted: an empty turn has nothing to
  // show in any part.
  const bodyLines = bodyLinesOf(exchange);

  if (bodyLines.length === 0) return [headLine];

  // How much body sits in one part, measured against the head that parts 2..N
  // actually carry -- the continuation line, which is why a very long head no
  // longer squeezes every part down to a single turn.
  const MARKER_RESERVE = 64;
  const budget = Math.max(
    // Floor of one line per part, so the loop cannot spin emitting empty parts.
    1,
    CANDIDATE_PART_CHARS - continuationHead.length - 2 - MARKER_RESERVE,
  );

  const parts = packBodyLines(bodyLines, budget);

  // Single part: identical to the one-row render, no continuation marker.
  if (parts.length === 1) return [`${headLine}\n\n${parts[0]}`];

  return parts.map((body, index) => {
    // Says WHICH part and OF HOW MANY, so a reader landing on part 3 knows both
    // that there is more and how much. 041 kept the omitted-count visible for
    // the same reason: a reviewer must never mistake a piece for the whole.
    const marker = `[part ${index + 1} of ${parts.length}]`;
    // Part 1 carries the operator's words in full; later parts carry the
    // continuation line, which is identical to the head unless it is very long.
    return `${index === 0 ? headLine : continuationHead}\n\n${marker}\n${body}`;
  });
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
 * Classify the exchange FROM THE OPERATOR'S TURN, not from the agent's reply,
 * and classify an AskUserQuestion head from its rendered form rather than its
 * raw content (043).
 *
 * See docs/decisions/distill-exchange-operator-anchored-unit.md
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
  /**
   * Position within a split exchange, or null when the exchange fits in one row
   * (044). The HEAD of a split carries null too -- it is the row the other parts
   * point at, and 044's candidate_memory_chunk_pair enforces that parent_id and
   * chunk_index are set together, so a head with an index and no parent cannot
   * be written. Parts are numbered from 1, since 0 is the head's position.
   */
  chunk_index: number | null;
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
/**
 * The exchange as it will actually be written.
 *
 * An anchor whose content is empty or pure harness scaffolding cannot head
 * anything -- 041's candidate_memory_anchor_has_text would reject the row, and
 * rendering it would put an empty OPERATOR line above agent text. Degrade to an
 * orphan rather than dropping the body, which is real agent activity.
 *
 * The kind is re-derived from the DEGRADED anchor, not carried over: a row whose
 * head was dropped genuinely has no operator turn, and reporting it as 'typed'
 * would promise the page an operator_text that the same branch just set to null.
 */
function effectiveExchange(exchange: Exchange): Exchange {
  const anchor = exchange.anchor;
  if (anchor === null) return exchange;
  const operatorText = operatorTextOf(anchor);
  if (operatorText.length > 0 && !isHarnessNoise(operatorText)) return exchange;
  return {
    anchor: null,
    body: exchange.body,
    session_ref: exchange.session_ref,
    anchor_kind: "orphan",
  };
}

/**
 * EVERY turn in the exchange, head first then body in order. This is what makes
 * "the surrounding agent calls should almost always auto go in" expressible: one
 * grade, and provenance names the whole interaction. The fragment unit
 * deliberately named only the current turn (distiller.ts:64-74) because its
 * claim came from exactly one turn; an exchange's claim is the interaction, so
 * naming all of it is the honest attribution, not a looser one.
 */
function sourceTurnIdsOf(exchange: Exchange): string[] {
  return [
    ...(exchange.anchor ? [exchange.anchor.id] : []),
    ...exchange.body.map((t) => t.id),
  ];
}

/**
 * Defence in depth against a type that would violate
 * candidate_memory_type_check -- coerced rather than dropped, so a
 * classification bug never costs real content.
 */
function safeCandidateType(type: CandidateType): CandidateType {
  return (CANDIDATE_TYPES as readonly string[]).includes(type) ? type : "decision";
}

/**
 * One row per rendered part.
 *
 * EVERY PART NAMES EVERY TURN. Provenance is a property of the interaction, not
 * of the slice: asking "which turns did this come from" of part 3 must not
 * answer "only the ones that happened to land in part 3", because the grade on
 * the head covers the whole exchange and the reverse-provenance index
 * (idx_candidate_memory_source_turns) is how a turn finds the exchange it
 * belongs to. Splitting is a rendering concern; attribution is not.
 */
interface CandidateRowInput {
  /** The exchange as it will be written -- anchor already degraded if unusable. */
  effective: Exchange;
  /** Rendered parts, in order. */
  contents: readonly string[];
  classified: Classified;
  namespace: string;
  operatorText: string | null;
}

function candidateRowsOf({
  effective,
  contents,
  classified,
  namespace,
  operatorText,
}: CandidateRowInput): PreparedExchangeCandidate[] {
  const sourceTurnIds = sourceTurnIdsOf(effective);
  const type = safeCandidateType(classified.type);
  return contents.map((content, index) => ({
    namespace,
    candidate_type: type,
    content,
    // The SAME hash function ingest and Light apply, so an exchange hash is
    // directly comparable to a turn hash in content_occurrences. Each part
    // hashes its own text, so the (namespace, content_hash) dedupe stays exact
    // and a re-run collides part-for-part rather than all-or-nothing.
    content_hash: normalizedContentHash(content),
    source_turn_ids: sourceTurnIds,
    anchor_turn_id: effective.anchor?.id ?? null,
    operator_text: effective.anchor ? operatorText : null,
    anchor_kind: effective.anchor_kind,
    uncertain: classified.uncertain,
    ...(classified.reason ? { uncertainty_reason: classified.reason } : {}),
    unit_kind: "exchange" as const,
    model: EXCHANGE_DISTILLER_NAME,
    session_ref: effective.session_ref,
    // Null for the head (index 0) so 044's chunk_pair constraint holds: the head
    // has no parent, therefore no index. Parts number from 1.
    chunk_index: contents.length === 1 || index === 0 ? null : index,
  }));
}

export function prepareExchange(exchange: Exchange): PreparedExchangeCandidate[] {
  const effective = effectiveExchange(exchange);
  const operatorText =
    effective.anchor === null ? null : operatorTextOf(effective.anchor);

  // Nothing to write at all. Only reachable for an unusable anchor with an empty
  // body -- an anchored exchange always renders its head.
  const hasBodyContent = effective.body.some(
    (t) => normalizeWhitespace(t.content).length > 0,
  );
  if (effective.anchor === null && !hasBodyContent) return [];

  // AS MANY ROWS AS THE TURNS NEED. One for an exchange that fits, N for one
  // that does not -- 044. The previous single-render call truncated instead,
  // dropping 1,579 turns across 154 exchanges on the live clone.
  const contents = renderExchangeParts(effective).filter(
    (part) => part.trim().length > 0,
  );
  if (contents.length === 0) return [];

  const classified = classifyExchange(effective);

  // Namespace comes from the turns themselves, never from a caller argument:
  // it is a security boundary, and a candidate must live in the namespace its
  // evidence does. The anchor is authoritative when present.
  const namespace = effective.anchor?.namespace ?? effective.body[0]?.namespace;
  if (namespace === undefined) return [];

  // candidate_memory_source_turns_check requires cardinality > 0.
  if (sourceTurnIdsOf(effective).length === 0) return [];

  return candidateRowsOf({
    effective,
    contents,
    classified,
    namespace,
    operatorText,
  });
}

/** Cut and prepare in one call. The whole extractor, over an ordered turn list. */
export function extractExchanges(
  turns: readonly DistillTurn[],
): PreparedExchangeCandidate[] {
  const out: PreparedExchangeCandidate[] = [];
  for (const exchange of buildExchanges(turns)) {
    // Parts stay ADJACENT and in order, so the writer can link each part to the
    // head it follows without a second pass or a lookup table.
    out.push(...prepareExchange(exchange));
  }
  return out;
}
