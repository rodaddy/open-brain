import { describe, expect, it } from "vitest";
import type { JevAnswer } from "../../integrations/jev.ts";
import {
  DEFAULT_THRESHOLDS_V2,
  DEST_V2_ID,
  LASTING_ID,
  NONE_OPTION,
  RESTATES_AT_V2,
  RESTATES_PAIR_ID,
  decideRouteV2,
} from "./decide-v2.ts";
import { DEFAULT_MATRIX_PATH, loadMatrix } from "./matrix.ts";
import { DROVE_DECISION_ID } from "./questions.ts";
import { DESTINATIONS, type RouteCandidate } from "./types.ts";

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

const OPTIONS: readonly string[] = [...DESTINATIONS, NONE_OPTION];

function choiceAnswer(
  choice: string,
  probability: number,
  confidence: number,
): JevAnswer {
  const rest = (1 - probability) / (OPTIONS.length - 1);
  return {
    type: "choice",
    choice,
    probabilities: Object.fromEntries(
      OPTIONS.map((name) => [name, name === choice ? probability : rest]),
    ),
    confidence,
  };
}

function answers(o: {
  choice?: string;
  p?: number;
  conf?: number;
  lasting?: number | null;
  drove?: number;
}): Record<string, JevAnswer> {
  const built: Record<string, JevAnswer> = {
    [DEST_V2_ID]: choiceAnswer(o.choice ?? "fact", o.p ?? 0.9, o.conf ?? 0.9),
    [DROVE_DECISION_ID]: { type: "noul", noul: o.drove ?? 0 },
  };
  if (o.lasting !== null) built[LASTING_ID] = { type: "noul", noul: o.lasting ?? 0.9 };
  return built;
}

const decide = (a: Record<string, JevAnswer>) =>
  decideRouteV2(candidate(), a, matrix, DEFAULT_THRESHOLDS_V2);

describe("decideRouteV2", () => {
  it("commits when every cutoff passes", () => {
    const d = decide(answers({}));
    expect(d.destination).toBe("fact");
    expect(d.agreement).toBe("high");
    expect(d.reasons[0]).toContain("every cutoff passed");
  });

  it("commits nothing when the choice is none", () => {
    const d = decide(answers({ choice: NONE_OPTION }));
    expect(d.destination).toBeNull();
    expect(d.agreement).toBe("none");
    expect(d.reasons[0]).toContain("picked none");
  });

  it("commits nothing when anything_lasting is below the cutoff", () => {
    const d = decide(answers({ lasting: 0.2 }));
    expect(d.destination).toBeNull();
    expect(d.agreement).toBe("none");
    expect(d.reasons[0]).toContain("anything lasting was 0.2, below the 0.55 cutoff");
  });

  it("commits nothing when confidence is below the cutoff", () => {
    const d = decide(answers({ conf: 0.3 }));
    expect(d.destination).toBeNull();
    expect(d.agreement).toBe("none");
    expect(d.reasons[0]).toContain("confidence was 0.3, below the 0.5 cutoff");
  });

  it("commits nothing when the winning probability is below the cutoff", () => {
    const d = decide(answers({ p: 0.4 }));
    expect(d.destination).toBeNull();
    expect(d.agreement).toBe("none");
    expect(d.reasons[0]).toContain("picked fact at 0.4, below the 0.75 cutoff");
  });

  it("routes to steering when the choice is steering", () => {
    const d = decide(answers({ choice: "steering" }));
    expect(d.destination).toBe("steering");
    expect(d.agreement).toBe("high");
    expect(d.reasons[0]).toContain("picked steering");
  });

  it("carries the cutoffs measured on the 2026-09-22 paid run", () => {
    expect(DEFAULT_THRESHOLDS_V2).toEqual({
      lastingAt: 0.55,
      confidenceAt: 0.5,
      pickAt: 0.75,
      droveDecisionAt: 0.7,
      measuredIn: "1469-paid-v2/ledger-20260925T141623",
    });
  });

  it("flattens confidence into raw as destination.conf and never sets restates", () => {
    const d = decide(answers({ conf: 0.8 }));
    expect(d.raw[`${DEST_V2_ID}.conf`]).toBe(0.8);
    expect(d.restates).toBe(false);
    expect(d.destination).toBe("fact");
    expect(d.agreement).toBe("high");
    expect(d.reasons[0]).toContain("confidence 0.8");
  });

  it("reports no signal when the lasting answer is missing, without throwing", () => {
    const d = decide(answers({ lasting: null }));
    expect(d.destination).toBeNull();
    expect(d.agreement).toBe("none");
    expect(d.reasons[0]).toContain(`no signal: ${LASTING_ID}`);
  });

  it("sets droveDecision from its own cutoff independently of the commit", () => {
    const committedNo = decide(answers({ drove: 0.2 }));
    expect(committedNo.destination).toBe("fact");
    expect(committedNo.agreement).toBe("high");
    expect(committedNo.droveDecision).toBe(false);
    expect(committedNo.reasons[1]).toContain("drove decision 0.2 < 0.7");
    const blockedYes = decide(answers({ lasting: 0.1, drove: 0.9 }));
    expect(blockedYes.destination).toBeNull();
    expect(blockedYes.agreement).toBe("none");
    expect(blockedYes.droveDecision).toBe(true);
    expect(blockedYes.reasons[1]).toContain("drove decision 0.9 >= 0.7");
  });
});

describe("decideRouteV2 restates pair", () => {
  it("absent pair answer leaves restates false and agreement unchanged", () => {
    const d = decide(answers({}));
    expect(d.restates).toBe(false);
    expect(d.agreement).toBe("high");
  });

  it("pair 0.9 sets restates", () => {
    const d = decide({
      ...answers({}),
      [RESTATES_PAIR_ID]: { type: "noul", noul: 0.9 },
    });
    expect(d.restates).toBe(true);
    expect(d.agreement).toBe("high");
    expect(d.reasons).toContain(`restates pair 0.9 >= ${RESTATES_AT_V2}.`);
  });

  it("pair 0.2 leaves restates false", () => {
    const d = decide({
      ...answers({}),
      [RESTATES_PAIR_ID]: { type: "noul", noul: 0.2 },
    });
    expect(d.restates).toBe(false);
  });
});
