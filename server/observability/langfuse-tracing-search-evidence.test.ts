/**
 * The retrieval evidence a REAL registered search tool emits.
 *
 * Split from the rest of the install suite because these three cases are the
 * only ones that stand up a search registrar and a pool double, and they are
 * what proves the masked evidence survives the whole retrieval tree rather than
 * only the hand-built spans next door.
 */
import { describe, expect, test } from "vitest";
import { expectDefined } from "../testing/expect-defined.ts";
import { installMcpTracing } from "./langfuse-tracing.ts";
import { registerSearchBrainTool } from "../tools/search-brain.ts";
import { registerSearchAllTool, setQmdSpawn } from "../tools/search-all.ts";
import { DEFAULT_SHARED_NAMESPACE_NAMES } from "../tools/shared-namespace-fixture.ts";
import { executeSearch as executeServerSearch } from "../tools/search-engine.ts";
import { logger as legacyLogger } from "../logging/legacy-logger.ts";
import {
  AUTH,
  consoleTracingLoggerFrom,
  ENABLED_CONFIG,
  fakeServer,
  firstCandidatePreview,
  onlySpans,
  qmdSpawn,
  recordingSink,
  searchRow,
} from "./langfuse-tracing-fixtures.ts";

const consoleTracingLogger = consoleTracingLoggerFrom(legacyLogger);

async function legacyRegisteredSearchEmitsMaskedEvidence(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  const tail = "FULL_CONTENT_TAIL";
  const secret = "sk-live-evidence-secret";
  const longContent = `${"x".repeat(1_000)} api_key=${secret} ${tail}`;
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM ob_links")) return { rows: [] };
      if (sql.startsWith("UPDATE") || sql.startsWith("INSERT")) {
        return { rows: [] };
      }
      return { rows: [searchRow("real-search-row", longContent)] };
    },
  };
  registerSearchBrainTool(server as never, {
    pool: pool as never,
    embedFn: async () => Array(768).fill(0.1),
    logger: { warn() {}, error() {}, info() {}, debug() {} } as never,
    sharedNamespaceNames: DEFAULT_SHARED_NAMESPACE_NAMES,
  });

  await handlers.get("search_brain")?.(
    { query: "real retrieval", table: "thoughts", search_mode: "keyword", limit: 1 },
    AUTH,
  );

  expect(onlySpans(sink.bodies).map((span) => span.name)).toEqual([
    "retrieval.keyword_query",
    "retrieval.execute",
  ]);
  const evidence = firstCandidatePreview(sink.bodies);
  expect(evidence).toContain(tail);
  expect(evidence).toContain("[MASKED:");
  expect(evidence).not.toContain(secret);
}

async function serverSearchTreeEmitsMaskedEvidence(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  const tail = "SERVER_FULL_CONTENT_TAIL";
  const secret = "sk-live-server-evidence-secret";
  const longContent = `${"y".repeat(1_000)} api_key=${secret} ${tail}`;
  const pool = {
    query: async () => ({
      rows: [searchRow("server-search-row", longContent)],
    }),
  };
  server.registerTool(
    "server_search_evidence",
    { inputSchema: {} } as never,
    (async () => {
      await executeServerSearch(
        {
          pool: pool as never,
          embedFn: async () => Array(768).fill(0.1),
          logger: { warn() {}, error() {}, info() {}, debug() {} } as never,
        },
        ["thoughts"],
        "real retrieval",
        1,
        "keyword",
        undefined,
        0,
        "dana",
      );
      return { content: [{ type: "text", text: "ok" }] };
    }) as never,
  );

  await handlers.get("server_search_evidence")?.({}, AUTH);

  expect(onlySpans(sink.bodies).map((span) => span.name)).toEqual([
    "retrieval.keyword_query",
    "retrieval.execute",
  ]);
  const evidence = firstCandidatePreview(sink.bodies);
  expect(evidence).toContain(tail);
  expect(evidence).toContain("[MASKED:");
  expect(evidence).not.toContain(secret);
}

async function federatedRankDistinguishesDuplicatePaths(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  registerSearchAllTool(
    server as never,
    {
      pool: { query: async () => ({ rows: [] }) } as never,
      embedFn: async () => Array(768).fill(0.1),
      logger: { warn() {}, error() {}, info() {}, debug() {} } as never,
      qmdPath: "qmd-stub-entrypoint",
      sharedNamespaceNames: DEFAULT_SHARED_NAMESPACE_NAMES,
    } as never,
  );
  // Stub through the module seam, not the global: issue 751 moved search_all
  // off `Bun.spawn` onto the injectable `setQmdSpawn`, so assigning the global
  // would stub nothing and quietly exercise a real subprocess instead.
  const commands: string[][] = [];
  const fakeSpawn = qmdSpawn([
    { path: "/same.md", content: "first", score: 1 },
    { path: "/same.md", content: "second", score: 1 },
    { path: "/same.md", content: "third", score: 1 },
  ]);
  const originalSpawn = setQmdSpawn((command) => {
    commands.push(command);
    return fakeSpawn(command);
  });
  try {
    await handlers.get("search_all")?.(
      { query: "duplicate path", sources: "qmd", offset: 1, limit: 1 },
      AUTH,
    );
  } finally {
    setQmdSpawn(originalSpawn);
  }

  const span = expectDefined(
    onlySpans(sink.bodies).find(
      (candidate) => candidate.name === "retrieval.federated_rank",
    ),
    "the federated-rank span",
  );
  expect(commands).toEqual([
    [
      process.execPath,
      "qmd-stub-entrypoint",
      "search",
      "duplicate path",
      "--json",
      "-n",
      "2",
    ],
  ]);
  const candidates = (
    span.output as {
      candidates: Array<{ chosen: boolean; filtered_by: string | null }>;
    }
  ).candidates;
  expect(candidates.map((candidate) => candidate.chosen)).toEqual([false, true, false]);
  expect(candidates.map((candidate) => candidate.filtered_by)).toEqual([
    "pagination_offset",
    null,
    "federated_rank_window",
  ]);
}

describe("a registered search tool emits full masked retrieval evidence", () => {
  test(
    "a real registered legacy search emits full masked retrieval evidence",
    legacyRegisteredSearchEmitsMaskedEvidence,
  );

  test(
    "the server search tree emits full masked retrieval evidence",
    serverSearchTreeEmitsMaskedEvidence,
  );

  test(
    "federated ranking distinguishes duplicate qmd paths by pre-sort index",
    federatedRankDistinguishesDuplicatePaths,
  );
});
