// Shared fixture for the bulk-import suites.
//
// The suite was split in two (scripts/__tests__/bulk-import.test.ts and
// scripts/__tests__/bulk-import-routing.test.ts) so each file stays inside the
// repo's whole-file lint standard. Both need the same module mocks, the same
// mock pool, and the same log observation, so all of it lives here and is
// installed by `installBulkImportFixture()` at the top of each file.
import { mock } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type pg from "pg";
import { addLogSink } from "../../src/logger.ts";

export const logCalls: {
  info: Array<[string, Record<string, unknown>?]>;
  warn: Array<[string, Record<string, unknown>?]>;
  error: Array<[string, Record<string, unknown>?]>;
} = { info: [], warn: [], error: [] };

/**
 * Observes emitted log lines without replacing the logger.
 *
 * NOT `mock.module("../../src/logger.ts")`: that mock is process-wide and
 * permanent in Bun -- keyed by resolved specifier, never scoped to one file,
 * and not undone by `mock.restore()`. Replacing the logger here replaced it
 * for every later suite in the run, so any suite that observes real logger
 * output through `addLogSink` saw an empty buffer and failed with a stack
 * pointing nowhere near this file. `src/observability/observability.test.ts`
 * already states that no suite may mock.module the logger, and
 * `scripts/backfill.test.ts` is the precedent this follows.
 */
export function subscribeLogCalls(): () => void {
  return addLogSink((entry) => {
    const bucket = logCalls[entry.level as "info" | "warn" | "error"];
    if (!bucket) return;
    const { level, message, timestamp, service, ...extra } = entry;
    void level;
    void timestamp;
    void service;
    bucket.push([message as string, extra]);
  });
}

export function resetLogCalls(): void {
  logCalls.info.length = 0;
  logCalls.warn.length = 0;
  logCalls.error.length = 0;
}

/** Installs the module mocks both bulk-import suites depend on. */
export function installBulkImportMocks(): void {
  mock.module("../../src/embedding.ts", () => ({
    EMBEDDING_MODEL: "embeddinggemma-300m-8bit",
    contentHash: (text: string) => {
      // Deterministic hash for testing -- just use a simple string hash
      const { createHash } = require("node:crypto");
      const normalized = text.toLowerCase().trim().replace(/\s+/g, " ");
      return createHash("sha256").update(normalized).digest("hex");
    },
    generateEmbedding: mock(async () => null),
  }));

  // No mock needed for extraction.ts -- tests use extract:false (default).
  // Mocking it would leak into other test files via bun's global mock.module.

  mock.module("../../src/db/pool.ts", () => ({
    createPool: () => {
      throw new Error("createPool should not be called in tests");
    },
  }));

  mock.module("pgvector/pg", () => ({
    toSql: (arr: number[]) => `[${arr.join(",")}]`,
  }));
}

export function createMockPool(
  queryImpl?: (...args: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>,
) {
  const defaultImpl = async () => ({ rows: [], rowCount: 1 });
  const mockQuery = mock(queryImpl ?? defaultImpl);
  const mockEnd = mock(async () => {});
  return {
    pool: { query: mockQuery, end: mockEnd } as unknown as pg.Pool,
    mockQuery,
    mockEnd,
  };
}

export const defaultOpts = {
  extraTags: [] as string[],
  sourceLabel: "bulk-import",
  embed: false,
  extract: false,
};

export function makeFile(
  body: string,
  frontmatter: Record<string, unknown> = {},
  filePath = "/test/file.md",
): {
  filePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
} {
  return { filePath, frontmatter, body };
}

export async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ob-bulk-test-"));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
