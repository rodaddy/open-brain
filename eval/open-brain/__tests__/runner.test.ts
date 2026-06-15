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
    expect(score.retrieved_ids).toEqual([]);
  });

  it("fails namespace probes when readable junk is retrieved", () => {
    const probe = typedFixture.probes.find((item) => item.id === "namespace-private-leak");
    expect(probe).toBeDefined();
    const score = scoreProbe(typedFixture.corpus, {
      ...probe!,
      readable_namespaces: ["skippy", "collab"],
    });
    expect(score.passed).toBe(false);
    expect(score.failures).toContain("expected no retrievable evidence");
  });

  it("fails probes that retrieve declared junk ids", () => {
    const probe = typedFixture.probes.find((item) => item.id === "identity-rico-rika");
    expect(probe).toBeDefined();
    const score = scoreProbe(typedFixture.corpus, { ...probe!, top_k: 3 });
    expect(score.passed).toBe(false);
    expect(score.failures).toContain("retrieved declared junk person-rika");
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

  it("does not flag a single negative use statement as a contradiction", () => {
    const score = scoreProbe(
      [
        {
          id: "negative-only",
          namespace: "skippy",
          type: "decision",
          title: "Negative only",
          content: "Do not use ~/.codex-clean for active work.",
          tags: [],
          created_at: "2026-06-15T00:00:00.000Z",
          source_ref: {
            source: "brain",
            type: "decision",
            id: "negative-only",
            namespace: "skippy",
            label: "Negative only",
            preview: "Do not use ~/.codex-clean for active work.",
            created_at: "2026-06-15T00:00:00.000Z",
          },
        },
      ],
      {
        id: "negative-only-probe",
        category: "contradiction",
        query: "codex clean active work",
        readable_namespaces: ["skippy"],
        top_k: 5,
        relevant_ids: ["negative-only"],
      },
    );
    expect(score.uncertainty).not.toContain("contradiction");
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
