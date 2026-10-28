import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Logger } from "pino";
import type { Pool } from "pg";
import type {
  SearchDependencies,
  SearchRow,
} from "../../server/tools/search-engine-types.ts";

const { hybridSearch, executeSearch } = vi.hoisted(() => ({
  hybridSearch: vi.fn(),
  executeSearch: vi.fn(),
}));

vi.mock("../../server/tools/search-engine.ts", () => ({
  hybridSearch,
  executeSearch,
}));

import { verifyLocalFusionMatchesEngine } from "./curation-fusion.ts";

const now = new Date().toISOString();

function row(
  id: string,
  lexicalCoverage?: number,
  queryLexemeCount?: number,
): SearchRow {
  return {
    id,
    source_type: "thought",
    namespace: "test",
    content_preview: id,
    tags: null,
    created_by: "test",
    created_at: now,
    tier: "warm",
    usefulness: 0.5,
    lexical_coverage: lexicalCoverage,
    query_lexeme_count: queryLexemeCount,
  };
}

const dependencies = {
  pool: {} as Pool,
  embedFn: async () => [1],
  logger: {} as Logger,
} satisfies SearchDependencies;

const fixture = {
  id: "partial-lexical-witness",
  query: "alpha beta",
  namespace: "test",
  expected: [],
  note: "hybrid lexical arm may match one query term",
};

const options = {
  sources: ["thoughts"] as const,
  limit: 10,
  maxAttempts: 1,
  retryDelayMs: 0,
};

describe("curation hybrid candidate reconstruction", () => {
  beforeEach(() => {
    hybridSearch.mockReset();
    executeSearch.mockReset();
  });

  test("accepts the engine fusion built from partial-coverage lexical candidates", async () => {
    const vectorRows = [row("vector-first"), row("vector-second")];
    const ftsRows = [row("partial-lexical", 1, 4)];
    hybridSearch.mockImplementation(
      async (_dependencies, _request, _embedding, observe) => {
        observe({ vectorRows, ftsRows });
        return [row("partial-lexical"), row("vector-first"), row("vector-second")];
      },
    );
    // These are the three calls the old reconstruction made. Its strict
    // keyword candidate differs from the engine's partial lexical candidate,
    // so that implementation throws local_fusion_diverged for this fixture.
    executeSearch
      .mockResolvedValueOnce(vectorRows)
      .mockResolvedValueOnce([row("strict-keyword")])
      .mockResolvedValueOnce([
        row("vector-first"),
        row("vector-second"),
        row("partial-lexical"),
      ]);

    await expect(
      verifyLocalFusionMatchesEngine(dependencies, fixture, options),
    ).resolves.toBeUndefined();
    expect(hybridSearch).toHaveBeenCalledOnce();
    expect(executeSearch).not.toHaveBeenCalled();
  });

  test("still rejects an engine order that disagrees with independent fusion", async () => {
    hybridSearch.mockImplementation(
      async (_dependencies, _request, _embedding, observe) => {
        observe({
          vectorRows: [row("vector-first"), row("vector-second")],
          ftsRows: [row("partial-lexical", 1, 4)],
        });
        // This preserves the old vector-first tie rather than applying stable
        // identity after the two unweighted rank-one votes tie exactly.
        return [row("vector-first"), row("partial-lexical"), row("vector-second")];
      },
    );

    await expect(
      verifyLocalFusionMatchesEngine(dependencies, fixture, options),
    ).rejects.toThrow(/local_fusion_diverged/);
  });
});
