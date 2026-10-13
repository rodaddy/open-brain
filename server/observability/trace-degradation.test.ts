import { describe, expect, test } from "vitest";
import { expectDefined } from "../testing/expect-defined.ts";
import {
  installMcpTracing,
  MAX_ACTIVE_SPAN_BYTES,
  traceRetrievalSpanSync,
} from "./langfuse-tracing.ts";
import {
  AUTH,
  ENABLED_CONFIG,
  fakeServer,
  onlySpans,
  recordingLogger,
  recordingSink,
} from "./langfuse-tracing-fixtures.ts";

async function compactProjectionRetainsComparableFields(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: recordingLogger(),
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  const large = "z".repeat(MAX_ACTIVE_SPAN_BYTES);
  const rows = [
    {
      row_id: "row-a",
      source_type: "session_event",
      namespace: "rico",
      similarity: 0.91,
      bm25_score: 0.4,
      usefulness: 0.7,
      chosen: true,
      filtered_by: null,
      content_preview: large,
    },
  ];
  server.registerTool(
    "compact_projection_fields",
    { inputSchema: {} } as never,
    (() =>
      traceRetrievalSpanSync({
        name: "retrieval.vector_query",
        run: () => ({ count: rows.length, row_ids: ["row-a"], candidates: rows }),
      })) as never,
  );

  await handlers.get("compact_projection_fields")?.({}, AUTH);

  const span = expectDefined(onlySpans(sink.bodies)[0], "the degraded span");
  expect(span.metadata.payload_degraded).toBe(true);
  expect(span.output).toMatchObject({
    evidence_complete: true,
    evidence: {
      count: 1,
      row_ids: ["row-a"],
      candidates: [
        {
          row_id: "row-a",
          source_type: "session_event",
          namespace: "rico",
          similarity: 0.91,
          bm25_score: 0.4,
          usefulness: 0.7,
          chosen: true,
          filtered_by: null,
        },
      ],
    },
  });
  expect(JSON.stringify(span)).not.toContain(large);
}

async function oversizedProjectionMarksIncomplete(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: recordingLogger(),
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  const rows = Array.from({ length: 5_000 }, (_, index) => ({
    row_id: `row-${String(index).padStart(5, "0")}-${"x".repeat(32)}`,
    source_type: "thought",
    namespace: "rico",
    similarity: 0.9,
    usefulness: 0.5,
    content_preview: "content that must be omitted ".repeat(20),
  }));
  server.registerTool(
    "oversized_projection",
    { inputSchema: {} } as never,
    (() =>
      traceRetrievalSpanSync({
        name: "retrieval.vector_query",
        run: () => ({
          count: rows.length,
          row_ids: rows.map((row) => row.row_id),
          candidates: rows,
        }),
      })) as never,
  );

  await handlers.get("oversized_projection")?.({}, AUTH);

  const span = expectDefined(onlySpans(sink.bodies)[0], "the oversized span");
  const output = span.output as {
    evidence?: unknown;
    evidence_complete?: boolean;
    evidence_truncated?: boolean;
  };
  expect(output.evidence_complete).toBe(false);
  expect(output.evidence_truncated).toBe(true);
  expect(output.evidence).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(span), "utf8")).toBeLessThan(
    MAX_ACTIVE_SPAN_BYTES,
  );
}

async function collectionProjectionStaysWithinActiveBudget(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: recordingLogger(),
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  const rowIds = Array.from(
    { length: 2_200 },
    (_, index) => `row-${String(index).padStart(4, "0")}-${"x".repeat(24)}`,
  );
  server.registerTool(
    "collection_projection_budget",
    { inputSchema: {} } as never,
    (() => {
      for (let index = 0; index < 4; index += 1)
        traceRetrievalSpanSync({
          name: `retrieval.vector_query_${index}`,
          run: () => ({ count: rowIds.length, row_ids: rowIds }),
        });
    }) as never,
  );

  await handlers.get("collection_projection_budget")?.({}, AUTH);

  const spans = onlySpans(sink.bodies);
  expect(spans.length).toBeLessThan(4);
  expect(spans.some((span) => span.metadata.payload_evidence_truncated === true)).toBe(
    true,
  );
  expect(spans.some((span) => span.metadata.additional_spans_omitted === 1)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(spans), "utf8")).toBeLessThan(
    MAX_ACTIVE_SPAN_BYTES,
  );
}

describe("bounded degraded trace projections", () => {
  test(
    "retain row identity, namespace, scores, and classifications",
    compactProjectionRetainsComparableFields,
  );
  test("mark oversized evidence incomplete", oversizedProjectionMarksIncomplete);
  test(
    "keep the active child-span collection within its byte budget",
    collectionProjectionStaysWithinActiveBudget,
  );
});
