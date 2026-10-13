/**
 * `installMcpTracing`: the trace a tool call produces, and its masked evidence.
 *
 * The contract under test is the one the module states: every tool call emits
 * one trace retaining complete input and output around masked detector matches,
 * plus caller identity. The lifecycle half of the contract — what happens when
 * the SINK misbehaves — lives in `langfuse-tracing-install-lifecycle.test.ts`.
 *
 * Each `test` body is a named module-scope function: the suite is large enough
 * that inline bodies push the `describe` callback past the size and nesting
 * rules, and naming them also makes a failing case greppable.
 */
import { describe, expect, test } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "../testing/expect-defined.ts";
import {
  installMcpTracing,
  MAX_ACTIVE_SPAN_BYTES,
  setActiveMcpTraceMetadata,
  traceRetrievalSpan,
  traceRetrievalSpanSync,
} from "./langfuse-tracing.ts";
import { mergeFallbackRows } from "../tools/search-engine.ts";
import { rowIdsEvidence, type SearchRow } from "../tools/search-engine-types.ts";
import { logger as legacyLogger } from "../logging/legacy-logger.ts";
import {
  AUTH,
  consoleTracingLoggerFrom,
  ENABLED_CONFIG,
  fakeServer,
  onlyBody,
  onlySpans,
  recordingSink,
  searchRow,
} from "./langfuse-tracing-fixtures.ts";

const consoleTracingLogger = consoleTracingLoggerFrom(legacyLogger);

async function recordsOneCompleteTracePerCall(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });

  const result = { content: [{ type: "text", text: "the full answer body" }] };
  server.registerTool(
    "log_thought",
    { inputSchema: {} } as never,
    (() => result) as never,
  );

  const args = {
    content: "the full prompt body, verbatim",
    session_key: "sess-530",
  };
  await handlers.get("log_thought")?.(args, AUTH);

  expect(sink.bodies).toHaveLength(1);
  const body = onlyBody(sink.bodies);
  expect(body.name).toBe("log_thought");
  // CONTENT-FUL is the requirement: the same objects, not a summary of them.
  expect(body.input).toBe(args);
  expect(body.output).toBe(result);
  expect(body.sessionId).toBe("sess-530");
  expect(body.userId).toBe("rico");
  expect(body.tags).toEqual(["open-brain-server", "mcp-tool"]);
  expect(body.metadata).toMatchObject({
    caller_role: "admin",
    caller_client_id: "rico",
    caller_token_client_id: "rico",
    caller_agent_id: "worker-530",
    namespace_source: "header",
    status: "success",
  });
  expect((body.metadata as { duration_ms: number }).duration_ms).toBeGreaterThanOrEqual(
    0,
  );
}

async function emitsMaskedRetrievalChildSpans(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  server.registerTool(
    "search_brain",
    { inputSchema: {} } as never,
    (async () => {
      setActiveMcpTraceMetadata({ resolved_namespace: "rico" });
      const candidates = await traceRetrievalSpan({
        name: "retrieval.vector_query",
        input: { namespace: "rico" },
        run: async () => [
          {
            row_id: "row-569",
            content_preview: "api_key=sk-live-candidate",
            similarity: 0.93,
            bm25_score: null,
          },
        ],
        output: (rows) => ({ count: rows.length, candidates: rows }),
      });
      return traceRetrievalSpanSync({
        name: "retrieval.rank_rrf",
        input: { candidates },
        run: () => ({ content: [{ type: "text", text: "ok" }] }),
        output: () => ({
          selected_row_ids: ["row-569"],
          candidates: [
            {
              row_id: "row-569",
              rrf_score: 0.031,
              chosen: true,
              filtered_by: null,
            },
          ],
        }),
      });
    }) as never,
  );

  await handlers.get("search_brain")?.({ query: "memory" }, AUTH);

  const body = onlyBody(sink.bodies);
  const spans = onlySpans(sink.bodies);
  expect(body.metadata.resolved_namespace).toBe("rico");
  expect(spans.map((span) => span.name)).toEqual([
    "retrieval.vector_query",
    "retrieval.rank_rrf",
  ]);
  expect(expectDefined(spans[0], "the vector-query span").output).toMatchObject({
    count: 1,
    candidates: [{ row_id: "row-569", similarity: 0.93 }],
  });
  expect(expectDefined(spans[1], "the rank span").output).toMatchObject({
    selected_row_ids: ["row-569"],
    candidates: [{ row_id: "row-569", chosen: true, filtered_by: null }],
  });
  const serialized = JSON.stringify(spans);
  expect(serialized).not.toContain("sk-live-candidate");
  expect(serialized).toContain("[MASKED:");
}

async function handlerMetadataCannotForgeIdentity(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  server.registerTool(
    "guarded_tool",
    { inputSchema: {} } as never,
    (() => {
      setActiveMcpTraceMetadata({
        caller_role: "readonly",
        caller_client_id: "forged",
        status: "success",
      });
      throw new Error("handler failed");
    }) as never,
  );

  await expect(handlers.get("guarded_tool")?.({}, AUTH)).rejects.toThrow(
    "handler failed",
  );
  expect(onlyBody(sink.bodies).metadata).toMatchObject({
    caller_role: "admin",
    caller_client_id: "rico",
    status: "exception",
  });
}

async function throwingSummarizerLeavesResultAlone(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  const result = { content: [{ type: "text", text: "unchanged" }] };
  server.registerTool(
    "summarizer_guard",
    { inputSchema: {} } as never,
    (() =>
      traceRetrievalSpanSync({
        name: "retrieval.rank_rrf",
        run: () => result,
        output: () => {
          throw new Error("summary exploded");
        },
      })) as never,
  );

  const returned = await handlers.get("summarizer_guard")?.({}, AUTH);
  expect(returned).toBe(result);
  expect(expectDefined(onlySpans(sink.bodies)[0], "the rank span").output).toEqual({
    instrumentation_error: "Error",
  });
}

async function largeSpansDegradeToCountsOnly(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  const large = "z".repeat(MAX_ACTIVE_SPAN_BYTES);
  server.registerTool(
    "bounded_spans",
    { inputSchema: {} } as never,
    (() => {
      traceRetrievalSpanSync({
        name: "retrieval.vector_query",
        input: { large },
        run: () => ({ large }),
      });
      return traceRetrievalSpanSync({
        name: "retrieval.rank_rrf",
        input: { large },
        run: () => ({ ok: true }),
      });
    }) as never,
  );

  await handlers.get("bounded_spans")?.({}, AUTH);

  const spans = onlySpans(sink.bodies);
  expect(spans).toHaveLength(2);
  expect(spans.every((span) => span.metadata.payload_degraded === true)).toBe(true);
  expect(JSON.stringify(spans)).not.toContain(large);
  expect(Buffer.byteLength(JSON.stringify(spans), "utf8")).toBeLessThan(
    MAX_ACTIVE_SPAN_BYTES,
  );
}

async function degradedRetrievalSpansRetainCompactRowEvidence(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  const large = "z".repeat(MAX_ACTIVE_SPAN_BYTES);
  const rows = [
    { row_id: "row-vector-a", content_preview: large },
    { row_id: "row-vector-b", content_preview: large },
  ];
  server.registerTool(
    "bounded_retrieval_spans",
    { inputSchema: {} } as never,
    (() => {
      traceRetrievalSpanSync({
        name: "retrieval.vector_query",
        input: { query: large },
        run: () => ({
          count: rows.length,
          row_ids: rows.map((row) => row.row_id),
          candidates: rows,
        }),
      });
      return traceRetrievalSpanSync({
        name: "retrieval.rank_rrf",
        input: {
          vector: { count: rows.length, row_ids: rows.map((row) => row.row_id) },
        },
        run: () => ({ ok: true }),
        output: () => ({
          candidate_count: rows.length,
          selected_count: 1,
          selected_row_ids: ["row-vector-b"],
          candidates: rows.map((row, index) => ({
            ...row,
            chosen: index === 1,
            filtered_by: null,
          })),
        }),
      });
    }) as never,
  );

  await handlers.get("bounded_retrieval_spans")?.({}, AUTH);

  const spans = onlySpans(sink.bodies);
  expect(spans.every((span) => span.metadata.payload_degraded === true)).toBe(true);
  const vector = expectDefined(spans[0], "the degraded vector span");
  expect(vector.output).toMatchObject({
    evidence: {
      count: 2,
      row_ids: ["row-vector-a", "row-vector-b"],
      candidates: [{ row_id: "row-vector-a" }, { row_id: "row-vector-b" }],
    },
  });
  const rank = expectDefined(spans[1], "the degraded rank span");
  expect(rank.output).toMatchObject({
    evidence: {
      candidate_count: 2,
      selected_count: 1,
      selected_row_ids: ["row-vector-b"],
      candidates: [{ row_id: "row-vector-a" }, { row_id: "row-vector-b" }],
    },
  });
  const serialized = JSON.stringify(spans);
  expect(serialized).not.toContain(large);
  expect(serialized).toContain("row-vector-a");
  expect(serialized).toContain("row-vector-b");
  expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(MAX_ACTIVE_SPAN_BYTES);
}

/** Resolves the pending call named by `args.call`; hoisted to flatten nesting. */
function deferredRun(releases: Map<string, () => void>, call: string): Promise<void> {
  return new Promise<void>((resolve) => {
    releases.set(call, resolve);
  });
}

async function concurrentCallsKeepTheirOwnSpans(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  const releases = new Map<string, () => void>();
  server.registerTool(
    "concurrent_search",
    { inputSchema: {} } as never,
    (async (args: { call: string }) => {
      await traceRetrievalSpan({
        name: `retrieval.${args.call}`,
        run: () => deferredRun(releases, args.call),
      });
      return { call: args.call };
    }) as never,
  );

  const callA = handlers.get("concurrent_search")?.({ call: "a" }, AUTH);
  const callB = handlers.get("concurrent_search")?.({ call: "b" }, AUTH);
  await delay(0);
  releases.get("b")?.();
  await delay(0);
  releases.get("a")?.();
  await Promise.all([callA, callB]);

  const byCall = new Map(
    sink.bodies.map((body) => [
      (body.input as { call: string }).call,
      body.spans?.map((span) => span.name),
    ]),
  );
  expect(byCall.get("a")).toEqual(["retrieval.a"]);
  expect(byCall.get("b")).toEqual(["retrieval.b"]);
}

/**
 * A traced rank stage standing in for the engine's private `rrfMerge`.
 *
 * `rrfMerge` is internal to `search-engine.ts` and stays that way (issue 841);
 * what this case proves is that the TRACING wrapper returns a rank stage's rows
 * unchanged, so the stage is reproduced here over precomputed rows rather than
 * exported for a test.
 */
function tracedRank(
  vectorRows: readonly SearchRow[],
  keywordRows: readonly SearchRow[],
  selected: readonly SearchRow[],
): SearchRow[] {
  return traceRetrievalSpanSync({
    name: "retrieval.rank_rrf",
    input: {
      limit: selected.length,
      vector: rowIdsEvidence(vectorRows),
      keyword: rowIdsEvidence(keywordRows),
    },
    metadata: { stage: "scoring_ranking", filter_names: ["rrf_limit"] },
    run: () => [...selected],
  });
}

/** The transform outputs the equivalence case compares with and without tracing. */
function transformResults(rows: SearchRow[]): Record<string, unknown> {
  const third = expectDefined(rows[2], "the third fixture row");
  return {
    rrf: [tracedRank([], [], []), tracedRank(rows, [], rows.slice(0, 2))],
    serverFallback: [
      mergeFallbackRows([], [], 3),
      mergeFallbackRows(rows.slice(0, 2), [third], 2),
    ],
  };
}

async function transformsAreEqualWithAndWithoutTracing(): Promise<void> {
  const equalRows = [searchRow("a"), searchRow("b"), searchRow("c")];
  const baseline = transformResults(equalRows);
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  server.registerTool(
    "equivalence",
    { inputSchema: {} } as never,
    (() => transformResults(equalRows)) as never,
  );

  const traced = await handlers.get("equivalence")?.({}, AUTH);
  expect(traced).toEqual(baseline);
}

async function rankInputsCarryIdsNotContent(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  const content = "candidate content must not be copied into rank input";
  const ranked = searchRow("ranked", content);
  server.registerTool(
    "rank_input",
    { inputSchema: {} } as never,
    (() => tracedRank([ranked], [], [ranked])) as never,
  );

  await handlers.get("rank_input")?.({}, AUTH);

  const span = expectDefined(onlySpans(sink.bodies)[0], "the rank span");
  expect(span.input).toMatchObject({
    vector: { count: 1, row_ids: ["ranked"] },
    keyword: { count: 0, row_ids: [] },
  });
  expect(JSON.stringify(span.input)).not.toContain(content);
}

async function fallbackEvidenceClassifiesEachRow(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  server.registerTool(
    "fallback_classification",
    { inputSchema: {} } as never,
    (() =>
      mergeFallbackRows(
        [searchRow("primary", "same content")],
        [
          searchRow("legacy-duplicate", "same   content"),
          searchRow("legacy-chosen", "unique content"),
        ],
        2,
      )) as never,
  );

  await handlers.get("fallback_classification")?.({}, AUTH);

  const output = expectDefined(onlySpans(sink.bodies)[0], "the fallback span")
    .output as {
    candidates: Array<{
      row_id: string;
      chosen: boolean;
      filtered_by: string | null;
    }>;
  };
  expect(output.candidates).toMatchObject([
    { row_id: "primary", chosen: true, filtered_by: null },
    {
      row_id: "legacy-duplicate",
      chosen: false,
      filtered_by: "fallback_duplicate",
    },
    { row_id: "legacy-chosen", chosen: true, filtered_by: null },
  ]);
}

describe("installMcpTracing", () => {
  test(
    "records one trace per call with complete benign input, output and caller identity",
    recordsOneCompleteTracePerCall,
  );

  test(
    "emits masked retrieval child spans with row ids, scores, filter reasons, and namespace value",
    emitsMaskedRetrievalChildSpans,
  );

  test(
    "handler metadata cannot overwrite auth identity or exception status",
    handlerMetadataCannotForgeIdentity,
  );

  test(
    "a throwing summarizer records instrumentation_error without changing the tool result",
    throwingSummarizerLeavesResultAlone,
  );

  test(
    "active child spans degrade to counts-only after the total payload allowance",
    largeSpansDegradeToCountsOnly,
  );

  test(
    "degraded retrieval spans retain compact row ids and counts",
    degradedRetrievalSpansRetainCompactRowEvidence,
  );

  test(
    "concurrent calls keep child spans attributed to their own trace",
    concurrentCallsKeepTheirOwnSpans,
  );

  test(
    "rrf and fallback transforms are deep-equal with tracing active or absent",
    transformsAreEqualWithAndWithoutTracing,
  );

  test(
    "ranking inputs carry ids and counts instead of candidate content",
    rankInputsCarryIdsNotContent,
  );

  test(
    "fallback evidence uses the run's dedupe key and exact classifications",
    fallbackEvidenceClassifiesEachRow,
  );
});
