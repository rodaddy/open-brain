/**
 * Functional tests for option composition.
 *
 * The properties that matter are the ones that make the page usable: exactly
 * one default, options that actually differ, and nothing offered that Terra
 * did not say.
 */

import { describe, expect, it } from "bun:test";
import { composeOptions, composeRunOptions } from "./rem-distill-options.ts";
import type { TerraJudgement } from "./rem-terra-grader.ts";

function judgement(over: Partial<TerraJudgement> = {}): TerraJudgement {
  return {
    id: "c1",
    score: 8,
    label: "DECISION",
    quote: "we keep a copy of all issues",
    synopsis: "agent mirrored the issues and confirmed",
    agent_behavior: "neutral",
    reasons: [
      "durable cross-repo knowledge architecture",
      "prevents repeated planning",
      "operator states intended ongoing practice",
    ],
    ...over,
  };
}

describe("option composition", () => {
  it("marks exactly one option as the default, and it matches Terra", () => {
    const options = composeOptions(judgement({ score: 8 }));
    const defaults = options.filter((o) => o.is_default);

    // One click to agree is the whole ergonomic requirement.
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.score).toBe(8);
    expect(defaults[0]!.code).toBe("agree");
  });

  it("offers a narrower reading when Terra scored high and hedged", () => {
    const options = composeOptions(
      judgement({
        score: 9,
        reasons: ["durable rule", "specific to an active batch of work"],
      }),
    );

    const narrower = options.find((o) => o.code === "less_durable_than_scored");
    expect(narrower).toBeDefined();
    // Below the promote cut, so disagreeing changes the verdict rather than
    // only nudging the queue order.
    expect(narrower!.score).toBeLessThan(5);
  });

  it("offers a keep-it option when Terra scored low but saw something durable", () => {
    const options = composeOptions(
      judgement({
        score: 3,
        reasons: ["short transient question", "states a standing rule anyway"],
      }),
    );

    const keep = options.find((o) => o.code === "more_durable_than_scored");
    expect(keep).toBeDefined();
    expect(keep!.score).toBeGreaterThan(5);
  });

  it("surfaces bad agent behavior as a reason to KEEP, not to drop", () => {
    const options = composeOptions(
      judgement({
        score: 6,
        agent_behavior: "bad",
        reasons: ["visible response ignored the stated boundary"],
      }),
    );

    const behavior = options.find((o) => o.code === "keep_for_the_mistake");
    expect(behavior).toBeDefined();
    // "a high-value memory often records BAD agent behavior, and those are
    // among the most worth keeping" -- it must not sink the item.
    expect(behavior!.score).toBeGreaterThanOrEqual(7);
  });

  it("omits an option rather than inventing one Terra did not support", () => {
    // No durability angle, no behavior angle -- nothing to derive from.
    const options = composeOptions(
      judgement({
        score: 9,
        agent_behavior: "neutral",
        reasons: ["nothing matching"],
      }),
    );

    expect(
      options.find((o) => o.code === "less_durable_than_scored"),
    ).toBeUndefined();
    expect(
      options.find((o) => o.code === "keep_for_the_mistake"),
    ).toBeUndefined();
    // Agree and the escape hatch always survive.
    expect(options.map((o) => o.code)).toEqual(["agree", "drop_it"]);
  });

  it("cites the Terra reason each derived option came from", () => {
    const options = composeOptions(
      judgement({ score: 9, reasons: ["durable rule", "may evolve later"] }),
    );

    for (const option of options) {
      // The fixed escape hatch is the only undrived one.
      if (option.code === "drop_it") continue;
      expect(option.derived_from).toBeTruthy();
    }
  });

  it("always offers a way out, whatever Terra said", () => {
    for (const score of [0, 5, 10]) {
      const options = composeOptions(judgement({ score }));
      expect(options.some((o) => o.code === "drop_it")).toBe(true);
    }
  });

  it("keys a whole run by candidate id", () => {
    const map = composeRunOptions([
      judgement({ id: "a" }),
      judgement({ id: "b", score: 2 }),
    ]);

    expect([...map.keys()]).toEqual(["a", "b"]);
    expect(map.get("b")!.find((o) => o.is_default)!.score).toBe(2);
  });
});
