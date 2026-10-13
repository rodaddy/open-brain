import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expectDefined } from "../../../scripts/test-support/expect-defined.ts";
import codexFixture from "../fixtures/codex-workflows.json" assert { type: "json" };
import fixture from "../fixtures/memory-smoke.json" assert { type: "json" };
import substrateFixture from "../fixtures/memory-substrate.json" assert { type: "json" };
import { answerForProbe, retrieve, runEvalSuite, scoreProbe } from "../runner.ts";
import type { EvalFixture, EvalProbe } from "../types.ts";

const typedFixture = fixture as EvalFixture;
const typedCodexFixture = codexFixture as EvalFixture;
const typedSubstrateFixture = substrateFixture as EvalFixture;

function probeFrom(source: EvalFixture, id: string): EvalProbe {
  return expectDefined(
    source.probes.find((item) => item.id === id),
    `probe ${id}`,
  );
}

async function runFixtureCli(fixturePath: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(
    process.execPath,
    ["scripts/eval-open-brain-memory.ts", "--fixture", fixturePath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const out: string[] = [];
  const err: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => out.push(chunk));
  child.stderr.on("data", (chunk: string) => err.push(chunk));
  const [code] = (await once(child, "close")) as [number | null];
  return { exitCode: code ?? 0, stdout: out.join(""), stderr: err.join("") };
}

describe("Open Brain memory eval runner: retrieval and namespace guards", () => {
  it("keeps gold answers sealed outside retrieved public results", () => {
    const probe = probeFrom(typedFixture, "recall-temp-root");
    const results = retrieve(typedFixture.corpus, probe);
    expect(results[0]?.entry.id).toBe("thought-temp-root");
    expect(results[0]).not.toHaveProperty("relevant_ids");
  });

  it("blocks unreadable namespace evidence", () => {
    const probe = probeFrom(typedFixture, "namespace-private-leak");
    const score = scoreProbe(typedFixture.corpus, probe);
    expect(score.passed).toBe(true);
    expect(score.retrieved_ids).not.toContain("private-secret-project");
    expect(score.retrieved_ids).toEqual([]);
  });

  it("fails namespace probes when readable junk is retrieved", () => {
    const probe = probeFrom(typedFixture, "namespace-private-leak");
    const score = scoreProbe(typedFixture.corpus, {
      ...probe,
      readable_namespaces: ["skippy", "shared-kb"],
    });
    expect(score.passed).toBe(false);
    expect(score.failures).toContain("expected no retrievable evidence");
  });

  it("fails probes that retrieve declared junk ids", () => {
    const probe = probeFrom(typedFixture, "identity-rico-rika");
    const score = scoreProbe(typedFixture.corpus, { ...probe, top_k: 3 });
    expect(score.passed).toBe(false);
    expect(score.failures).toContain("retrieved declared junk person-rika");
  });

  it("surfaces stale and contradictory memory as uncertainty", () => {
    const temporal = scoreProbe(
      typedFixture.corpus,
      probeFrom(typedFixture, "temporal-runner-policy"),
    );
    const contradiction = scoreProbe(
      typedFixture.corpus,
      probeFrom(typedFixture, "contradiction-codex-home"),
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
});

describe("Open Brain memory eval runner: aggregate scorecards", () => {
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

  it("covers memory substrate compaction, privacy, receipts, and linked recall", () => {
    const scorecard = runEvalSuite(typedSubstrateFixture, {
      commit: "test",
      generatedAt: "2026-06-26T00:00:00.000Z",
    });
    expect(scorecard.corpus_id).toBe("open-brain-memory-substrate-v1");
    expect(scorecard.probes_total).toBe(4);
    expect(scorecard.probes_failed).toBe(0);
    expect(scorecard.categories.codex.probes_passed).toBe(1);
    expect(scorecard.categories.namespace.probes_passed).toBe(1);
    expect(scorecard.categories.citation.probes_passed).toBe(1);
    expect(scorecard.categories.recall.probes_passed).toBe(1);
  });

  it("fails the memory substrate receipt probe when receipt evidence is incomplete", () => {
    const probe = probeFrom(typedSubstrateFixture, "substrate-complete-receipt");
    const brokenCorpus = typedSubstrateFixture.corpus.map((entry) =>
      entry.id === "receipt-complete-report"
        ? {
            ...entry,
            content: entry.content.replace(
              "base template reports/base-template.pdf, ",
              "",
            ),
            source_ref: {
              ...entry.source_ref,
              preview: entry.source_ref.preview.replace(
                "base template reports/base-template.pdf, ",
                "",
              ),
            },
          }
        : entry,
    );
    const score = scoreProbe(brokenCorpus, probe);
    expect(score.passed).toBe(false);
    expect(score.failures).toContain("missing expected answer term base-template.pdf");
  });
});

describe("Open Brain memory eval runner: Codex workflow probes", () => {
  it("prefers durable Codex preferences over one-off task instructions", () => {
    const probe = probeFrom(typedCodexFixture, "codex-durable-preference-not-oneoff");
    const score = scoreProbe(typedCodexFixture.corpus, probe);
    expect(score.passed).toBe(true);
    expect(score.retrieved_ids).toContain("preference-thunderbolt-temp");
    expect(score.retrieved_ids).not.toContain("oneoff-use-system-tmp");
  });

  it("keeps current repo evidence ahead of stale memory", () => {
    const probe = probeFrom(typedCodexFixture, "codex-current-repo-over-stale-memory");
    const score = scoreProbe(typedCodexFixture.corpus, probe);
    expect(score.passed).toBe(true);
    expect(score.retrieved_ids).toContain("repo-current-bun-runtime");
    expect(score.retrieved_ids).toContain("repo-stale-node-runtime");
    expect(score.uncertainty).toEqual(["stale"]);
    const answer = answerForProbe(
      retrieve(typedCodexFixture.corpus, probe).map(({ entry }) => entry),
      probe,
    );
    expect(answer).toContain("Current repo file AGENTS.md");
    expect(answer).toContain("contradicts memory ids repo-stale-node-runtime");
  });

  it("checks final-answer citation shape for memory-derived facts", () => {
    const probe = probeFrom(typedCodexFixture, "codex-cite-memory-derived-facts");
    const entries = retrieve(typedCodexFixture.corpus, probe).map(({ entry }) => entry);
    const answer = answerForProbe(entries, probe);
    expect(scoreProbe(typedCodexFixture.corpus, probe).passed).toBe(true);
    expect(answer).toContain("[decision-citation-contract]");
    expect(answer).toContain("Memory-derived final answers must include citations");
  });

  it("refuses unreadable Codex workflow facts", () => {
    const probe = probeFrom(typedCodexFixture, "codex-unreadable-namespace-refusal");
    const score = scoreProbe(typedCodexFixture.corpus, probe);
    expect(score.passed).toBe(true);
    expect(score.retrieved_ids).toEqual([]);
    expect(score.failures).toEqual([]);
  });

  it("proves the unreadable namespace probe has a positive control", () => {
    const probe = probeFrom(typedCodexFixture, "codex-unreadable-namespace-refusal");
    const score = scoreProbe(typedCodexFixture.corpus, {
      ...probe,
      readable_namespaces: ["skippy", "private-agent"],
      relevant_ids: ["private-user-secret"],
      expect_no_results: false,
    });
    expect(score.retrieved_ids).toContain("private-user-secret");
  });
});

describe("Open Brain memory eval runner: command line entry point", () => {
  it("runs the CLI against an alternate fixture", async () => {
    const { exitCode, stdout, stderr } = await runFixtureCli(
      "eval/open-brain/fixtures/codex-workflows.json",
    );
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("corpus=open-brain-codex-workflows-v1");
    expect(stdout).toContain("- codex: 6/6 pass");
    expect(stdout).not.toContain("0/0 pass");
  });

  it("runs the CLI against the memory substrate fixture", async () => {
    const { exitCode, stdout, stderr } = await runFixtureCli(
      "eval/open-brain/fixtures/memory-substrate.json",
    );
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("corpus=open-brain-memory-substrate-v1");
    expect(stdout).toContain("- codex: 1/1 pass");
    expect(stdout).toContain("- namespace: 1/1 pass");
  });

  it("returns a controlled CLI error for a missing fixture", async () => {
    const { exitCode, stdout, stderr } = await runFixtureCli(
      "eval/open-brain/fixtures/does-not-exist.json",
    );
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain(
      "Failed to load Open Brain eval fixture eval/open-brain/fixtures/does-not-exist.json",
    );
  });
});
