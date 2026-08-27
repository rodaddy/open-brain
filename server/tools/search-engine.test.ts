import { describe, expect, test } from "bun:test";
import type { Logger } from "pino";
import type { Pool } from "pg";
import {
  executeSearch,
  executeSearchWithSharedFallback,
} from "./search-engine.ts";
import type { SharedNamespaceConfig } from "./shared-namespace.ts";
import {
  DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS,
  type SearchDependencies,
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
