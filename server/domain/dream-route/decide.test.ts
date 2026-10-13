import { describe, expect, it } from "vitest";
import type { JevAnswer } from "../../integrations/jev.ts";
import { DEFAULT_THRESHOLDS, decideRoute } from "./decide.ts";
import { DEFAULT_MATRIX_PATH, loadMatrix } from "./matrix.ts";
import { DEST_ID, DROVE_DECISION_ID, RESTATES_ID, ynId } from "./questions.ts";
import { DESTINATIONS, type Destination, type RouteCandidate } from "./types.ts";

const matrix = loadMatrix(DEFAULT_MATRIX_PATH);

const candidate = (over: Partial<RouteCandidate> = {}): RouteCandidate => ({
  id: "c1",
  namespace: "shared-kb",
  candidateType: "fact",
  content: "content",
  operatorText: null,
  unitKind: "exchange",
  anchorKind: "typed",
  ...over,
});

function choiceAnswer(choice: Destination, probability: number): JevAnswer {
  const rest = (1 - probability) / (DESTINATIONS.length - 1);
  return {
    type: "choice",
    choice,
    probabilities: Object.fromEntries(
      DESTINATIONS.map((name) => [name, name === choice ? probability : rest]),
    ),
    confidence: probability,
  };
}

function answers(options: {
  choice?: Destination;
  choiceP?: number;
  yn?: Partial<Record<Destination, number>>;
  restates?: number;
  drove?: number;
}): Record<string, JevAnswer> {
  const built: Record<string, JevAnswer> = {};
  if (options.choice)
    built[DEST_ID] = choiceAnswer(options.choice, options.choiceP ?? 0.9);
  for (const name of DESTINATIONS) {
    built[ynId(name)] = { type: "noul", noul: options.yn?.[name] ?? 0.1 };
  }
  built[RESTATES_ID] = { type: "noul", noul: options.restates ?? 0 };
  built[DROVE_DECISION_ID] = { type: "noul", noul: options.drove ?? 0 };
  return built;
}

describe("decideRoute", () => {
  it("is high when all three picks name the same destination", () => {
    const decision = decideRoute(
      candidate({ candidateType: "fact" }),
      answers({ choice: "fact", yn: { fact: 0.9 } }),
      matrix,
      DEFAULT_THRESHOLDS,
    );
    expect(decision.agreement).toBe("high");
    expect(decision.destination).toBe("fact");
    expect(decision.candidateId).toBe("c1");
    expect(decision.reasons).toHaveLength(4);
    expect(decision.reasons[3]).toContain("all three picks named fact");
  });

  it("is low when only the choice and the yes/no agree", () => {
    const decision = decideRoute(
      candidate({ candidateType: "correction" }),
      answers({ choice: "fact", yn: { fact: 0.9 } }),
      matrix,
      DEFAULT_THRESHOLDS,
    );
    expect(decision.agreement).toBe("low");
    expect(decision.destination).toBe("fact");
  });

  it("is low when only the choice and the distiller agree", () => {
    const decision = decideRoute(
      candidate({ candidateType: "fact" }),
      answers({ choice: "fact", yn: { decision: 0.9 } }),
      matrix,
      DEFAULT_THRESHOLDS,
    );
    expect(decision.agreement).toBe("low");
    expect(decision.destination).toBe("fact");
  });

  it("is low when only the yes/no and the distiller agree", () => {
    const decision = decideRoute(
      candidate({ candidateType: "fact" }),
      answers({ choice: "decision", yn: { fact: 0.9 } }),
      matrix,
      DEFAULT_THRESHOLDS,
    );
    expect(decision.agreement).toBe("low");
    expect(decision.destination).toBe("fact");
  });
});

describe("decideRoute abstentions", () => {
  it("is none on a three-way split", () => {
    const decision = decideRoute(
      candidate({ candidateType: "fact" }),
      answers({ choice: "decision", yn: { correction: 0.9 } }),
      matrix,
      DEFAULT_THRESHOLDS,
    );
    expect(decision.agreement).toBe("none");
    expect(decision.destination).toBeNull();
    expect(decision.reasons[3]).toContain("no two picks named the same destination");
  });

  it("does not let a choice below the cutoff vote", () => {
    const decision = decideRoute(
      candidate({ candidateType: "fact" }),
      answers({ choice: "decision", choiceP: 0.4, yn: { fact: 0.9 } }),
      matrix,
      DEFAULT_THRESHOLDS,
    );
    expect(decision.agreement).toBe("low");
    expect(decision.destination).toBe("fact");
    expect(decision.reasons[0]).toContain("did not vote");
  });

  it("does not let a yes/no below the cutoff vote", () => {
    const decision = decideRoute(
      candidate({ candidateType: "decision" }),
      answers({ choice: "fact", yn: { fact: 0.4 } }),
      matrix,
      DEFAULT_THRESHOLDS,
    );
    expect(decision.agreement).toBe("none");
    expect(decision.destination).toBeNull();
    expect(decision.reasons[1]).toContain("below the 0.5 cutoff");
  });

  it("treats an exact tie for the strongest yes/no as no vote", () => {
    const decision = decideRoute(
      candidate({ candidateType: "decision" }),
      answers({ choice: "fact", yn: { fact: 0.9, rule: 0.9 } }),
      matrix,
      DEFAULT_THRESHOLDS,
    );
    expect(decision.reasons[1]).toContain("tied at 0.9");
    expect(decision.agreement).toBe("none");
  });

  it("maps a preference candidate onto rule", () => {
    const decision = decideRoute(
      candidate({ candidateType: "preference" }),
      answers({ choice: "rule", yn: { rule: 0.9 } }),
      matrix,
      DEFAULT_THRESHOLDS,
    );
    expect(decision.agreement).toBe("high");
    expect(decision.destination).toBe("rule");
    expect(decision.reasons[2]).toContain("preference");
    expect(decision.reasons[2]).toContain("rule");
  });

  it("keeps the documented default thresholds as unmeasured guesses", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      pickAt: 0.5,
      yesAt: 0.5,
      restatedAt: 0.7,
      droveDecisionAt: 0.7,
      measuredIn: "",
    });
  });
});

describe("decideRoute flags", () => {
  it.each([
    [0.69, false],
    [0.7, true],
    [0.71, true],
  ])("flags restates at %s as %s", (value, expected) => {
    const decision = decideRoute(
      candidate(),
      answers({ choice: "fact", yn: { fact: 0.9 }, restates: value }),
      matrix,
      DEFAULT_THRESHOLDS,
    );
    expect(decision.restates).toBe(expected);
  });

  it.each([
    [0.69, false],
    [0.7, true],
    [0.71, true],
  ])("flags droveDecision at %s as %s", (value, expected) => {
    const decision = decideRoute(
      candidate(),
      answers({ choice: "fact", yn: { fact: 0.9 }, drove: value }),
      matrix,
      DEFAULT_THRESHOLDS,
    );
    expect(decision.droveDecision).toBe(expected);
  });

  it("carries the authority tier and flattens every answer into raw", () => {
    const decision = decideRoute(
      candidate({ unitKind: "fragment" }),
      answers({ choice: "fact", choiceP: 0.8, yn: { fact: 0.9 }, restates: 0.25 }),
      matrix,
      DEFAULT_THRESHOLDS,
    );
    expect(decision.authorityTier).toBe("observed");
    expect(decision.raw[DEST_ID]).toBe("fact");
    expect(decision.raw[`${DEST_ID}.p`]).toBe(0.8);
    expect(decision.raw[ynId("fact")]).toBe(0.9);
    expect(decision.raw[RESTATES_ID]).toBe(0.25);
  });
});

describe("decideRoute with a missing answer", () => {
  it("reports no signal when the choice answer is missing", () => {
    const decision = decideRoute(
      candidate(),
      answers({ yn: { fact: 0.9 } }),
      matrix,
      DEFAULT_THRESHOLDS,
    );
    expect(decision.agreement).toBe("none");
    expect(decision.destination).toBeNull();
    expect(decision.restates).toBe(false);
    expect(decision.reasons[0]).toMatch(/^no signal: /);
    expect(decision.reasons[0]).toContain(DEST_ID);
  });

  it("reports no signal when a yes/no answer is of the wrong type", () => {
    const built = answers({ choice: "fact", yn: { fact: 0.9 } });
    built[ynId("rule")] = choiceAnswer("rule", 0.9);
    const decision = decideRoute(candidate(), built, matrix, DEFAULT_THRESHOLDS);
    expect(decision.reasons[0]).toMatch(/^no signal: /);
    expect(decision.reasons[0]).toContain("yes/no");
  });

  it("reports no signal when a flag answer is missing, without throwing", () => {
    const built = answers({ choice: "fact", yn: { fact: 0.9 } });
    delete built[DROVE_DECISION_ID];
    const decision = decideRoute(candidate(), built, matrix, DEFAULT_THRESHOLDS);
    expect(decision.reasons[0]).toContain(DROVE_DECISION_ID);
    expect(decision.droveDecision).toBe(false);
  });
});
