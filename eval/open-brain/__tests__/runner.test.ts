import { describe, expect, it } from "bun:test";
import fixture from "../fixtures/memory-smoke.json" assert { type: "json" };
import { retrieve, runEvalSuite, scoreProbe } from "../runner.ts";
import type { EvalFixture } from "../types.ts";

const typedFixture = fixture as EvalFixture;

describe("Open Brain memory eval runner", () => {
  it("keeps gold answers sealed outside retrieved public results", () => {
    const probe = typedFixture.probes.find((item) => item.id === "recall-temp-root");
    expect(probe).toBeDefined();
    const results = retrieve(typedFixture.corpus, probe!);
    expect(results[0]?.entry.id).toBe("thought-temp-root");
    expect(results[0]).not.toHaveProperty("relevant_ids");
  });

  it("blocks unreadable namespace evidence", () => {
    const probe = typedFixture.probes.find((item) => item.id === "namespace-private-leak");
    expect(probe).toBeDefined();
    const score = scoreProbe(typedFixture.corpus, probe!);
    expect(score.passed).toBe(true);
    expect(score.retrieved_ids).not.toContain("private-secret-project");
  });

  it("surfaces stale and contradictory memory as uncertainty", () => {
    const temporal = scoreProbe(
      typedFixture.corpus,
      typedFixture.probes.find((item) => item.id === "temporal-runner-policy")!,
    );
    const contradiction = scoreProbe(
      typedFixture.corpus,
      typedFixture.probes.find((item) => item.id === "contradiction-codex-home")!,
    );
    expect(temporal.uncertainty).toContain("stale");
    expect(contradiction.uncertainty).toContain("contradiction");
  });

  it("produces a passing aggregate scorecard for the smoke fixture", () => {
    const scorecard = runEvalSuite(typedFixture, {
      commit: "test",
      generatedAt: "2026-06-15T00:00:00.000Z",
    });
    expect(scorecard.probes_total).toBe(8);
    expect(scorecard.probes_failed).toBe(0);
    expect(scorecard.metrics.namespace_leak_count).toBe(0);
    expect(scorecard.metrics.recall_at_k).toBeGreaterThanOrEqual(1);
  });
});
