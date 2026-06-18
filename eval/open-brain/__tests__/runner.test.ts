import { describe, expect, it } from "bun:test";
import codexFixture from "../fixtures/codex-workflows.json" assert { type: "json" };
import fixture from "../fixtures/memory-smoke.json" assert { type: "json" };
import { answerForProbe, retrieve, runEvalSuite, scoreProbe } from "../runner.ts";
import type { EvalFixture } from "../types.ts";

const typedFixture = fixture as EvalFixture;
const typedCodexFixture = codexFixture as EvalFixture;

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
      readable_namespaces: ["skippy", "shared-kb"],
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

  it("covers Codex durable memory workflow scenarios", () => {
    const scorecard = runEvalSuite(typedCodexFixture, {
      commit: "test",
      generatedAt: "2026-06-15T00:00:00.000Z",
    });
    expect(scorecard.corpus_id).toBe("open-brain-codex-workflows-v1");
    expect(scorecard.probes_total).toBe(8);
    expect(scorecard.probes_failed).toBe(0);
    expect(scorecard.categories.codex.probes_total).toBe(6);
    expect(scorecard.categories.citation.probes_passed).toBe(1);
    expect(scorecard.categories.namespace.probes_passed).toBe(1);
  });

  it("prefers durable Codex preferences over one-off task instructions", () => {
    const probe = typedCodexFixture.probes.find(
      (item) => item.id === "codex-durable-preference-not-oneoff",
    );
    expect(probe).toBeDefined();
    const score = scoreProbe(typedCodexFixture.corpus, probe!);
    expect(score.passed).toBe(true);
    expect(score.retrieved_ids).toContain("preference-thunderbolt-temp");
    expect(score.retrieved_ids).not.toContain("oneoff-use-system-tmp");
  });

  it("keeps current repo evidence ahead of stale memory", () => {
    const probe = typedCodexFixture.probes.find(
      (item) => item.id === "codex-current-repo-over-stale-memory",
    );
    expect(probe).toBeDefined();
    const score = scoreProbe(typedCodexFixture.corpus, probe!);
    expect(score.passed).toBe(true);
    expect(score.retrieved_ids).toContain("repo-current-bun-runtime");
    expect(score.retrieved_ids).toContain("repo-stale-node-runtime");
    expect(score.uncertainty).toEqual(["stale"]);
    const answer = answerForProbe(
      retrieve(typedCodexFixture.corpus, probe!).map(({ entry }) => entry),
      probe!,
    );
    expect(answer).toContain("Current repo file AGENTS.md");
    expect(answer).toContain("contradicts memory ids repo-stale-node-runtime");
  });

  it("checks final-answer citation shape for memory-derived facts", () => {
    const probe = typedCodexFixture.probes.find(
      (item) => item.id === "codex-cite-memory-derived-facts",
    );
    expect(probe).toBeDefined();
    const entries = retrieve(typedCodexFixture.corpus, probe!).map(({ entry }) => entry);
    const answer = answerForProbe(entries, probe!);
    expect(scoreProbe(typedCodexFixture.corpus, probe!).passed).toBe(true);
    expect(answer).toContain("[decision-citation-contract]");
    expect(answer).toContain("Memory-derived final answers must include citations");
  });

  it("refuses unreadable Codex workflow facts", () => {
    const probe = typedCodexFixture.probes.find(
      (item) => item.id === "codex-unreadable-namespace-refusal",
    );
    expect(probe).toBeDefined();
    const score = scoreProbe(typedCodexFixture.corpus, probe!);
    expect(score.passed).toBe(true);
    expect(score.retrieved_ids).toEqual([]);
    expect(score.failures).toEqual([]);
  });

  it("proves the unreadable namespace probe has a positive control", () => {
    const probe = typedCodexFixture.probes.find(
      (item) => item.id === "codex-unreadable-namespace-refusal",
    );
    expect(probe).toBeDefined();
    const score = scoreProbe(typedCodexFixture.corpus, {
      ...probe!,
      readable_namespaces: ["skippy", "private-agent"],
      relevant_ids: ["private-user-secret"],
      expect_no_results: false,
    });
    expect(score.retrieved_ids).toContain("private-user-secret");
  });

  it("runs the CLI against an alternate fixture", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "scripts/eval-open-brain-memory.ts",
        "--fixture",
        "eval/open-brain/fixtures/codex-workflows.json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("corpus=open-brain-codex-workflows-v1");
    expect(stdout).toContain("- codex: 6/6 pass");
    expect(stdout).not.toContain("0/0 pass");
  });

  it("returns a controlled CLI error for a missing fixture", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "scripts/eval-open-brain-memory.ts",
        "--fixture",
        "eval/open-brain/fixtures/does-not-exist.json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain(
      "Failed to load Open Brain eval fixture eval/open-brain/fixtures/does-not-exist.json",
    );
  });
});
