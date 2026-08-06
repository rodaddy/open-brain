import { describe, expect, test } from "bun:test";
import {
  diffTraces,
  digestOutput,
  renderRepeatReport,
  renderSessionTraces,
  renderTimeline,
  renderTraceDiff,
  repeatExitCode,
  traceDiffExitCode,
  type LangfuseTrace,
  type TraceComparison,
} from "./langfuse-trace-lib.ts";
import {
  parseRepeatChildOutput,
  repeatChildFailureMessage,
  selectRepeatedTraceSummaries,
} from "./langfuse-trace.ts";

async function fixture(name: string): Promise<LangfuseTrace> {
  return Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json();
}

function comparison(equivalent: boolean | null): TraceComparison {
  return {
    equivalent,
    toolA: "search_brain",
    toolB: "search_brain",
    releaseA: "a",
    releaseB: "b",
    namespaceA: "rico",
    namespaceB: "rico",
    stages: [],
  };
}

async function runCliDiff(
  traceA: unknown,
  traceB: unknown,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const id = new URL(request.url).pathname.split("/").at(-1);
      return Response.json(id === "trace-a" ? traceA : traceB);
    },
  });
  try {
    const child = Bun.spawn(
      ["bun", "scripts/langfuse-trace.ts", "diff", "trace-a", "trace-b"],
      {
        cwd: new URL("../", import.meta.url).pathname,
        env: {
          ...process.env,
          OPENBRAIN_TRACING_ENDPOINT: server.url.origin,
          OPENBRAIN_TRACING_PUBLIC_KEY: "fixture-public",
          OPENBRAIN_TRACING_SECRET_KEY: "fixture-secret",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    server.stop(true);
  }
}

describe("Langfuse trace forensics", () => {
  test("digests nested count and row-id evidence without returning content", () => {
    const digest = digestOutput({
      count: 2,
      row_ids: ["row-1", "row-2"],
      nested: { selected_count: 1, selected_row_ids: ["row-1"] },
      candidates: [{ row_id: "row-1" }, { row_id: "row-2" }],
      content: "must not appear",
    });

    expect(digest).toBe(
      "count=2 row_ids=[row-1,row-2] nested.selected_count=1 nested.selected_row_ids=[row-1] candidate_row_ids=[row-1,row-2]",
    );
    expect(digest).not.toContain("must not appear");
  });

  test("renders trace identity and observations in start-time order", async () => {
    const output = renderTimeline(await fixture("langfuse-trace-a.json"));
    const vectorIndex = output.indexOf("retrieval.vector_query");
    const rankIndex = output.indexOf("retrieval.rank_rrf");

    expect(output).toContain("name=search_brain");
    expect(output).toContain("release=abc1234");
    expect(output).toContain("sessionId=session-569");
    expect(output).toContain("caller=user=rico client=rico token_client=rico agent=trace-fixture role=agent");
    expect(output).toContain("status=success");
    expect(vectorIndex).toBeGreaterThan(0);
    expect(rankIndex).toBeGreaterThan(vectorIndex);
    expect(output).toContain("stage=candidate_generation duration_ms=50");
    expect(output).toContain("row_ids=[row-1,row-2]");
  });

  test("orders tied timestamps by end time then observation id and renders missing starts last", async () => {
    const lines = renderTimeline(await fixture("langfuse-trace-timeline-degenerate.json")).split("\n").slice(5);

    expect(lines[0]).toContain("tied-same-end-a");
    expect(lines[1]).toContain("tied-same-end-b");
    expect(lines[2]).toContain("tied-later-end");
    expect(lines[3]).toContain("[startTime=unknown] missing-start");
  });

  test("treats duration, score, release, and namespace changes as informational when evidence is equivalent", async () => {
    const left = await fixture("langfuse-trace-a.json");
    const right = structuredClone(left);
    right.id = "trace-equivalent";
    right.release = "different-release";
    const root = right.observations?.find((observation) => !observation.parentObservationId);
    if (root?.metadata) {
      root.metadata.duration_ms = 999;
      root.metadata.resolved_namespace = ["rico"];
    }
    const rank = right.observations?.find((observation) => observation.name === "retrieval.rank_rrf");
    const candidate = (rank?.output as { candidates?: Array<Record<string, unknown>> })?.candidates?.[0];
    if (candidate) candidate.rrf_score = 0.5;

    const result = diffTraces(left, right);

    expect(result.equivalent).toBeTrue();
    expect(traceDiffExitCode(result)).toBe(0);
    expect(result.releaseB).toBe("different-release");
    expect(result.namespaceB).toBe("rico");
    expect(result.stages.find((stage) => stage.name === "retrieval.rank_rrf")?.scoreDeltas).toContain(
      "row-1.rrf_score: 0.03 -> 0.5 delta=0.47",
    );
  });

  test("non-equivalent fixture pair reports evidence changes and the diff exit path", async () => {
    const result = diffTraces(
      await fixture("langfuse-trace-a.json"),
      await fixture("langfuse-trace-b.json"),
    );
    const output = renderTraceDiff(result);

    expect(result.equivalent).toBeFalse();
    expect(traceDiffExitCode(result)).toBe(1);
    expect(output).toContain("equivalent=false");
    expect(output).toContain("release A=abc1234 B=def5678");
    expect(output).toContain("namespace A=rico,shared-kb B=rico");
    expect(output).toContain("candidate_row_ids added=row-3 removed=row-2");
    expect(output).toContain("chosen_row_ids added=row-3 removed=row-1");
    expect(output).toContain("row-1: — -> rrf_window");
    expect(output).toContain("row-1.rrf_score: 0.03 -> 0.025");
  });

  test("aligns duplicate stage names pairwise instead of unioning their evidence", async () => {
    const result = diffTraces(
      await fixture("langfuse-trace-duplicates-a.json"),
      await fixture("langfuse-trace-duplicates-b.json"),
    );

    expect(result.equivalent).toBeFalse();
    expect(traceDiffExitCode(result)).toBe(1);
    expect(result.stages.map((stage) => stage.name)).toEqual([
      "retrieval.fallback_dedupe[1]",
      "retrieval.fallback_dedupe[2]",
    ]);
  });

  test("zero compared stages are inconclusive", async () => {
    const result = diffTraces(
      await fixture("langfuse-trace-empty-a.json"),
      await fixture("langfuse-trace-empty-b.json"),
    );

    expect(result.equivalent).toBeNull();
    expect(traceDiffExitCode(result)).toBe(2);
    expect(renderTraceDiff(result)).toContain("equivalent=unknown (no retrieval evidence found)");

    const rootOnly = structuredClone(await fixture("langfuse-trace-empty-a.json"));
    rootOnly.observations = [{ id: "root", name: "search_brain", output: { content: "not evidence" } }];
    expect(diffTraces(rootOnly, rootOnly).equivalent).toBeNull();
  });

  test("compares counts and degradation markers when row ids are absent", async () => {
    const result = diffTraces(
      await fixture("langfuse-trace-degraded-a.json"),
      await fixture("langfuse-trace-degraded-b.json"),
    );
    const stage = result.stages[0]!;

    expect(result.equivalent).toBeFalse();
    expect(stage.basis).toBe("counts+degradation");
    expect(stage.countDifferences).toContain("counts.values: 10 -> 11");
    expect(stage.degradationDifferences).toContain(
      "payload_degradation_reason: active_span_bytes_limit -> serialization_error",
    );
    expect(renderTraceDiff(result)).toContain("basis=counts+degradation");
  });

  test("treats chosen rows as an ordered ranking", () => {
    const left: LangfuseTrace = {
      id: "ordered-a",
      name: "search_brain",
      observations: [{ name: "retrieval.rank_rrf", output: { selected_row_ids: ["row-1", "row-2"] } }],
    };
    const right = structuredClone(left);
    right.id = "ordered-b";
    right.observations![0]!.output = { selected_row_ids: ["row-2", "row-1"] };

    const result = diffTraces(left, right);
    const stage = result.stages[0]!;

    expect(result.equivalent).toBeFalse();
    expect(stage.chosenAdded).toEqual([]);
    expect(stage.chosenRemoved).toEqual([]);
    expect(stage.chosenReordered).toBeTrue();
    expect(renderTraceDiff(result)).toContain("reordered=true");
  });

  test("keys qmd candidates with null row ids by path and position", async () => {
    const result = diffTraces(
      await fixture("langfuse-trace-qmd-a.json"),
      await fixture("langfuse-trace-qmd-b.json"),
    );

    expect(result.equivalent).toBeFalse();
    expect(result.stages[0]?.candidateRemoved).toEqual(["docs/a.md#1", "docs/b.md#2"]);
    expect(result.stages[0]?.candidateAdded).toEqual(["docs/c.md#1", "docs/d.md#2"]);
  });

  test("escapes control characters in rendered identifiers", () => {
    const left: LangfuseTrace = {
      id: "control-a",
      name: "search_brain",
      observations: [{ name: "retrieval.vector_query", output: { row_ids: ["row-safe"] } }],
    };
    const right: LangfuseTrace = {
      id: "control-b",
      name: "search_brain",
      observations: [{ name: "retrieval.vector_query", output: { row_ids: ["row\nforged"] } }],
    };

    const output = renderTraceDiff(diffTraces(left, right));

    expect(output).toContain("row\\u000a\\u001bforged");
    expect(output).not.toContain("row\nforged");
  });

  test("maps comparison outcomes to isolated exit codes", () => {
    // Mutation proof: changing any one expected mapping makes only this boundary test fail.
    expect([
      traceDiffExitCode(comparison(true)),
      traceDiffExitCode(comparison(false)),
      traceDiffExitCode(comparison(null)),
    ]).toEqual([0, 1, 2]);
  });

  test("renders session summaries in chronological order with status and duration", async () => {
    const first = await fixture("langfuse-trace-a.json");
    const second = await fixture("langfuse-trace-b.json");
    const output = renderSessionTraces([second, first]);

    expect(output.split("\n")[0]).toStartWith("trace-a search_brain 2026-08-06T12:00:00.000Z");
    expect(output).toContain("release=abc1234 status=success duration_ms=120");
    expect(output.split("\n")[1]).toStartWith("trace-b search_brain 2026-08-06T12:01:00.000Z");
  });

  test("repeat report names varying fields and repeat exits nonzero", async () => {
    const traces = [
      await fixture("langfuse-trace-a.json"),
      await fixture("langfuse-trace-b.json"),
    ];
    const output = renderRepeatReport("session-569", traces);
    const comparisons = [diffTraces(traces[0]!, traces[1]!)];

    expect(output).toContain("stage=retrieval.rank_rrf VARIES");
    expect(output).toContain("candidate_row_ids");
    expect(output).toContain("chosen_row_ids");
    expect(output).toContain("score_fields");
    expect(output).toContain("stage=search_brain VARIES fields=duration_ms");
    expect(repeatExitCode(comparisons)).toBe(1);
    expect(repeatExitCode([comparison(true)])).toBe(0);
    expect(repeatExitCode([comparison(null)])).toBe(2);
  });

  test("selects the run's oldest fresh traces and rejects unexpected extras", () => {
    const summaries: LangfuseTrace[] = [
      { id: "newest", timestamp: "2026-08-06T12:00:03.000Z" },
      { id: "old", timestamp: "2026-08-06T11:59:59.000Z" },
      { id: "first", timestamp: "2026-08-06T12:00:01.000Z" },
      { id: "second", timestamp: "2026-08-06T12:00:02.000Z" },
    ];

    expect(selectRepeatedTraceSummaries(summaries.slice(1), 2, "2026-08-06T12:00:00.000Z")?.map((trace) => trace.id))
      .toEqual(["first", "second"]);
    expect(() => selectRepeatedTraceSummaries(summaries, 2, "2026-08-06T12:00:00.000Z"))
      .toThrow("3 fresh traces; expected exactly 2");
  });

  test("parses the last JSON line and preserves child stderr in failures", () => {
    expect(parseRepeatChildOutput("uv notice\n{\"session_id\":\"session-own\"}\n")).toBe("session-own");
    expect(() => parseRepeatChildOutput("uv notice only\n")).toThrow("invalid JSON");
    expect(repeatChildFailureMessage(7, "python traceback\n")).toBe(
      "OpenBrainClient repeat failed (exit 7): python traceback",
    );
  });

  test("CLI wires a differing comparison to exit 1", async () => {
    const result = await runCliDiff(
      await fixture("langfuse-trace-a.json"),
      await fixture("langfuse-trace-b.json"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("equivalent=false");
    expect(result.stderr).toBe("");
  });

  test("CLI rejects an unexpected HTTP 200 body with exit 2", async () => {
    const result = await runCliDiff({ error: "unexpected" }, await fixture("langfuse-trace-b.json"));

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Langfuse returned an invalid trace for trace-a");
  });
});
