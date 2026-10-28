import { describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
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
import { expectDefined } from "./test-support/expect-defined.ts";

async function jsonFixture<T>(name: string): Promise<T> {
  return JSON.parse(
    await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

async function fixture(name: string): Promise<LangfuseTrace> {
  return jsonFixture<LangfuseTrace>(name);
}

/**
 * A loopback JSON server on an ephemeral port (issue 751 replaced the previous
 * bun-only HTTP fixture with this node:http one). `origin` is what the child
 * process gets as OPENBRAIN_TRACING_ENDPOINT.
 */
async function jsonServer(
  handler: (request: IncomingMessage) => unknown,
): Promise<{ origin: string; stop: () => Promise<void> }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(handler(request)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Runs the CLI against `origin`, returning its exit code and streams. */
async function runCli(
  argv: string[],
  origin: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["scripts/langfuse-trace.ts", ...argv], {
    cwd: new URL("../", import.meta.url).pathname,
    env: {
      ...process.env,
      OPENBRAIN_TRACING_ENDPOINT: origin,
      OPENBRAIN_TRACING_PUBLIC_KEY: "fixture-public",
      OPENBRAIN_TRACING_SECRET_KEY: "fixture-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out: string[] = [];
  const err: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => out.push(chunk));
  child.stderr.on("data", (chunk: string) => err.push(chunk));
  const [code] = (await once(child, "close")) as [number | null];
  return { exitCode: code ?? 0, stdout: out.join(""), stderr: err.join("") };
}

function comparison(equivalent: boolean | null): TraceComparison {
  return {
    equivalent,
    evidenceIncomplete: false,
    toolA: "search_brain",
    toolB: "search_brain",
    releaseA: "a",
    releaseB: "b",
    namespaceA: "dana",
    namespaceB: "dana",
    stages: [],
  };
}

async function runCliSession(
  tracePage: unknown,
  trace: unknown,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const server = await jsonServer((request) =>
    new URL(request.url ?? "/", "http://127.0.0.1").pathname === "/api/public/traces"
      ? tracePage
      : trace,
  );
  try {
    return await runCli(["session", "fixture-session", "-n", "1"], server.origin);
  } finally {
    await server.stop();
  }
}

async function runCliDiff(
  traceA: unknown,
  traceB: unknown,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const server = await jsonServer((request) =>
    new URL(request.url ?? "/", "http://127.0.0.1").pathname.split("/").at(-1) ===
    "trace-a"
      ? traceA
      : traceB,
  );
  try {
    return await runCli(["diff", "trace-a", "trace-b"], server.origin);
  } finally {
    await server.stop();
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
    expect(output).toContain(
      "caller=user=dana client=dana token_client=dana agent=trace-fixture role=agent",
    );
    expect(output).toContain("status=success");
    expect(vectorIndex).toBeGreaterThan(0);
    expect(rankIndex).toBeGreaterThan(vectorIndex);
    expect(output).toContain("stage=candidate_generation duration_ms=50");
    expect(output).toContain("row_ids=[row-1,row-2]");
  });

  test("orders tied timestamps by end time then observation id and renders missing starts last", async () => {
    const lines = renderTimeline(
      await fixture("langfuse-trace-timeline-degenerate.json"),
    )
      .split("\n")
      .slice(5);

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
    const root = right.observations?.find(
      (observation) => !observation.parentObservationId,
    );
    if (root?.metadata) {
      root.metadata.duration_ms = 999;
      root.metadata.resolved_namespace = ["dana"];
    }
    const rank = right.observations?.find(
      (observation) => observation.name === "retrieval.rank_rrf",
    );
    const candidate = (rank?.output as { candidates?: Array<Record<string, unknown>> })
      ?.candidates?.[0];
    if (candidate) candidate.rrf_score = 0.5;

    const result = diffTraces(left, right);

    expect(result.equivalent).toBe(true);
    expect(traceDiffExitCode(result)).toBe(0);
    expect(result.releaseB).toBe("different-release");
    expect(result.namespaceB).toBe("dana");
    expect(
      result.stages.find((stage) => stage.name === "retrieval.rank_rrf")?.scoreDeltas,
    ).toContain("row-1.rrf_score: 0.03 -> 0.5 delta=0.47");
  });
});

describe("Langfuse trace forensics evidence comparison", () => {
  test("non-equivalent fixture pair reports evidence changes and the diff exit path", async () => {
    const result = diffTraces(
      await fixture("langfuse-trace-a.json"),
      await fixture("langfuse-trace-b.json"),
    );
    const output = renderTraceDiff(result);

    expect(result.equivalent).toBe(false);
    expect(traceDiffExitCode(result)).toBe(1);
    expect(output).toContain("equivalent=false");
    expect(output).toContain("release A=abc1234 B=def5678");
    expect(output).toContain("namespace A=dana,shared-kb B=dana");
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

    expect(result.equivalent).toBe(false);
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
    expect(renderTraceDiff(result)).toContain(
      "equivalent=unknown (no retrieval evidence found)",
    );

    const rootOnly = structuredClone(await fixture("langfuse-trace-empty-a.json"));
    rootOnly.observations = [
      { id: "root", name: "search_brain", output: { content: "not evidence" } },
    ];
    expect(diffTraces(rootOnly, rootOnly).equivalent).toBeNull();
  });

  test("compares counts and degradation markers when row ids are absent", async () => {
    const result = diffTraces(
      await fixture("langfuse-trace-degraded-a.json"),
      await fixture("langfuse-trace-degraded-b.json"),
    );
    const stage = expectDefined(result.stages[0], "degraded stage 0");

    expect(result.equivalent).toBe(false);
    expect(stage.basis).toBe("counts+degradation");
    expect(stage.countDifferences).toContain("counts.values: 10 -> 11");
    expect(stage.degradationDifferences).toContain(
      "payload_degradation_reason: active_span_bytes_limit -> serialization_error",
    );
    expect(renderTraceDiff(result)).toContain("basis=counts+degradation");
  });

  test("reads compact row evidence nested in a degraded span", () => {
    const traceA: LangfuseTrace = {
      id: "compact-a",
      name: "search_brain",
      observations: [
        {
          name: "retrieval.vector_query",
          metadata: { payload_degraded: true },
          output: {
            counts: { values: 12, string_bytes: 524_336 },
            evidence: {
              count: 2,
              row_ids: ["row-a", "row-b"],
              candidates: [{ row_id: "row-a" }, { row_id: "row-b" }],
            },
          },
        },
      ],
    };
    const traceB = structuredClone(traceA);
    traceB.id = "compact-b";
    const output = expectDefined(traceB.observations, "trace B observations")[0]
      ?.output as { evidence: { row_ids: string[]; candidates: unknown[] } };
    output.evidence.row_ids = ["row-a", "row-c"];
    output.evidence.candidates = [{ row_id: "row-a" }, { row_id: "row-c" }];

    const result = diffTraces(traceA, traceB);
    const stage = expectDefined(result.stages[0], "compact stage");
    expect(stage.basis).toBe("row_ids");
    expect(stage.candidateAdded).toEqual(["row-c"]);
    expect(stage.candidateRemoved).toEqual(["row-b"]);
    expect(result.equivalent).toBe(false);
  });
});

describe("Langfuse trace forensics incomplete evidence", () => {
  test("returns unknown when both stages explicitly drop retrieval evidence", () => {
    const trace = (id: string, metadataOnly = false): LangfuseTrace => ({
      id,
      name: "search_brain",
      observations: [
        {
          name: "retrieval.vector_query",
          metadata: {
            payload_degraded: true,
            payload_degradation_reason: "active_span_bytes_limit",
            payload_limit_bytes: 262_144,
            ...(metadataOnly ? { payload_evidence_truncated: true } : {}),
          },
          output: {
            counts: { values: 5_000, arrays: 2, objects: 5_000 },
            ...(metadataOnly
              ? {}
              : { evidence_complete: false, evidence_truncated: true }),
          },
        },
      ],
    });

    const result = diffTraces(trace("incomplete-a"), trace("incomplete-b"));

    expect(result.equivalent).toBeNull();
    expect(traceDiffExitCode(result)).toBe(2);
    expect(renderTraceDiff(result)).toContain(
      "equivalent=unknown (incomplete retrieval evidence)",
    );

    const metadataResult = diffTraces(
      trace("metadata-incomplete-a", true),
      trace("metadata-incomplete-b", true),
    );
    expect(metadataResult.equivalent).toBeNull();
    expect(traceDiffExitCode(metadataResult)).toBe(2);
  });
});

describe("Langfuse trace forensics ranking and rendering", () => {
  test("treats chosen rows as an ordered ranking", () => {
    const left: LangfuseTrace = {
      id: "ordered-a",
      name: "search_brain",
      observations: [
        {
          name: "retrieval.rank_rrf",
          output: { selected_row_ids: ["row-1", "row-2"] },
        },
      ],
    };
    const right = structuredClone(left);
    right.id = "ordered-b";
    expectDefined(
      expectDefined(right.observations, "right observations")[0],
      "right observation 0",
    ).output = { selected_row_ids: ["row-2", "row-1"] };

    const result = diffTraces(left, right);
    const stage = expectDefined(result.stages[0], "ordered stage 0");

    expect(result.equivalent).toBe(false);
    expect(stage.chosenAdded).toEqual([]);
    expect(stage.chosenRemoved).toEqual([]);
    expect(stage.chosenReordered).toBe(true);
    expect(renderTraceDiff(result)).toContain("reordered=true");
  });

  test("keys qmd candidates with null row ids by path and position", async () => {
    const result = diffTraces(
      await fixture("langfuse-trace-qmd-a.json"),
      await fixture("langfuse-trace-qmd-b.json"),
    );

    expect(result.equivalent).toBe(false);
    expect(result.stages[0]?.candidateRemoved).toEqual(["docs/a.md#1", "docs/b.md#2"]);
    expect(result.stages[0]?.candidateAdded).toEqual(["docs/c.md#1", "docs/d.md#2"]);
  });

  test("escapes control characters in rendered identifiers", () => {
    const left: LangfuseTrace = {
      id: "control-a",
      name: "search_brain",
      observations: [
        { name: "retrieval.vector_query", output: { row_ids: ["row-safe"] } },
      ],
    };
    const right: LangfuseTrace = {
      id: "control-b",
      name: "search_brain",
      observations: [
        { name: "retrieval.vector_query", output: { row_ids: ["row\nforged"] } },
      ],
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

    expect(
      output
        .split("\n")[0]
        ?.startsWith("trace-a search_brain 2026-08-06T12:00:00.000Z"),
    ).toBe(true);
    expect(output).toContain("release=abc1234 status=success duration_ms=120");
    expect(
      output
        .split("\n")[1]
        ?.startsWith("trace-b search_brain 2026-08-06T12:01:00.000Z"),
    ).toBe(true);
  });

  test("repeat report names varying fields and repeat exits nonzero", async () => {
    const traces = [
      await fixture("langfuse-trace-a.json"),
      await fixture("langfuse-trace-b.json"),
    ];
    const output = renderRepeatReport("session-569", traces);
    const comparisons = [
      diffTraces(
        expectDefined(traces[0], "trace a"),
        expectDefined(traces[1], "trace b"),
      ),
    ];

    expect(output).toContain("stage=retrieval.rank_rrf VARIES");
    expect(output).toContain("candidate_row_ids");
    expect(output).toContain("chosen_row_ids");
    expect(output).toContain("score_fields");
    expect(output).toContain("stage=search_brain VARIES fields=duration_ms");
    expect(repeatExitCode(comparisons)).toBe(1);
    expect(repeatExitCode([comparison(true)])).toBe(0);
    expect(repeatExitCode([comparison(null)])).toBe(2);
  });
});

describe("Langfuse trace forensics repeat selection and CLI wiring", () => {
  test("selects the run's oldest fresh traces and rejects unexpected extras", () => {
    const summaries: LangfuseTrace[] = [
      { id: "newest", timestamp: "2026-08-06T12:00:03.000Z" },
      { id: "old", timestamp: "2026-08-06T11:59:59.000Z" },
      { id: "first", timestamp: "2026-08-06T12:00:01.000Z" },
      { id: "second", timestamp: "2026-08-06T12:00:02.000Z" },
    ];

    expect(
      selectRepeatedTraceSummaries(
        summaries.slice(1),
        2,
        "2026-08-06T12:00:00.000Z",
      )?.map((trace) => trace.id),
    ).toEqual(["first", "second"]);
    expect(() =>
      selectRepeatedTraceSummaries(summaries, 2, "2026-08-06T12:00:00.000Z"),
    ).toThrow("3 fresh traces; expected exactly 2");
  });

  test("parses the last JSON line and preserves child stderr in failures", () => {
    expect(parseRepeatChildOutput('uv notice\n{"session_id":"session-own"}\n')).toBe(
      "session-own",
    );
    expect(() => parseRepeatChildOutput("uv notice only\n")).toThrow("invalid JSON");
    expect(repeatChildFailureMessage(7, "python traceback\n")).toBe(
      "OpenBrainClient repeat failed (exit 7): python traceback",
    );
  });

  test("session accepts captured real list rows with observation ids", async () => {
    const result = await runCliSession(
      await jsonFixture("langfuse-trace-list-live-sanitized.json"),
      await fixture("langfuse-trace-a.json"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith("trace-a search_brain")).toBe(true);
    expect(result.stderr).toBe("");
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
    const result = await runCliDiff(
      { error: "unexpected" },
      await fixture("langfuse-trace-b.json"),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Langfuse returned an invalid trace for trace-a");
  });
});
