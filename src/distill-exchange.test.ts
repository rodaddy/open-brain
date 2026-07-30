/**
 * Functional tests for EXCHANGE distillation (migration 041).
 *
 * WHAT THESE ARE FOR. The re-cut fixes a defect that was INVISIBLE at runtime:
 * an agent-anchored candidate still looks like a candidate, still renders, still
 * grades. The only way it surfaced was the operator reading the page and
 * noticing he was being asked to judge the agent's middle sentence while his own
 * turn sat in the context panel. So these tests assert the properties that
 * failure violates and nothing else would catch:
 *
 *   - the operator's turn HEADS the unit, and heads the rendered content;
 *   - every following agent/tool turn is IN the unit, not a separate one;
 *   - the head is never the thing that gets truncated;
 *   - the type comes from the operator's intent, not the agent's reply;
 *   - the head and tail cases are captured rather than dropped.
 *
 * Input/output at the public boundary, per _DOCS/STANDARDS-testing.md. No SQL
 * shape is asserted; these are pure functions over turn lists.
 */

import { describe, expect, it } from "bun:test";
import {
  anchorKindOf,
  buildExchanges,
  extractExchanges,
  isAskUserQuestionAnswer,
  parseAskUserQuestion,
  prepareExchange,
  renderAskUserQuestionHead,
  renderExchange,
  renderExchangeParts,
  EXCHANGE_DISTILLER_NAME,
  type PreparedExchangeCandidate,
  type Exchange,
} from "./distill-exchange.ts";
import { CANDIDATE_PART_CHARS } from "./distiller.ts";
import type { DistillTurn } from "./distill-window.ts";

let idCounter = 0;
function turn(over: Partial<DistillTurn> = {}): DistillTurn {
  idCounter++;
  const n = String(idCounter).padStart(12, "0");
  return {
    id: `11111111-1111-4111-8111-${n}`,
    namespace: "rico",
    session_ref: "s1",
    session_seq: idCounter,
    role: "assistant",
    content: "content",
    repo: "open-brain",
    occurred_at: new Date(Date.UTC(2026, 6, 28, 0, idCounter)),
    is_human_prompt: false,
    ...over,
  };
}

const operator = (content: string, over: Partial<DistillTurn> = {}) =>
  turn({ role: "user", is_human_prompt: true, content, ...over });
const agent = (content: string, over: Partial<DistillTurn> = {}) =>
  turn({ role: "assistant", content, ...over });
const tool = (content: string, over: Partial<DistillTurn> = {}) =>
  turn({ role: "tool", content, ...over });

/**
 * An AskUserQuestion answer as the runtime actually delivers it.
 *
 * Copied from the shape of the six live turns (2026-07-28): role='tool',
 * is_human_prompt=false, the `The user answered:` prefix, `"question"=answer`
 * pairs, and the trailing instruction addressed to the agent. Building it from
 * parts rather than pasting one live string keeps the operator's real words out
 * of the repo while still exercising the exact structure the parser must handle.
 */
const auq = (pairs: string, over: Partial<DistillTurn> = {}): DistillTurn =>
  tool(
    `The user answered: ${pairs} Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.`,
    over,
  );

/**
 * Build an Exchange the way buildExchanges does, deriving anchor_kind from the
 * anchor rather than letting each test assert one by hand. A test that hardcoded
 * the kind could pass while the production derivation was wrong, which is the
 * one thing these tests exist to catch.
 */
const ex = (e: Omit<Exchange, "anchor_kind">): Exchange => ({
  ...e,
  anchor_kind: anchorKindOf(e.anchor),
});

describe("buildExchanges", () => {
  it("cuts a new unit at every operator turn and keeps the agent turns with it", () => {
    // The defect in one assertion: under the fragment unit this input produced 5
    // candidates, 3 of them agent-anchored. It is ONE exchange plus one more.
    const turns = [
      operator("move the curation logic to TypeScript?"),
      agent("Checking whether drizzle is wired up."),
      tool("[tool_use: Bash]"),
      agent("Drizzle isn't a dependency and there's no config."),
      operator("ok then wait"),
    ];
    const exchanges = buildExchanges(turns);

    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]!.anchor?.content).toBe(
      "move the curation logic to TypeScript?",
    );
    expect(exchanges[0]!.body).toHaveLength(3);
    expect(exchanges[1]!.anchor?.content).toBe("ok then wait");
    expect(exchanges[1]!.body).toHaveLength(0);
  });

  it("keeps an operator turn with no following agent turns -- the tail case", () => {
    const exchanges = buildExchanges([agent("earlier"), operator("last word")]);
    const tail = exchanges.at(-1)!;
    expect(tail.anchor?.content).toBe("last word");
    expect(tail.body).toHaveLength(0);
  });

  it("captures agent turns before the first operator turn as an orphan", () => {
    // 10 of 32 live sessions open this way and 7 contain no operator turn at
    // all. Dropping them would silently lose 17 units of real agent activity.
    const exchanges = buildExchanges([
      agent("session resumed"),
      tool("[tool_use: Read]"),
      operator("right, carry on"),
    ]);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]!.anchor).toBeNull();
    expect(exchanges[0]!.body).toHaveLength(2);
    expect(exchanges[1]!.anchor?.content).toBe("right, carry on");
  });

  it("captures a session that contains no operator turn at all", () => {
    const exchanges = buildExchanges([agent("a"), agent("b")]);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.anchor).toBeNull();
    expect(exchanges[0]!.body).toHaveLength(2);
  });

  it("never lets one session's agent turns become another session's body", () => {
    // Two conversations are two conversations. Without the boundary, s2's agent
    // turn would answer s1's operator turn -- a relationship the corpus does not
    // contain, invented by the windowing.
    const exchanges = buildExchanges([
      operator("in session one", { session_ref: "s1" }),
      agent("reply in one", { session_ref: "s1" }),
      agent("orphan in two", { session_ref: "s2" }),
      operator("in session two", { session_ref: "s2" }),
    ]);
    expect(exchanges).toHaveLength(3);
    expect(exchanges[0]!.session_ref).toBe("s1");
    expect(exchanges[0]!.body.map((t) => t.content)).toEqual(["reply in one"]);
    expect(exchanges[1]!.anchor).toBeNull();
    expect(exchanges[1]!.session_ref).toBe("s2");
    expect(exchanges[2]!.anchor?.content).toBe("in session two");
  });

  it("anchors on is_human_prompt, not on role", () => {
    // The two agree perfectly today but answer different questions: role is a
    // transport label a new runtime may reuse, is_human_prompt is the explicit
    // "a human typed this" flag. A human prompt under a novel role must still
    // head an exchange rather than becoming body text.
    const exchanges = buildExchanges([
      turn({ role: "hermes", is_human_prompt: true, content: "novel runtime" }),
      agent("answering"),
    ]);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.anchor?.content).toBe("novel runtime");
    expect(exchanges[0]!.body).toHaveLength(1);
  });

  it("does not treat a user-role turn that is not a human prompt as an anchor", () => {
    const exchanges = buildExchanges([
      operator("real prompt"),
      turn({ role: "user", is_human_prompt: false, content: "injected" }),
    ]);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.body.map((t) => t.content)).toEqual(["injected"]);
  });
});

describe("renderExchange", () => {
  it("leads with the operator's verbatim words", () => {
    const content = renderExchange(
      ex({
        anchor: operator("should the curation logic move to TypeScript now?"),
        body: [agent("Drizzle isn't a dependency and there's no config.")],
        session_ref: "s1",
      }),
    );
    expect(content.startsWith("OPERATOR: should the curation logic move")).toBe(
      true,
    );
    // The agent's sentence is present -- as body, below the head. That is the
    // whole re-cut: it used to BE the candidate.
    expect(content).toContain("agent: Drizzle isn't a dependency");
    expect(content.indexOf("OPERATOR:")).toBeLessThan(
      content.indexOf("agent: Drizzle"),
    );
  });

  it("labels tool turns so the operator can skim what the agent did", () => {
    const content = renderExchange(
      ex({
        anchor: operator("run the tests"),
        body: [tool("[tool_use: Bash]"), agent("2695 pass, 0 fail")],
        session_ref: "s1",
      }),
    );
    expect(content).toContain("tool: [tool_use: Bash]");
    expect(content).toContain("agent: 2695 pass, 0 fail");
  });

  it("keeps the operator's head AND every body turn", () => {
    // This test used to assert the tail was dropped and the loss noted. The
    // note was honest and the turns were still gone -- 1,579 of them across
    // 154 exchanges on the live clone. Both halves are kept now.
    const head = `decide this: ${"x".repeat(800)}`;
    const content = renderExchange(
      ex({
        anchor: operator(head),
        body: Array.from({ length: 60 }, (_, i) =>
          agent(`reply ${i} ${"y".repeat(500)}`),
        ),
        session_ref: "s1",
      }),
    );

    expect(content.startsWith(`OPERATOR: ${head}`)).toBe(true);
    expect(content).not.toContain("further turn(s) omitted for length");
    // Every one of the 60 body turns is present, in full.
    for (let i = 0; i < 60; i++) {
      expect(content).toContain(`reply ${i} ${"y".repeat(500)}`);
    }
  });

  it("SPLITS an over-length exchange instead of dropping its tail", () => {
    // The 044 defect in one assertion. Measured on the live clone 2026-07-28:
    // 154 of 963 exchanges carried the omitted-for-length marker, and 1,579
    // turns went with it. Every one of those turns must now land in some part.
    const parts = renderExchangeParts(
      ex({
        anchor: operator("decide this"),
        body: Array.from({ length: 60 }, (_, i) =>
          agent(`reply ${i} ${"y".repeat(500)}`),
        ),
        session_ref: "s1",
      }),
    );

    expect(parts.length).toBeGreaterThan(1);
    // NOTHING IS OMITTED. Not "fewer omissions" -- none.
    for (const part of parts) {
      expect(part).not.toContain("omitted for length");
      // Turns here are small enough to pack normally; a turn larger than a
      // whole part would get its own part rather than being shortened.
      expect(part.length).toBeLessThanOrEqual(CANDIDATE_PART_CHARS);
      // Every part leads with the operator, so no part reads as agent text the
      // operator is being asked to own.
      expect(part.startsWith("OPERATOR: decide this")).toBe(true);
    }
    // Every single body turn is present SOMEWHERE across the parts.
    const joined = parts.join("\n");
    for (let i = 0; i < 60; i++) {
      expect(joined).toContain(`reply ${i} `);
    }
  });

  it("does not split an exchange that fits, and adds no part marker", () => {
    const parts = renderExchangeParts(
      ex({
        anchor: operator("small ask"),
        body: [agent("small reply")],
        session_ref: "s1",
      }),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]).not.toContain("[part ");
    // Identical to the single-row render, so the common case is unchanged.
    expect(parts[0]).toBe(
      renderExchange(
        ex({
          anchor: operator("small ask"),
          body: [agent("small reply")],
          session_ref: "s1",
        }),
      ),
    );
  });

  it("bounds the repeated head, so a huge operator turn cannot blow every part", () => {
    // Measured on the live corpus 2026-07-28: a 15,430-char operator turn. The
    // head is repeated on EVERY part, so an unbounded head produced 350 parts of
    // ~15,600 chars each -- every one of them ~4x over the ceiling, with the
    // packing loop starved down to one turn per part. Nothing was lost and the
    // output was useless, which is the truncation defect inverted.
    const parts = renderExchangeParts(
      ex({
        anchor: operator(`START-MARKER ${"z".repeat(20_000)}`),
        body: Array.from({ length: 30 }, (_, i) =>
          agent(`reply ${i} ${"y".repeat(400)}`),
        ),
        session_ref: "s1",
      }),
    );

    // PART 1 CARRIES HIS WORDS IN FULL -- all 20,000 characters of them.
    expect(parts[0]!).toContain("z".repeat(20_000));
    for (const part of parts) {
      // Every part still opens with operator context, so no part reads as
      // agent text the operator is being asked to own.
      expect(part.startsWith("OPERATOR")).toBe(true);
    }
    // Later parts carry a continuation line rather than a second copy of a
    // 20,000-char head, which is what starved the packing loop into one turn
    // per part and produced 350 parts for 350 turns.
    expect(parts.length).toBeLessThan(30);
  });

  it("numbers the parts so a reader knows a piece is a piece", () => {
    const parts = renderExchangeParts(
      ex({
        anchor: operator("go"),
        body: Array.from({ length: 40 }, (_, i) =>
          agent(`turn ${i} ${"q".repeat(500)}`),
        ),
        session_ref: "s1",
      }),
    );
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((part, index) => {
      expect(part).toContain(`[part ${index + 1} of ${parts.length}]`);
    });
  });

  it("keeps ALL of the operator's words when the head alone is enormous", () => {
    // This asserted the head was cut at ~1,200 characters. A real 15,430-char
    // operator turn on the live corpus was being stored as 1,200. His words are
    // the thing being graded; they are kept.
    const content = renderExchange(
      ex({
        anchor: operator(`START-MARKER ${"z".repeat(50_000)}`),
        body: [agent("reply")],
        session_ref: "s1",
      }),
    );
    expect(content.startsWith("OPERATOR: START-MARKER")).toBe(true);
    expect(content).toContain("z".repeat(50_000));
    expect(content).not.toContain("truncated");
  });

  it("says plainly when there is no operator turn instead of promoting agent text", () => {
    // Rendering agent text in the position the operator's words occupy
    // everywhere else would read as though he had said it.
    const content = renderExchange(
      ex({
        anchor: null,
        body: [agent("session resumed")],
        session_ref: "s1",
      }),
    );
    expect(content).toContain("no operator turn");
    expect(content.startsWith("OPERATOR: (no operator turn")).toBe(true);
  });
});

/**
 * The FIRST prepared row for an exchange, or undefined when nothing was
 * emitted.
 *
 * prepareExchange returns a LIST since 044 -- an over-length exchange splits
 * across rows instead of truncating. Every assertion below that reads one field
 * (classification, provenance, anchor) is about the exchange as a whole, and
 * those fields are identical on every part, so reading the head is exact rather
 * than a convenience. Tests that are specifically about splitting call
 * prepareExchange directly and assert on the whole list.
 */
function firstPart(
  exchange: Parameters<typeof prepareExchange>[0],
): PreparedExchangeCandidate | undefined {
  return prepareExchange(exchange)[0];
}

describe("prepareExchange", () => {
  it("names every turn of the exchange as a source, head first", () => {
    const anchor = operator("do the thing");
    const a = agent("doing it");
    const t = tool("[tool_use: Bash]");
    const prepared = firstPart(
      ex({
        anchor,
        body: [a, t],
        session_ref: "s1",
      }),
    )!;

    expect(prepared.source_turn_ids).toEqual([anchor.id, a.id, t.id]);
    expect(prepared.anchor_turn_id).toBe(anchor.id);
    expect(prepared.operator_text).toBe("do the thing");
    expect(prepared.unit_kind).toBe("exchange");
    expect(prepared.model).toBe(EXCHANGE_DISTILLER_NAME);
  });

  it("classifies from the OPERATOR's turn, not the agent's reply", () => {
    // The second half of the defect. The agent's reply here is a plain factual
    // report -- the fragment unit called it `fact`, which is how `fact` reached
    // 612 with zero operator-anchored rows. The operator asked a question, so
    // the exchange is a decision context.
    const prepared = firstPart(
      ex({
        anchor: operator("I can't decide whether to move it now or wait"),
        body: [agent("Drizzle isn't a dependency and there's no config.")],
        session_ref: "s1",
      }),
    )!;
    expect(prepared.candidate_type).toBe("decision");
  });

  it("classifies a correction from the operator's own words", () => {
    const prepared = firstPart(
      ex({
        anchor: operator("no, that's not what I said -- revert it"),
        body: [agent("Reverted.")],
        session_ref: "s1",
      }),
    )!;
    expect(prepared.candidate_type).toBe("correction");
  });

  it("classifies a stated preference", () => {
    const prepared = firstPart(
      ex({
        anchor: operator("I prefer the batched form over per-keystroke writes"),
        body: [],
        session_ref: "s1",
      }),
    )!;
    expect(prepared.candidate_type).toBe("preference");
    expect(prepared.uncertain).toBe(false);
  });

  it("emits a bare acknowledgement, uncertain, with the authorized work in it", () => {
    // Under the fragment unit this read "Operator approved: 'go for it'" and the
    // reviewer had to go find what was approved. Here the body IS the content.
    const prepared = firstPart(
      ex({
        anchor: operator("go for it"),
        body: [agent("Migrating the schema now."), tool("[tool_use: Bash]")],
        session_ref: "s1",
      }),
    )!;
    expect(prepared.candidate_type).toBe("decision");
    expect(prepared.uncertain).toBe(true);
    expect(prepared.uncertainty_reason).toContain("acknowledgement");
    expect(prepared.content).toContain("Migrating the schema now.");
  });

  it("emits a short operator turn with no length floor", () => {
    // dream-light.ts:161-176: a 2-character turn can be the whole decision, and
    // 037 removed every pre-filter. "Everything passes" is asserted, not assumed.
    const prepared = firstPart(
      ex({
        anchor: operator("go"),
        body: [],
        session_ref: "s1",
      }),
    )!;
    expect(prepared).not.toBeNull();
    expect(prepared.operator_text).toBe("go");
  });

  it("flags an orphan uncertain and gives it no anchor or operator text", () => {
    const prepared = firstPart(
      ex({
        anchor: null,
        body: [agent("session resumed")],
        session_ref: "s1",
      }),
    )!;
    expect(prepared.anchor_turn_id).toBeNull();
    expect(prepared.operator_text).toBeNull();
    expect(prepared.uncertain).toBe(true);
    expect(prepared.uncertainty_reason).toContain("orphan");
  });

  it("degrades an unusable anchor to an orphan rather than dropping the body", () => {
    // 041's candidate_memory_anchor_has_text would reject a row claiming an
    // anchor with no operator_text. The agent activity below it is still real.
    const prepared = firstPart(
      ex({
        anchor: operator("[Request interrupted by user]"),
        body: [agent("real work happened here")],
        session_ref: "s1",
      }),
    )!;
    expect(prepared.anchor_turn_id).toBeNull();
    expect(prepared.operator_text).toBeNull();
    expect(prepared.content).toContain("real work happened here");
  });

  it("emits nothing only when there is nothing at all to write", () => {
    // Not a salience judgement -- candidate_memory_content_check. An orphan whose
    // every body turn is empty has no content to store. Empty list rather than
    // null since 044; the rejection itself is unchanged.
    expect(
      prepareExchange(
        ex({
          anchor: null,
          body: [agent("   "), agent("")],
          session_ref: "s1",
        }),
      ),
    ).toEqual([]);
  });

  it("takes the namespace from the turns, never from a caller argument", () => {
    const prepared = firstPart(
      ex({
        anchor: operator("scoped", { namespace: "shared-kb" }),
        body: [],
        session_ref: "s1",
      }),
    )!;
    expect(prepared.namespace).toBe("shared-kb");
  });

  it("gives two different exchanges two different content hashes", () => {
    const a = firstPart(
      ex({
        anchor: operator("first ask"),
        body: [agent("first reply")],
        session_ref: "s1",
      }),
    )!;
    const b = firstPart(
      ex({
        anchor: operator("second ask"),
        body: [agent("second reply")],
        session_ref: "s1",
      }),
    )!;
    expect(a.content_hash).not.toBe(b.content_hash);
  });

  it("gives an identical exchange the same hash, so a re-run dedupes", () => {
    const build = () =>
      firstPart(
        ex({
          anchor: operator("same ask", {
            id: "22222222-2222-4222-8222-222222222222",
          }),
          body: [
            agent("same reply", { id: "33333333-3333-4333-8333-333333333333" }),
          ],
          session_ref: "s1",
        }),
      )!;
    expect(build().content_hash).toBe(build().content_hash);
  });
});

describe("extractExchanges", () => {
  it("produces one candidate per exchange over a whole corpus", () => {
    const turns = [
      agent("orphan head"),
      operator("first ask"),
      agent("first reply"),
      tool("[tool_use: Bash]"),
      operator("second ask"),
      agent("second reply"),
    ];
    const out = extractExchanges(turns);

    expect(out).toHaveLength(3);
    expect(out.filter((c) => c.anchor_turn_id !== null)).toHaveLength(2);
    expect(out.filter((c) => c.anchor_turn_id === null)).toHaveLength(1);
    // Every turn is accounted for exactly once across the units -- nothing is
    // dropped and nothing is double-counted.
    const claimed = out.flatMap((c) => c.source_turn_ids);
    expect(new Set(claimed).size).toBe(turns.length);
  });

  it("produces exactly one candidate per operator turn", () => {
    // The count property that makes the fix measurable: ~272 operator turns on
    // the live corpus must yield ~272 anchored exchanges, not 167.
    const turns = [
      operator("a"),
      agent("x"),
      agent("y"),
      operator("b"),
      tool("z"),
      operator("c"),
    ];
    const out = extractExchanges(turns);
    const operatorTurns = turns.filter((t) => t.is_human_prompt).length;
    expect(out.filter((c) => c.anchor_turn_id !== null)).toHaveLength(
      operatorTurns,
    );
  });

  it("returns nothing for an empty corpus", () => {
    expect(extractExchanges([])).toEqual([]);
  });
});

/**
 * ASKUSERQUESTION ANSWERS (migration 043).
 *
 * The defect these pin: an AUQ answer is the operator deciding, but the runtime
 * delivers it as a tool_result, so `role='tool'` and `is_human_prompt=false` --
 * and before 043 all six on the live corpus headed NOTHING. Each was swept into
 * the agent body of whatever preceded it, including the operator's instruction
 * to leave `.claude/` untracked, which was then acted on.
 */
describe("isAskUserQuestionAnswer", () => {
  it("matches the tool_result shape the runtime actually delivers", () => {
    expect(isAskUserQuestionAnswer(auq('"Track it?"="No"'))).toBe(true);
  });

  it("does NOT match operator prose that quotes the phrase mid-sentence", () => {
    // The prefix is anchored for exactly this: the operator discussing the
    // feature must not be misfiled as an instance of it. Both halves matter --
    // an unanchored regex trips on the quote, and dropping the role check trips
    // on the operator typing the phrase at the very start of a line.
    //
    // The role assertions below CANNOT see the anchor. `role === 'tool'`
    // short-circuits first (distill-exchange.ts:117-119), so with an operator
    // turn the regex is never evaluated and deleting the `^` leaves them green
    // -- measured: dropping the anchor kept this file at 48 pass / 0 fail. The
    // tool() case underneath is the one that reaches the regex at all, so the
    // anchor is only defended if the phrase is quoted mid-line by something the
    // role gate lets through.
    expect(
      isAskUserQuestionAnswer(
        operator("when The user answered: appears we should badge it as AUQ"),
      ),
    ).toBe(false);
    expect(
      isAskUserQuestionAnswer(
        operator("The user answered: is the prefix I want you to key on"),
      ),
    ).toBe(false);
    expect(
      isAskUserQuestionAnswer(
        tool('grep found: The user answered: "Track it?"="No"'),
      ),
    ).toBe(false);
  });

  it("does not match ordinary tool output", () => {
    expect(isAskUserQuestionAnswer(tool("2769 pass, 0 fail"))).toBe(false);
  });
});

describe("parseAskUserQuestion", () => {
  it("splits a quoted choice out of the harness wrapper", () => {
    const pairs = parseAskUserQuestion(
      auq('"Should services get their own UID?"="Always own UID (Recommended)"')
        .content,
    );
    expect(pairs).toEqual([
      {
        question: "Should services get their own UID?",
        answer: "Always own UID (Recommended)",
        notes: null,
      },
    ]);
  });

  it("treats (no option selected) with notes as a real answer, not a missing one", () => {
    // 2 of the 6 live turns are this shape, and one of them is the `.claude/`
    // decision that was acted on. Reading it as "no answer" would discard the
    // densest decision content in the corpus.
    const pairs = parseAskUserQuestion(
      auq(
        '"`.claude/` is gitignored. Track it?"=(no option selected) notes: for the most part we DO NOT track .claude.',
      ).content,
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.answer).toBeNull();
    expect(pairs[0]!.notes).toContain("we DO NOT track .claude");
  });

  it("splits several question/answer pairs in one turn", () => {
    const pairs = parseAskUserQuestion(
      auq(
        '"Which scope do you want?"="YOU said there were open PR\'s NOT ME", "What about stale ones?"="see scope"',
      ).content,
    );
    expect(pairs.map((p) => p.answer)).toEqual([
      "YOU said there were open PR's NOT ME",
      "see scope",
    ]);
  });

  it("keeps a comma-rich operator note intact rather than splitting on commas", () => {
    // A live note runs to a paragraph with commas and quotes in it. Splitting on
    // `,` would chop the operator's reasoning in half.
    const pairs = parseAskUserQuestion(
      auq(
        '"Create the logs group?"=(no option selected) notes: It can be part of collab, that already has the same shares, pro con me on it',
      ).content,
    );
    expect(pairs[0]!.notes).toBe(
      "It can be part of collab, that already has the same shares, pro con me on it",
    );
  });

  it("returns nothing for content that is not an AUQ answer", () => {
    expect(parseAskUserQuestion("just some agent prose")).toEqual([]);
  });
});

describe("renderAskUserQuestionHead", () => {
  it("leads with the operator's CHOICE, not the agent's question or the wrapper", () => {
    const rendered = renderAskUserQuestionHead(
      auq('"Should we port it to TypeScript now?"="Wait until after drizzle"')
        .content,
    );
    // The wrapper boilerplate is gone from both ends.
    expect(rendered).not.toContain("The user answered:");
    expect(rendered).not.toContain("Read the answers carefully");
    // And the choice precedes the agent's question, which is the whole point.
    expect(rendered).toContain("CHOSE: Wait until after drizzle");
    expect(rendered.indexOf("CHOSE:")).toBeLessThan(
      rendered.indexOf("agent asked:"),
    );
  });

  it("says the operator refused every option rather than showing nothing", () => {
    const rendered = renderAskUserQuestionHead(
      auq('"Track it?"=(no option selected) notes: we DO NOT track .claude')
        .content,
    );
    expect(rendered).toContain("none of the options offered");
    expect(rendered).toContain("NOTED: we DO NOT track .claude");
  });

  it("marks the unit as AUQ in the text, not only in the column", () => {
    // `content` is read by things that never see anchor_kind -- embeddings,
    // search, anything reading the row directly. The label has to survive there.
    const rendered = renderAskUserQuestionHead(auq('"Q?"="A"').content);
    expect(rendered).toContain("AskUserQuestion");
  });

  it("falls back to the raw text rather than losing a decision it cannot parse", () => {
    // A harness reword must degrade to "renders an ugly wrapper", never to
    // "drops the operator's answer".
    const weird = "The user answered: something in a shape nobody expected";
    expect(renderAskUserQuestionHead(weird)).toContain(
      "a shape nobody expected",
    );
  });
});

describe("AskUserQuestion answers head their own exchange", () => {
  it("cuts a new exchange at an AUQ answer instead of burying it in the body", () => {
    // THE 043 REGRESSION IN ONE ASSERTION. Before the fix this input produced
    // ONE exchange and the operator's decision was body text under the agent.
    const turns = [
      operator("what should we do about .claude?"),
      agent("It is gitignored. Asking."),
      auq('"Track it?"=(no option selected) notes: we DO NOT track .claude'),
      agent("Understood -- leaving it untracked."),
    ];
    const exchanges = buildExchanges(turns);

    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]!.anchor_kind).toBe("typed");
    expect(exchanges[1]!.anchor_kind).toBe("askuserquestion");
    expect(exchanges[1]!.body.map((t) => t.content)).toEqual([
      "Understood -- leaving it untracked.",
    ]);
  });

  it("shortens the preceding exchange, which is the correct consequence", () => {
    // An AUQ answer that used to be body text no longer is. The preceding
    // exchange therefore renders SHORTER and hashes differently -- expected, and
    // the reason the re-run inserts corrected rows rather than editing old ones.
    const before = buildExchanges([
      operator("ask"),
      agent("reply"),
      tool("The user answered: nothing parseable here"),
    ]);
    expect(before).toHaveLength(2);
    expect(before[0]!.body).toHaveLength(1);
  });

  it("gives each AUQ answer exactly one exchange, six turns to six units", () => {
    // The live count. Six AUQ turns exist; six must head units, no more and no
    // fewer -- a parser that merged two of them would be invisible any other way.
    const turns = [
      operator("kick it off"),
      ...Array.from({ length: 6 }, (_, i) =>
        auq(`"Question ${i}?"="Answer ${i}"`),
      ),
    ];
    const out = extractExchanges(turns);
    expect(out.filter((c) => c.anchor_kind === "askuserquestion")).toHaveLength(
      6,
    );
    expect(out.filter((c) => c.anchor_kind === "typed")).toHaveLength(1);
  });

  it("carries anchor_kind onto the prepared candidate for every kind", () => {
    const typed = firstPart(
      ex({ anchor: operator("typed"), body: [], session_ref: "s1" }),
    )!;
    const chosen = firstPart(
      ex({ anchor: auq('"Q?"="A"'), body: [], session_ref: "s1" }),
    )!;
    const orphan = firstPart(
      ex({ anchor: null, body: [agent("resumed")], session_ref: "s1" }),
    )!;
    expect(typed.anchor_kind).toBe("typed");
    expect(chosen.anchor_kind).toBe("askuserquestion");
    expect(orphan.anchor_kind).toBe("orphan");
  });

  it("stores the rendered choice as operator_text, not the harness wrapper", () => {
    // operator_text is what the page puts in the operator's own position. The
    // wrapper opens with the AGENT's question, so storing it raw would put agent
    // words there -- 041's defect, one layer down.
    const prepared = firstPart(
      ex({
        anchor: auq('"Port it now?"="Wait until after drizzle"'),
        body: [],
        session_ref: "s1",
      }),
    )!;
    expect(prepared.operator_text).toContain("CHOSE: Wait until after drizzle");
    expect(prepared.operator_text).not.toContain("The user answered:");
    // And the rendered content agrees with it, since the page shows both.
    expect(prepared.content).toContain("CHOSE: Wait until after drizzle");
  });

  it("classifies an AUQ exchange from the operator's answer, not the agent's question", () => {
    // Agent questions are dense in DECISION_RE stems ("Should we...", "must",
    // "use "). Classifying from the raw string would let the agent's framing
    // decide what the operator's answer WAS.
    const prepared = firstPart(
      ex({
        anchor: auq(
          '"Should we always use the batched form?"="no, that is wrong -- revert it"',
        ),
        body: [],
        session_ref: "s1",
      }),
    )!;
    expect(prepared.candidate_type).toBe("correction");
  });

  it("still heads its own exchange when the pairs are unparseable", () => {
    // The fallback direction is deliberate: an unrecognised AUQ body renders as
    // its raw text, so it remains a real head. Degrading it to an orphan would
    // throw away an operator decision because a harness reworded its own
    // punctuation, which is the failure 043 exists to end -- not repeat.
    const prepared = firstPart(
      ex({
        anchor: tool("The user answered: something unexpected"),
        body: [agent("real work")],
        session_ref: "s1",
      }),
    )!;
    expect(prepared.anchor_kind).toBe("askuserquestion");
    expect(prepared.operator_text).toContain("something unexpected");
    expect(prepared.content).toContain("real work");
  });

  it("degrades an AUQ head with no words in it at all to an orphan", () => {
    // candidate_memory_anchor_has_text would reject a row claiming an anchor
    // with no operator_text, so an empty head must not claim to be one.
    const prepared = firstPart(
      ex({
        anchor: tool("The user answered:   "),
        body: [agent("real work")],
        session_ref: "s1",
      }),
    )!;
    expect(prepared.anchor_kind).toBe("orphan");
    expect(prepared.operator_text).toBeNull();
    expect(prepared.content).toContain("real work");
  });
});

describe("anchorKindOf", () => {
  it("tells a typed head apart from a chosen one and from no head at all", () => {
    expect(anchorKindOf(operator("typed it"))).toBe("typed");
    expect(anchorKindOf(auq('"Q?"="A"'))).toBe("askuserquestion");
    expect(anchorKindOf(null)).toBe("orphan");
  });
});
