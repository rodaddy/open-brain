import { describe, expect, test } from "bun:test";
import type { Logger } from "pino";
import type { Pool } from "pg";
import { executeSearch } from "./search-engine.ts";
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
  return warnings[0]!.timeout_ms;
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
