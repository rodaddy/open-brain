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
  buildExchanges,
  extractExchanges,
  prepareExchange,
  renderExchange,
  EXCHANGE_DISTILLER_NAME,
} from "./distill-exchange.ts";
import { MAX_CANDIDATE_CHARS } from "./distiller.ts";
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
    const content = renderExchange({
      anchor: operator("should the curation logic move to TypeScript now?"),
      body: [agent("Drizzle isn't a dependency and there's no config.")],
      session_ref: "s1",
    });
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
    const content = renderExchange({
      anchor: operator("run the tests"),
      body: [tool("[tool_use: Bash]"), agent("2695 pass, 0 fail")],
      session_ref: "s1",
    });
    expect(content).toContain("tool: [tool_use: Bash]");
    expect(content).toContain("agent: 2695 pass, 0 fail");
  });

  it("truncates the BODY and never the operator's head", () => {
    // The load-bearing property. Exchanges run to 208 turns on the live corpus,
    // so truncation is the normal case -- and cutting the head would recreate
    // exactly the "grade a fragment of your own conversation" defect.
    const head = `decide this: ${"x".repeat(800)}`;
    const content = renderExchange({
      anchor: operator(head),
      body: Array.from({ length: 60 }, (_, i) =>
        agent(`reply ${i} ${"y".repeat(500)}`),
      ),
      session_ref: "s1",
    });

    expect(content.length).toBeLessThanOrEqual(MAX_CANDIDATE_CHARS);
    expect(content.startsWith(`OPERATOR: ${head}`)).toBe(true);
    // And it says so, rather than silently losing the tail.
    expect(content).toContain("further turn(s) omitted for length");
  });

  it("keeps the operator's opening words even when the head alone is enormous", () => {
    // The ingest cap is 200,000 chars, so a single pathological operator turn
    // must still not violate the embedding limit -- and the cut must land at the
    // END, not the start.
    const content = renderExchange({
      anchor: operator(`START-MARKER ${"z".repeat(50_000)}`),
      body: [agent("reply")],
      session_ref: "s1",
    });
    expect(content.length).toBeLessThanOrEqual(MAX_CANDIDATE_CHARS);
    expect(content.startsWith("OPERATOR: START-MARKER")).toBe(true);
  });

  it("says plainly when there is no operator turn instead of promoting agent text", () => {
    // Rendering agent text in the position the operator's words occupy
    // everywhere else would read as though he had said it.
    const content = renderExchange({
      anchor: null,
      body: [agent("session resumed")],
      session_ref: "s1",
    });
    expect(content).toContain("no operator turn");
    expect(content.startsWith("OPERATOR: (no operator turn")).toBe(true);
  });
});

describe("prepareExchange", () => {
  it("names every turn of the exchange as a source, head first", () => {
    const anchor = operator("do the thing");
    const a = agent("doing it");
    const t = tool("[tool_use: Bash]");
    const prepared = prepareExchange({
      anchor,
      body: [a, t],
      session_ref: "s1",
    })!;

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
    const prepared = prepareExchange({
      anchor: operator("I can't decide whether to move it now or wait"),
      body: [agent("Drizzle isn't a dependency and there's no config.")],
      session_ref: "s1",
    })!;
    expect(prepared.candidate_type).toBe("decision");
  });

  it("classifies a correction from the operator's own words", () => {
    const prepared = prepareExchange({
      anchor: operator("no, that's not what I said -- revert it"),
      body: [agent("Reverted.")],
      session_ref: "s1",
    })!;
    expect(prepared.candidate_type).toBe("correction");
  });

  it("classifies a stated preference", () => {
    const prepared = prepareExchange({
      anchor: operator("I prefer the batched form over per-keystroke writes"),
      body: [],
      session_ref: "s1",
    })!;
    expect(prepared.candidate_type).toBe("preference");
    expect(prepared.uncertain).toBe(false);
  });

  it("emits a bare acknowledgement, uncertain, with the authorized work in it", () => {
    // Under the fragment unit this read "Operator approved: 'go for it'" and the
    // reviewer had to go find what was approved. Here the body IS the content.
    const prepared = prepareExchange({
      anchor: operator("go for it"),
      body: [agent("Migrating the schema now."), tool("[tool_use: Bash]")],
      session_ref: "s1",
    })!;
    expect(prepared.candidate_type).toBe("decision");
    expect(prepared.uncertain).toBe(true);
    expect(prepared.uncertainty_reason).toContain("acknowledgement");
    expect(prepared.content).toContain("Migrating the schema now.");
  });

  it("emits a short operator turn with no length floor", () => {
    // dream-light.ts:161-176: a 2-character turn can be the whole decision, and
    // 037 removed every pre-filter. "Everything passes" is asserted, not assumed.
    const prepared = prepareExchange({
      anchor: operator("go"),
      body: [],
      session_ref: "s1",
    })!;
    expect(prepared).not.toBeNull();
    expect(prepared.operator_text).toBe("go");
  });

  it("flags an orphan uncertain and gives it no anchor or operator text", () => {
    const prepared = prepareExchange({
      anchor: null,
      body: [agent("session resumed")],
      session_ref: "s1",
    })!;
    expect(prepared.anchor_turn_id).toBeNull();
    expect(prepared.operator_text).toBeNull();
    expect(prepared.uncertain).toBe(true);
    expect(prepared.uncertainty_reason).toContain("orphan");
  });

  it("degrades an unusable anchor to an orphan rather than dropping the body", () => {
    // 041's candidate_memory_anchor_has_text would reject a row claiming an
    // anchor with no operator_text. The agent activity below it is still real.
    const prepared = prepareExchange({
      anchor: operator("[Request interrupted by user]"),
      body: [agent("real work happened here")],
      session_ref: "s1",
    })!;
    expect(prepared.anchor_turn_id).toBeNull();
    expect(prepared.operator_text).toBeNull();
    expect(prepared.content).toContain("real work happened here");
  });

  it("returns null only when there is nothing at all to write", () => {
    // Not a salience judgement -- candidate_memory_content_check. An orphan whose
    // every body turn is empty has no content to store.
    expect(
      prepareExchange({
        anchor: null,
        body: [agent("   "), agent("")],
        session_ref: "s1",
      }),
    ).toBeNull();
  });

  it("takes the namespace from the turns, never from a caller argument", () => {
    const prepared = prepareExchange({
      anchor: operator("scoped", { namespace: "shared-kb" }),
      body: [],
      session_ref: "s1",
    })!;
    expect(prepared.namespace).toBe("shared-kb");
  });

  it("gives two different exchanges two different content hashes", () => {
    const a = prepareExchange({
      anchor: operator("first ask"),
      body: [agent("first reply")],
      session_ref: "s1",
    })!;
    const b = prepareExchange({
      anchor: operator("second ask"),
      body: [agent("second reply")],
      session_ref: "s1",
    })!;
    expect(a.content_hash).not.toBe(b.content_hash);
  });

  it("gives an identical exchange the same hash, so a re-run dedupes", () => {
    const build = () =>
      prepareExchange({
        anchor: operator("same ask", {
          id: "22222222-2222-4222-8222-222222222222",
        }),
        body: [
          agent("same reply", { id: "33333333-3333-4333-8333-333333333333" }),
        ],
        session_ref: "s1",
      })!;
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
