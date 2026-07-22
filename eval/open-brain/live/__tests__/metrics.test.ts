import { describe, expect, it } from "bun:test";
import {
  buildScorecard,
  namespaceLeaks,
  parseThresholds,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  scoreProbeMetric,
} from "../metrics.ts";
import { parseLiveFixture } from "../fixtures.ts";
import type { LiveFixture, LiveThresholds } from "../types.ts";

const FIXTURE: LiveFixture = parseLiveFixture({
  schema_version: 1,
  fixture_id: "known-rankings-v1",
  description: "deterministic ranking test fixture",
  corpus: [
    {
      id: "a",
      table: "thoughts",
      namespace_role: "primary",
      content: "a",
      tags: [],
    },
    {
      id: "b",
      table: "thoughts",
      namespace_role: "primary",
      content: "b",
      tags: [],
    },
    {
      id: "c",
      table: "thoughts",
      namespace_role: "primary",
      content: "c",
      tags: [],
    },
    {
      id: "d",
      table: "thoughts",
      namespace_role: "primary",
      content: "d distractor",
      tags: [],
    },
    {
      id: "neg",
      table: "thoughts",
      namespace_role: "negative",
      content: "neg",
      tags: [],
    },
  ],
  probes: [
    {
      id: "p1",
      query: "find a and b",
      relevant: [
        { id: "a", grade: 2 },
        { id: "b", grade: 1 },
      ],
      forbidden_ids: ["neg"],
    },
    {
      id: "p2",
      query: "find c",
      relevant: [{ id: "c", grade: 2 }],
      forbidden_ids: ["neg"],
    },
  ],
});

const THRESHOLDS: LiveThresholds = parseThresholds({
  schema_version: 1,
  thresholds_id: "known-thresholds-v1",
  applies_to_fixture_id: "known-rankings-v1",
  top_k: 3,
  thresholds: {
    min_recall_at_k: 0.9,
    min_precision_at_k: 0.3,
    min_mrr: 0.8,
    max_namespace_leaks: 0,
  },
});

describe("deterministic ranking metrics", () => {
  it("computes recall@k over a known ranked list", () => {
    // relevant {a,b}; retrieved top-3 has a,d,b -> both relevant found
    expect(recallAtK(["a", "d", "b"], ["a", "b"])).toBe(1);
    // only a found -> 0.5
    expect(recallAtK(["a", "d"], ["a", "b"])).toBe(0.5);
    // none found -> 0
    expect(recallAtK(["d", "e"], ["a", "b"])).toBe(0);
    // no relevant items -> perfect recall by convention
    expect(recallAtK([], [])).toBe(1);
  });

  it("computes precision@k with k as the denominator", () => {
    // 2 relevant of top-3 slots -> 2/3
    expect(precisionAtK(["a", "b", "d"], ["a", "b"], 3)).toBeCloseTo(2 / 3, 6);
    // 1 relevant of top-3 -> 1/3
    expect(precisionAtK(["a", "d", "e"], ["a", "b"], 3)).toBeCloseTo(1 / 3, 6);
    // truncates to k even if more retrieved
    expect(precisionAtK(["a", "b", "c", "d", "e"], ["a", "b", "c"], 2)).toBe(1);
  });

  it("computes reciprocal rank of the first relevant hit", () => {
    expect(reciprocalRank(["a", "b"], ["a"])).toBe(1); // rank 1
    expect(reciprocalRank(["d", "a"], ["a"])).toBe(0.5); // rank 2
    expect(reciprocalRank(["d", "e"], ["a"])).toBe(0); // absent
  });

  it("counts namespace leaks over the full retrieved list", () => {
    expect(namespaceLeaks(["a", "neg", "b"], ["neg"])).toBe(1);
    expect(namespaceLeaks(["a", "b"], ["neg"])).toBe(0);
    expect(namespaceLeaks(["a", "b"], [])).toBe(0);
  });

  it("scores a probe deterministically for a known ranking", () => {
    const probe = FIXTURE.probes[0]!;
    const metric = scoreProbeMetric(probe, ["a", "d", "b"], 3);
    expect(metric).toEqual({
      probe_id: "p1",
      recall_at_k: 1,
      precision_at_k: 2 / 3,
      reciprocal_rank: 1,
      namespace_leaks: 0,
      retrieved_count: 3,
      relevant_count: 2,
    });
  });

  it("builds a passing scorecard for a perfect known retrieval", () => {
    const scorecard = buildScorecard(FIXTURE, THRESHOLDS, {
      p1: ["a", "b", "d"],
      p2: ["c", "d"],
    });
    expect(scorecard.passed).toBe(true);
    expect(scorecard.failures).toEqual([]);
    expect(scorecard.recall_at_k).toBe(1);
    expect(scorecard.mrr).toBe(1);
    expect(scorecard.namespace_leaks).toBe(0);
  });

  it("fails the scorecard when recall/mrr fall below threshold (degraded retrieval)", () => {
    // p1 returns only the distractor (no relevant), p2 returns nothing.
    const scorecard = buildScorecard(FIXTURE, THRESHOLDS, {
      p1: ["d"],
      p2: [],
    });
    expect(scorecard.passed).toBe(false);
    expect(scorecard.recall_at_k).toBeLessThan(0.9);
    expect(scorecard.mrr).toBeLessThan(0.8);
    expect(scorecard.failures.some((f) => f.startsWith("recall_at_k"))).toBe(
      true,
    );
    expect(scorecard.failures.some((f) => f.startsWith("mrr"))).toBe(true);
  });

  it("fails the scorecard when a forbidden namespace record leaks", () => {
    const scorecard = buildScorecard(FIXTURE, THRESHOLDS, {
      p1: ["a", "b", "neg"],
      p2: ["c"],
    });
    expect(scorecard.namespace_leaks).toBe(1);
    expect(scorecard.passed).toBe(false);
    expect(
      scorecard.failures.some((f) => f.startsWith("namespace_leaks")),
    ).toBe(true);
  });

  it("scores a missing probe as an empty (worst-case) retrieval", () => {
    const scorecard = buildScorecard(FIXTURE, THRESHOLDS, { p1: ["a", "b"] });
    const p2 = scorecard.probes.find((p) => p.probe_id === "p2");
    expect(p2?.recall_at_k).toBe(0);
    expect(p2?.reciprocal_rank).toBe(0);
  });

  it("rejects thresholds with out-of-range values", () => {
    expect(() =>
      parseThresholds({
        schema_version: 1,
        thresholds_id: "bad",
        applies_to_fixture_id: "x",
        top_k: 5,
        thresholds: {
          min_recall_at_k: 1.5,
          min_precision_at_k: 0.3,
          min_mrr: 0.8,
          max_namespace_leaks: 0,
        },
      }),
    ).toThrow();
    expect(() =>
      parseThresholds({
        schema_version: 1,
        thresholds_id: "bad",
        applies_to_fixture_id: "x",
        top_k: 0,
        thresholds: {
          min_recall_at_k: 0.9,
          min_precision_at_k: 0.3,
          min_mrr: 0.8,
          max_namespace_leaks: 0,
        },
      }),
    ).toThrow();
  });
});
