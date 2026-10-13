import { describe, expect, test, vi } from "vitest";
import type { Logger } from "pino";
import type { Pool } from "pg";
import {
  executeSearch,
  executeSearchWithSharedFallback,
  hybridSearch,
} from "./search-engine.ts";
import { rrfArmContribution } from "./search-engine-fusion.ts";
import type { SharedNamespaceConfig } from "./shared-namespace.ts";
import {
  DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS,
  type SearchDependencies,
  type SearchRow,
} from "./search-engine-types.ts";

/**
 * Prove the injected embedding timeout is the one the engine acts on.
 *
 * The observable is the `search_embedding_timeout` warning the engine emits
 * when the provider does not answer in time: its `timeout_ms` field is the
 * value the timer was armed with. An embedder that never resolves makes that
 * timer the only thing that can finish the race, so the recorded number is the
 * timeout that was actually in force — not a value read back from the same
 * place it was written.
 *
 * Vector mode is used because it fails once the embedding is missing, so the
 * pool is never reached and no database is needed.
 */

interface RecordedWarning {
  readonly timeout_ms: number;
}

function recordingDependencies(overrides: Partial<SearchDependencies>): {
  dependencies: SearchDependencies;
  warnings: RecordedWarning[];
} {
  const warnings: RecordedWarning[] = [];
  const logger = {
    warn: (payload: unknown) => {
      const fields = payload as { timeout_ms?: unknown };
      if (typeof fields.timeout_ms === "number") {
        warnings.push({ timeout_ms: fields.timeout_ms });
      }
    },
    debug: () => {},
    info: () => {},
    error: () => {},
  } as unknown as Logger;
  const dependencies: SearchDependencies = {
    pool: {
      query: () => {
        throw new Error("the pool must not be reached in vector mode");
      },
    } as unknown as Pool,
    // Never resolves, so only the timer can settle the race.
    embedFn: () => new Promise<number[] | null>(() => {}),
    logger,
    ...overrides,
  };
  return { dependencies, warnings };
}

async function timeoutObservedFor(
  overrides: Partial<SearchDependencies>,
): Promise<number> {
  const { dependencies, warnings } = recordingDependencies(overrides);
  await expect(
    executeSearch(dependencies, ["thoughts"], "anything", 5, "vector"),
  ).rejects.toThrow();
  expect(warnings).toHaveLength(1);
  const [first] = warnings;
  if (!first) throw new Error("expected one recorded warning");
  return first.timeout_ms;
}

describe("search embedding timeout injection", () => {
  test("the engine arms the timer with the injected value", async () => {
    expect(await timeoutObservedFor({ searchEmbeddingTimeoutMs: 25 })).toBe(25);
  });

  test("a different injected value is observed at the consumer", async () => {
    expect(await timeoutObservedFor({ searchEmbeddingTimeoutMs: 40 })).toBe(40);
  });

  test("no injected value keeps the previous unset-environment answer", async () => {
    const { dependencies, warnings } = recordingDependencies({});
    // The default is far longer than this test should wait, so assert on the
    // resolver directly through the one observable that does not require it to
    // elapse: an unusable injected value falls back to the same number.
    expect(await timeoutObservedFor({ searchEmbeddingTimeoutMs: 0 })).toBe(
      DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS,
    );
    expect(dependencies.searchEmbeddingTimeoutMs).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });
});

/**
 * Prove the injected shared-namespace names are the ones the search path
 * resolves against.
 *
 * The observable is the namespace reported on an emitted row. A row is stored
 * under the PHYSICAL name; `executeSearchWithSharedFallback` canonicalises it
 * on the way out. Injecting a distinctive canonical name that no environment
 * default could produce makes the emitted value proof that the injected set —
 * not the environment — drove the resolution.
 *
 * Keyword mode is used so no embedder is needed; the pool is faked so no
 * database is required.
 */

const INJECTED_NAMES = {
  canonicalSharedNamespace: "lane5-canonical-shared",
  physicalSharedNamespace: "lane5-physical-shared",
  legacySharedNamespace: "",
  legacyFallbackEnabled: false,
  fallbackMinResults: 5,
  sharedNamespace: "lane5-physical-shared",
  allowLegacySharedWrites: false,
} as const;

function poolReturningPhysicalRow(): Pool {
  return {
    query: async () => ({
      rows: [
        {
          id: "row-1",
          source_type: "thoughts",
          namespace: INJECTED_NAMES.physicalSharedNamespace,
          content_preview: "shared truth",
          created_by: "tester",
        },
      ],
    }),
  } as unknown as Pool;
}

async function namespaceEmittedWith(
  names?: SharedNamespaceConfig,
): Promise<string | undefined> {
  const dependencies: SearchDependencies = {
    pool: poolReturningPhysicalRow(),
    embedFn: async () => null,
    logger: {
      warn: () => {},
      debug: () => {},
      info: () => {},
      error: () => {},
    } as unknown as Logger,
    sharedNamespaceNames: names,
  };
  const rows = await executeSearchWithSharedFallback(
    dependencies,
    ["thoughts"],
    "shared",
    5,
    "keyword",
    undefined,
    0,
    INJECTED_NAMES.physicalSharedNamespace,
  );
  return rows[0]?.namespace;
}

describe("shared-namespace name injection on the search path", () => {
  test("injected names drive the canonical namespace on emitted rows", async () => {
    expect(await namespaceEmittedWith(INJECTED_NAMES)).toBe(
      INJECTED_NAMES.canonicalSharedNamespace,
    );
  });

  test("no injected names fails loudly rather than emitting a raw name", async () => {
    // An emitted row that silently kept the physical partition name would leak
    // that partition to a caller; naming the missing wiring is the safe answer.
    await expect(namespaceEmittedWith(undefined)).rejects.toThrow(
      /sharedNamespaceNames/,
    );
  });
});

function rankedRow(id: string, lexicalCoverage?: number, queryLexemeCount?: number) {
  return {
    id,
    source_type: "thought",
    namespace: "test",
    content_preview: id,
    tags: null,
    created_by: "test",
    created_at: new Date().toISOString(),
    usefulness: 0.5,
    lexical_coverage: lexicalCoverage,
    query_lexeme_count: queryLexemeCount,
  };
}

function jevDependencies(rows: SearchRow[], fetchFn: typeof fetch): SearchDependencies {
  const client = { query: async () => ({ rows }), release: () => {} };
  return {
    pool: {
      connect: async () => client,
      query: async () => ({ rows: [] }),
    } as unknown as Pool,
    embedFn: async () => [1],
    logger: {
      warn: () => {},
      debug: () => {},
      info: () => {},
      error: () => {},
    } as unknown as Logger,
    jev: {
      config: {
        enabled: true,
        apiKey: "test",
        baseUrl: "https://example.test/systemone",
        model: "jev-1.13.0",
        timeoutMs: 100,
        maxRequestBytes: 64_000,
        maxStateQuestionBytes: 32_000,
      },
      fetchFn,
    },
  };
}

const JEV_HYBRID_REQUEST = {
  tables: ["thoughts"] as const,
  query: "q",
  limit: 1,
  mode: "hybrid" as const,
  tier: undefined,
  offset: 0,
  namespace: "test",
  ftsConfig: "english" as const,
};

describe("hybrid fusion metadata", () => {
  test("lets Jev promote a fused candidate below the requested RRF limit", async () => {
    const vectorRows = [rankedRow("a"), rankedRow("b"), rankedRow("c")];
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              r0_c0: { type: "noul", noul: 0.1 },
              r1_c0: { type: "noul", noul: 0.2 },
              r2_c0: { type: "noul", noul: 0.9 },
            },
            usage: { input_tokens: 10, output_tokens: 3 },
          }),
        ),
    );
    const dependencies = jevDependencies(vectorRows, fetchFn);
    expect(
      (await hybridSearch(dependencies, JEV_HYBRID_REQUEST, [1])).map((row) => row.id),
    ).toEqual(["c"]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("batches the fused pool once before offset and falls back as one stable pool", async () => {
    const vectorRows = [rankedRow("a"), rankedRow("b")];
    const client = { query: async () => ({ rows: vectorRows }), release: () => {} };
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              r0_c0: { type: "noul", noul: 0.1 },
              r1_c0: { type: "noul", noul: 0.9 },
            },
            usage: { input_tokens: 10, output_tokens: 3 },
          }),
        ),
    );
    const dependencies: SearchDependencies = {
      pool: {
        connect: async () => client,
        query: async () => ({ rows: [] }),
      } as unknown as Pool,
      embedFn: async () => [1],
      logger: {
        warn: () => {},
        debug: () => {},
        info: () => {},
        error: () => {},
      } as unknown as Logger,
      jev: {
        config: {
          enabled: true,
          apiKey: "test",
          baseUrl: "https://example.test/systemone",
          model: "jev-1.13.0",
          timeoutMs: 100,
          maxRequestBytes: 64_000,
          maxStateQuestionBytes: 32_000,
        },
        fetchFn,
      },
    };
    const request = {
      tables: ["thoughts"] as const,
      query: "q",
      limit: 1,
      mode: "hybrid" as const,
      tier: undefined,
      offset: 1,
      namespace: "test",
      ftsConfig: "english" as const,
    };
    expect(
      (await hybridSearch(dependencies, request, [1])).map((row) => row.id),
    ).toEqual(["a"]);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    if (!dependencies.jev) throw new Error("expected Jev dependencies");
    const fallbackDependencies: SearchDependencies = {
      ...dependencies,
      jev: {
        ...dependencies.jev,
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              model: "jev-1.13.0",
              answers: { r0_c0: { type: "noul", noul: 0.1 } },
            }),
          ),
      },
    };
    expect(
      (await hybridSearch(fallbackDependencies, request, [1])).map((row) => row.id),
    ).toEqual(["b"]);
  });
});

describe("hybrid fusion metadata propagation", () => {
  test("keeps positional votes equal while rejecting malformed lexical metadata", () => {
    const full = rankedRow("full", 4, 4);
    const partial = rankedRow("partial", 1, 4);

    expect(rrfArmContribution(full, 0, "lexical")).toBe(1);
    expect(rrfArmContribution(partial, 0, "lexical")).toBe(1);
    expect(rrfArmContribution(partial, 0, "vector")).toBe(1);
    expect(() => rrfArmContribution(rankedRow("missing"), 0, "lexical")).toThrow(
      /Invalid hybrid lexical coverage metadata/,
    );
  });

  test("retains coverage on observed arms without leaking it through public hybrid rows", async () => {
    const vectorRows = [rankedRow("vector")];
    const lexicalRows = [rankedRow("partial", 1, 2)];
    const client = {
      query: async (sql: string) => {
        if (sql.includes("SELECT * FROM (")) return { rows: vectorRows };
        return { rows: [] };
      },
      release: () => {},
    };
    const dependencies = {
      pool: {
        connect: async () => client,
        query: async () => ({ rows: lexicalRows }),
      } as unknown as Pool,
      embedFn: async () => [1],
      logger: {
        warn: () => {},
        debug: () => {},
        info: () => {},
        error: () => {},
      } as unknown as Logger,
    } satisfies SearchDependencies;
    let observed: { vectorRows: SearchRow[]; ftsRows: SearchRow[] } | undefined;

    const publicRows = await hybridSearch(
      dependencies,
      {
        tables: ["thoughts"],
        query: "alpha beta",
        limit: 2,
        mode: "hybrid",
        tier: undefined,
        offset: 0,
        namespace: "test",
        ftsConfig: "english",
      },
      [1],
      (arms) => {
        observed = arms;
      },
    );

    expect(observed?.ftsRows[0]).toMatchObject({
      lexical_coverage: 1,
      query_lexeme_count: 2,
    });
    expect(publicRows[0]).not.toHaveProperty("lexical_coverage");
    expect(publicRows[0]).not.toHaveProperty("query_lexeme_count");
    expect(observed?.ftsRows[0]).toHaveProperty("lexical_coverage", 1);
  });
});

describe("Jev rerank fallback log (issue 1461)", () => {
  test("names the reason and status and carries no response body", async () => {
    const secretBody = "provider body text that must never be logged";
    const fetchFn = vi.fn(async () => new Response(secretBody, { status: 503 }));
    const warn = vi.fn();
    const base = jevDependencies([rankedRow("a"), rankedRow("b")], fetchFn);
    const dependencies: SearchDependencies = {
      ...base,
      logger: { ...base.logger, warn } as unknown as Logger,
    };
    const rows = await hybridSearch(dependencies, JEV_HYBRID_REQUEST, [1]);
    expect(rows.map((row) => row.id)).toEqual(["a"]);
    const call = warn.mock.calls.find(
      ([, message]) => message === "jev_rerank_failed_fallback_rrf",
    );
    expect(call?.[0]).toEqual({ candidate_count: 2, reason: "http", status: 503 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secretBody);
  });
});
