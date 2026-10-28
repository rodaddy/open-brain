/**
 * Input/output proofs for the pure DREAM route core. No database, no network.
 */

import { describe, expect, it } from "vitest";
import type { JevBatch, JevBatchPlan } from "../../integrations/jev.ts";
import type {
  CandidateSnapshot,
  FrozenRow,
  RouteDecision,
  RouteMatrix,
} from "./types.ts";
import {
  CHARS_PER_TOKEN,
  USD_PER_MILLION_INPUT_TOKENS,
  candidateOf,
  orderForBatches,
  projectCost,
  recordOf,
  resolveRestatementGroups,
  splitPlan,
  wouldApply,
  type RoutedRow,
  type WouldApply,
} from "./run-core.ts";

const MATRIX: RouteMatrix = {
  fingerprint: "abc123abc123",
  rows: [
    { name: "rule", line: "a standing rule", commits: true },
    { name: "decision", line: "a choice made", commits: true },
    { name: "fact", line: "a lasting fact", commits: true },
    { name: "correction", line: "a correction", commits: true },
    { name: "steering", line: "a go-ahead", commits: false },
  ],
};

function snapshot(over: Partial<CandidateSnapshot> = {}): CandidateSnapshot {
  return {
    id: "cand-1",
    namespace: "dana",
    candidate_type: "decision",
    content: "use Forge, not GitHub",
    content_hash: "f".repeat(64),
    operator_text: null,
    unit_kind: "exchange",
    anchor_kind: "typed",
    first_said_at: null,
    last_said_at: null,
    source_turn_ids: [],
    ...over,
  };
}

function row(
  candidateId: string,
  neighbourOf: string | null = null,
  over: Partial<CandidateSnapshot> = {},
): FrozenRow {
  return {
    ordinal: 0,
    candidateId,
    namespace: "dana",
    contentHash: "f".repeat(64),
    source: neighbourOf === null ? "draw" : "neighbour",
    neighbourOf,
    snapshot: snapshot({ id: candidateId, ...over }),
  };
}

function decision(over: Partial<RouteDecision> = {}): RouteDecision {
  return {
    candidateId: "cand-1",
    destination: "decision",
    agreement: "high",
    authorityTier: "decided",
    restates: false,
    droveDecision: false,
    reasons: [],
    raw: {},
    ...over,
  };
}

describe("candidateOf", () => {
  it("reads a well-formed snapshot", () => {
    const candidate = candidateOf(row("cand-1"));
    expect(candidate).toEqual({
      id: "cand-1",
      namespace: "dana",
      candidateType: "decision",
      content: "use Forge, not GitHub",
      operatorText: null,
      unitKind: "exchange",
      anchorKind: "typed",
    });
  });

  it("throws naming the candidate and the bad union value", () => {
    const bad = row("cand-9", null, { candidate_type: "musing" });
    expect(() => candidateOf(bad)).toThrow(/cand-9: candidate_type/);
  });

  it("throws on a missing content", () => {
    expect(() => candidateOf(row("cand-8", null, { content: "" }))).toThrow(
      /cand-8: content/,
    );
  });

  it("throws on an unknown anchor kind", () => {
    expect(() => candidateOf(row("cand-7", null, { anchor_kind: "guessed" }))).toThrow(
      /cand-7: anchor_kind/,
    );
  });

  it("accepts a null anchor kind", () => {
    expect(candidateOf(row("cand-6", null, { anchor_kind: null })).anchorKind).toBe(
      null,
    );
  });
});

describe("recordOf", () => {
  it("leads with the operator's words when there are any", () => {
    const candidate = candidateOf(row("c", null, { operator_text: "no GitHub" }));
    expect(recordOf(candidate)).toEqual({
      key: "c",
      content: "OPERATOR SAID: no GitHub\nITEM: use Forge, not GitHub",
    });
  });

  it("omits the operator line when the text is null or blank", () => {
    expect(recordOf(candidateOf(row("c"))).content).toBe("ITEM: use Forge, not GitHub");
    const blank = candidateOf(row("c", null, { operator_text: "   " }));
    expect(recordOf(blank).content).toBe("ITEM: use Forge, not GitHub");
  });

  it("carries the whole content through", () => {
    const long = "x".repeat(50_000);
    const candidate = candidateOf(row("c", null, { content: long }));
    expect(recordOf(candidate).content).toBe(`ITEM: ${long}`);
  });
});

describe("orderForBatches", () => {
  it("puts every neighbour directly after its parent, siblings in id order", () => {
    const rows = [row("a"), row("b"), row("a-z", "a"), row("c"), row("a-m", "a")];
    expect(orderForBatches(rows).map((r) => r.candidateId)).toEqual([
      "a",
      "a-m",
      "a-z",
      "b",
      "c",
    ]);
  });

  it("keeps orphaned neighbours in their ordinal place", () => {
    const rows = [row("a"), row("orphan", "missing"), row("b")];
    expect(orderForBatches(rows).map((r) => r.candidateId)).toEqual([
      "a",
      "orphan",
      "b",
    ]);
  });

  it("loses nothing and repeats nothing, even on a cycle", () => {
    const rows = [row("a", "b"), row("b", "a"), row("c")];
    const ids = orderForBatches(rows).map((r) => r.candidateId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids)).toEqual(new Set(["a", "b", "c"]));
  });

  it("is deterministic", () => {
    const rows = [row("a"), row("a-2", "a"), row("a-1", "a"), row("b")];
    expect(orderForBatches(rows)).toEqual(orderForBatches(rows));
  });
});

function batchOf(bytes: number): JevBatch {
  return {
    records: [],
    state: {},
    questions: {},
    mappings: [],
    estimatedRequestBytes: bytes,
    estimatedStateQuestionBytes: bytes,
  };
}

function sizeOf(batch: JevBatch): number {
  return batch.estimatedRequestBytes;
}

function planOf(...bytes: number[]): JevBatchPlan {
  return {
    classifierSet: { name: "n", version: "v", classifiers: {} },
    batches: bytes.map(batchOf),
  };
}

describe("projectCost", () => {
  it("sums bytes and prices them off the two constants", () => {
    const cost = projectCost(planOf(1_000, 2_600));
    expect(cost.requests).toBe(2);
    expect(cost.bytes).toBe(3_600);
    expect(cost.estimatedTokens).toBe(Math.ceil(3_600 / CHARS_PER_TOKEN));
    expect(cost.estimatedTokens).toBe(1_000);
    expect(cost.estimatedUsd).toBeCloseTo(
      (1_000 / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS,
      12,
    );
  });

  it("is zero for an empty plan", () => {
    expect(projectCost(planOf())).toEqual({
      requests: 0,
      bytes: 0,
      estimatedTokens: 0,
      estimatedUsd: 0,
    });
  });
});

describe("splitPlan", () => {
  it("round-robins the batches across lanes, each exactly once", () => {
    const plan = planOf(1, 2, 3, 4, 5);
    const parts = splitPlan(plan, 3);
    expect(parts).toHaveLength(3);
    expect(parts.map((part) => part.batches.length)).toEqual([2, 2, 1]);
    const seen = parts.flatMap((part) => part.batches).map(sizeOf);
    expect(seen.sort((l, r) => l - r)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never returns an empty sub-plan", () => {
    const parts = splitPlan(planOf(1, 2), 8);
    expect(parts).toHaveLength(2);
    for (const part of parts) expect(part.batches.length).toBeGreaterThan(0);
  });

  it("carries the same classifier set into every sub-plan", () => {
    const plan = planOf(1, 2, 3);
    for (const part of splitPlan(plan, 2)) {
      expect(part.classifierSet).toBe(plan.classifierSet);
    }
  });

  it("throws below one in flight", () => {
    expect(() => splitPlan(planOf(1), 0)).toThrow(/at least 1/);
    expect(() => splitPlan(planOf(1), -3)).toThrow(/at least 1/);
  });
});

describe("wouldApply", () => {
  const anyRow = row("cand-1");

  it("commits nothing below high agreement", () => {
    for (const agreement of ["low", "none"] as const) {
      const result = wouldApply(decision({ agreement }), anyRow, MATRIX);
      expect(result.action).toBe("none");
      expect(result.reason).toBe(`agreement ${agreement}, only high commits.`);
    }
  });

  it("commits nothing for a destination that does not commit", () => {
    const result = wouldApply(decision({ destination: "steering" }), anyRow, MATRIX);
    expect(result).toEqual({
      action: "none",
      reason: "steering is never committed.",
    });
  });

  it("reinforces a restatement instead of writing it twice", () => {
    const result = wouldApply(decision({ restates: true }), anyRow, MATRIX);
    expect(result).toEqual({
      action: "reinforce",
      reason: "restates another item in its batch.",
    });
  });

  it("makes a rule in the operator's words always-known", () => {
    const result = wouldApply(
      decision({ destination: "rule", authorityTier: "decided" }),
      anyRow,
      MATRIX,
    );
    expect(result.action).toBe("rule_event");
  });

  it("keeps an observed rule searchable only", () => {
    const result = wouldApply(
      decision({ destination: "rule", authorityTier: "observed" }),
      anyRow,
      MATRIX,
    );
    expect(result).toEqual({
      action: "thought",
      reason: "a rule not in the operator's words is searchable, never always-known.",
    });
  });

  it("writes every other committed destination as a thought", () => {
    for (const destination of ["decision", "fact", "correction"] as const) {
      const result = wouldApply(decision({ destination }), anyRow, MATRIX);
      expect(result.action).toBe("thought");
      expect(result.reason).toContain(destination);
    }
  });

  it("gives a plain sentence on every branch", () => {
    const cases: RouteDecision[] = [
      decision({ agreement: "none" }),
      decision({ destination: "steering" }),
      decision({ restates: true }),
      decision({ destination: "rule" }),
      decision({ destination: "rule", authorityTier: "observed" }),
      decision(),
    ];
    for (const one of cases) {
      const { reason } = wouldApply(one, anyRow, MATRIX);
      expect(reason).toMatch(/^[a-z].*\.$/);
    }
  });
});

/**
 * Builds one member of a restatement group.
 *
 * @param id - The candidate id.
 * @param firstSaidAt - Its `first_said_at`, or null when it has none.
 * @param action - The verdict the first pass gave it.
 * @param neighbourOf - The row it was pulled in by, or null when it was drawn.
 * @returns The routed row the group resolver reads.
 */
function routed(
  id: string,
  firstSaidAt: string | null,
  action: WouldApply["action"],
  neighbourOf: string | null = null,
): RoutedRow {
  return {
    row: row(id, neighbourOf, { first_said_at: firstSaidAt }),
    decision: decision({ candidateId: id, restates: action === "reinforce" }),
    wouldApply: { action, reason: `${action} because the fixture says so.` },
  };
}

/** What the survivor falls back to once its restates flag is forced off. */
const recompute = (): WouldApply => ({
  action: "thought",
  reason: "a committed decision is written as a searchable thought.",
});

describe("resolveRestatementGroups", () => {
  it("keeps the earliest-said member and points the rest at it", () => {
    const resolved = resolveRestatementGroups(
      [
        routed("a", "2026-03-02T00:00:00Z", "reinforce"),
        routed("b", "2026-03-01T00:00:00Z", "reinforce", "a"),
        routed("c", "2026-03-03T00:00:00Z", "reinforce", "a"),
      ],
      recompute,
    );
    expect(resolved.get("b")).toEqual({
      action: "thought",
      reason:
        "a committed decision is written as a searchable thought." +
        " It is the earliest-said member of its group, so it is the one kept.",
      reinforces: null,
    });
    expect(resolved.get("a")?.reinforces).toBe("b");
    expect(resolved.get("a")?.action).toBe("reinforce");
    expect(resolved.get("c")?.reinforces).toBe("b");
  });

  it("breaks a tie on first_said_at by the lowest candidate id", () => {
    const same = "2026-03-01T00:00:00Z";
    const resolved = resolveRestatementGroups(
      [
        routed("m", same, "reinforce"),
        routed("k", same, "reinforce", "m"),
        routed("z", same, "reinforce", "m"),
      ],
      recompute,
    );
    expect(resolved.get("k")?.reinforces).toBe(null);
    expect(resolved.get("m")?.reinforces).toBe("k");
    expect(resolved.get("z")?.reinforces).toBe("k");
  });

  it("never makes a `none` member the survivor", () => {
    const resolved = resolveRestatementGroups(
      [
        // The earliest row commits nothing, so there is nothing to reinforce.
        routed("a", "2026-01-01T00:00:00Z", "none"),
        routed("b", "2026-03-01T00:00:00Z", "reinforce", "a"),
        routed("c", "2026-03-02T00:00:00Z", "reinforce", "a"),
      ],
      recompute,
    );
    expect(resolved.get("a")).toEqual({
      action: "none",
      reason: "none because the fixture says so.",
      reinforces: null,
    });
    expect(resolved.get("b")?.reinforces).toBe(null);
    expect(resolved.get("c")?.reinforces).toBe("b");
  });

  it("lets a `thought` member be the survivor a reinforce points at", () => {
    const resolved = resolveRestatementGroups(
      [
        routed("a", "2026-01-01T00:00:00Z", "thought"),
        routed("b", "2026-03-01T00:00:00Z", "reinforce", "a"),
      ],
      recompute,
    );
    expect(resolved.get("a")?.action).toBe("thought");
    expect(resolved.get("b")?.reinforces).toBe("a");
  });
});

describe("resolveRestatementGroups, with nothing to reinforce", () => {
  it("falls a lone reinforce back to its real action: nothing else says it", () => {
    const resolved = resolveRestatementGroups(
      [routed("solo", "2026-03-01T00:00:00Z", "reinforce")],
      recompute,
    );
    expect(resolved.get("solo")).toEqual({
      action: "thought",
      reason:
        "a committed decision is written as a searchable thought." +
        " Nothing else in the cohort says it, so it is kept.",
      reinforces: null,
    });
  });

  it("treats a neighbour_of naming an absent row as its own group", () => {
    const resolved = resolveRestatementGroups(
      [routed("orphan", "2026-03-01T00:00:00Z", "reinforce", "not-in-cohort")],
      recompute,
    );
    expect(resolved.get("orphan")?.reinforces).toBe(null);
    expect(resolved.get("orphan")?.reason).toContain("Nothing else in the cohort");
  });

  it("sorts a null first_said_at last, never first", () => {
    const resolved = resolveRestatementGroups(
      [
        routed("a", null, "reinforce"),
        routed("b", "2026-03-01T00:00:00Z", "reinforce", "a"),
      ],
      recompute,
    );
    expect(resolved.get("b")?.reinforces).toBe(null);
    expect(resolved.get("a")?.reinforces).toBe("b");
  });

  it("returns exactly one verdict per row", () => {
    const resolved = resolveRestatementGroups(
      [
        routed("a", "2026-03-01T00:00:00Z", "reinforce"),
        routed("b", "2026-03-02T00:00:00Z", "rule_event", "a"),
        routed("c", "2026-03-03T00:00:00Z", "none"),
      ],
      recompute,
    );
    expect([...resolved.keys()].sort()).toEqual(["a", "b", "c"]);
  });
});
