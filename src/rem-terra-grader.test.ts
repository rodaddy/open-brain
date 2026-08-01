/**
 * Functional tests for the Terra grader. No model, no database.
 *
 * These drive the grader through a fake transport, which is the boundary that
 * matters: what it sends, what it does with what comes back, and what it does
 * when what comes back is wrong. Every case here is a failure mode measured in
 * round two or named in the design, not a hypothetical.
 */

import { describe, expect, it } from "bun:test";
import {
  createTerraGrader,
  interactionShape,
  PROMOTE_AT,
  type TerraJudgement,
} from "./rem-terra-grader.ts";
import type { RemCandidate } from "./dream-rem.ts";

function candidate(id: string, over: Partial<RemCandidate> = {}): RemCandidate {
  return {
    id,
    namespace: "rico",
    candidate_type: "fact",
    content: `content for ${id}`,
    content_hash: `hash-${id}`,
    uncertain: false,
    uncertainty_reason: null,
    model: "exchange-distiller/v1",
    session_count: 0,
    occurrence_count: 0,
    reinforcement_count: 0,
    ...over,
  };
}

function judgement(
  id: string,
  score: number,
  over: Partial<TerraJudgement> = {},
): TerraJudgement {
  return {
    id,
    score,
    label: "DECISION",
    quote: "a thing the operator said",
    synopsis: "ran two greps, found the file, said so",
    agent_behavior: "good",
    reasons: [
      "keeps a rule",
      "restates a standing rule",
      "the correction is the durable part",
    ],
    ...over,
  };
}

describe("Terra grader", () => {
  it("maps a high score to promoted and a low score to inconclusive", async () => {
    const grader = createTerraGrader({
      transport: async ({ items }) =>
        items.map((item, index) => judgement(item.id, index === 0 ? 9 : 1)),
    });

    const cands = [candidate("a"), candidate("b")];
    await grader.prime(cands);

    expect((await grader.grade(cands[0]!)).grade).toBe("promoted");
    expect((await grader.grade(cands[1]!)).grade).toBe("inconclusive");
  });

  it("cuts at PROMOTE_AT inclusively", async () => {
    const grader = createTerraGrader({
      transport: async ({ items }) =>
        items.map((item, index) =>
          judgement(item.id, index === 0 ? PROMOTE_AT : PROMOTE_AT - 1),
        ),
    });

    const cands = [candidate("at"), candidate("below")];
    await grader.prime(cands);

    expect((await grader.grade(cands[0]!)).grade).toBe("promoted");
    expect((await grader.grade(cands[1]!)).grade).toBe("inconclusive");
  });

  it("never emits rejected, however low the score", async () => {
    const grader = createTerraGrader({
      transport: async ({ items }) => items.map((i) => judgement(i.id, 0)),
    });

    const c = candidate("zero");
    await grader.prime([c]);

    // The same refusal heuristicRemGrader makes: under "let everything pass" a
    // negative guess cannot suppress anything, so it buys nothing.
    expect((await grader.grade(c)).grade).toBe("inconclusive");
  });

  it("falls back to the heuristic for a candidate Terra omitted", async () => {
    const grader = createTerraGrader({
      // Returns a judgement for 'a' only -- 'b' is silently dropped, which is
      // what round two measured sonnet-low doing (46 and 49 of 50 returned).
      transport: async ({ items }) => [judgement(items[0]!.id, 8)],
    });

    const kept = candidate("a");
    const dropped = candidate("b", { session_count: 3 });
    await grader.prime([kept, dropped]);

    expect((await grader.grade(kept)).grade).toBe("promoted");

    // The heuristic promotes on corroboration, so the fallback is doing the
    // work rather than defaulting blindly to inconclusive.
    const fallback = await grader.grade(dropped);
    expect(fallback.grade).toBe("promoted");
    expect(fallback.reason).toContain("corroborated across 3 sessions");
  });

  it("discards a judgement whose id was never sent", async () => {
    const warnings: string[] = [];
    const grader = createTerraGrader({
      transport: async ({ items }) => [
        judgement(items[0]!.id, 9),
        judgement("id-terra-invented", 10),
      ],
      logger: { warn: (event) => warnings.push(event) },
    });

    const real = candidate("real");
    await grader.prime([real]);

    // Measured, round two: sonnet-low "returned 51 on p3, meaning it invented
    // an id". A judgement against a fabricated id must attach to nothing.
    expect(grader.judgementFor("id-terra-invented")).toBeUndefined();
    expect(warnings).toContain("rem_terra_unknown_id");
    expect((await grader.grade(real)).grade).toBe("promoted");
  });

  it("survives a failed batch and still grades the others", async () => {
    const warnings: string[] = [];
    let call = 0;
    const grader = createTerraGrader({
      batchSize: 1,
      transport: async ({ items }) => {
        call += 1;
        if (call === 1) throw new Error("transport exploded");
        return items.map((i) => judgement(i.id, 9));
      },
      logger: { warn: (event) => warnings.push(event) },
    });

    const lost = candidate("lost", { session_count: 4 });
    const kept = candidate("kept");
    await grader.prime([lost, kept]);

    expect(warnings).toContain("rem_terra_batch_failed");
    // The failed batch's candidate falls back; the second batch is unaffected.
    expect((await grader.grade(lost)).reason).toContain("corroborated");
    expect((await grader.grade(kept)).grade).toBe("promoted");
  });

  it("sends the round-three prompt and schema, and chunks by batch size", async () => {
    const sent: Array<{ count: number; model: string; effort: string }> = [];
    const grader = createTerraGrader({
      batchSize: 2,
      transport: async ({ items, model, effort, prompt, schema }) => {
        sent.push({ count: items.length, model, effort });
        // The instructions that were measured must actually travel.
        expect(prompt).toContain("SYNOPSIS");
        expect(prompt).toContain("REASONS");
        // The priors only work if their framing travels with them.
        expect(prompt).toContain("turn_count");
        expect(prompt).toContain("READ THE ENTIRE TOOL CHAIN");
        expect(schema).toBeDefined();
        return items.map((i) => judgement(i.id, 7));
      },
    });

    await grader.prime([candidate("a"), candidate("b"), candidate("c")]);

    expect(sent.map((s) => s.count)).toEqual([2, 1]);
    expect(sent[0]!.model).toBe("gpt-5.6-terra");
    expect(sent[0]!.effort).toBe("low");
  });

  it("clears the cache on re-prime so a stale judgement cannot be served", async () => {
    let score = 9;
    const grader = createTerraGrader({
      transport: async ({ items }) => items.map((i) => judgement(i.id, score)),
    });

    const first = candidate("first");
    await grader.prime([first]);
    expect((await grader.grade(first)).grade).toBe("promoted");

    // A second pass over different candidates must not leave the first pass's
    // judgement addressable -- serving it would look like data and be nothing.
    score = 2;
    await grader.prime([candidate("second")]);
    expect(grader.judgementFor("first")).toBeUndefined();
    expect((await grader.grade(first)).grade).toBe("inconclusive");
  });

  it("counts back-and-forth turns, not tool calls", () => {
    // "more than one back and forth" is about exchange. An agent that ran six
    // greps inside one reply has not gone back and forth six times, so tool
    // lines must not inflate the count the operator's prior depends on.
    const shape = interactionShape(
      [
        "OPERATOR: fix the thing",
        "agent: checking first",
        "tool: 15 matches",
        "tool: 3 matches",
        "agent: found it, fixed",
      ].join("\n"),
    );

    expect(shape.turn_count).toBe(3); // operator + 2 agent replies
    expect(shape.operator_chars).toBe("fix the thing".length);
    // Tool output is excluded from the agent's own volume.
    expect(shape.agent_chars).toBeLessThan(40);
  });

  it("treats an exchange with no agent reply as a single turn", () => {
    const shape = interactionShape("OPERATOR: just a thought");
    expect(shape.turn_count).toBe(1);
    expect(shape.agent_chars).toBe(0);
  });

  it("sends the interaction shape alongside each item", async () => {
    let seen: Array<Record<string, unknown>> = [];
    const grader = createTerraGrader({
      transport: async ({ items }) => {
        seen = items as unknown as Array<Record<string, unknown>>;
        return items.map((i) => judgement(i.id, 6));
      },
    });

    await grader.prime([
      candidate("a", { content: "OPERATOR: a long ask\nagent: a reply" }),
    ]);

    // Terra cannot count what it cannot see; the priors depend on these.
    expect(seen[0]!.turn_count).toBe(2);
    expect(seen[0]!.operator_chars).toBe("a long ask".length);
  });

  it("keeps the synopsis as the reason, since that is what explains placement", async () => {
    const grader = createTerraGrader({
      transport: async ({ items }) =>
        items.map((i) =>
          judgement(i.id, 8, { synopsis: "claimed a fix with no test run" }),
        ),
    });

    const c = candidate("s");
    await grader.prime([c]);
    expect((await grader.grade(c)).reason).toBe(
      "claimed a fix with no test run",
    );
  });
});
