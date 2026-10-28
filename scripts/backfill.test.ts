import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type pg from "pg";
import type { generateEmbedding } from "../server/embedding/provider.ts";
import { addLogSink } from "../server/logging/legacy-logger.ts";
import { expectDefined } from "./test-support/expect-defined.ts";

// Info lines are observed through the logger's own sink. Pool and embedFn are
// injected directly into backfill(), so the logger is the only collaborator
// that needs observing at all.
//
// NOT `mock.module("../server/logging/legacy-logger.ts")`: that mock is
// process-wide and permanent in Bun -- keyed by resolved specifier, never
// scoped to one file, and not undone by `mock.restore()`. Stubbing the logger
// here replaced it for every later suite in the run, and
// `src/observability/observability.test.ts` asserts on lines the REAL logger
// emits. The stub silenced it, so all 20 of its tests failed with an empty
// capture buffer and a stack pointing nowhere near this file. The stub also
// predated `addLogSink`/`setLogContextReader`, so it no longer exported the
// module's full surface.
//
// `addLogSink` observes emitted lines without replacing anything, so it
// composes with other suites instead of overwriting them.
const logInfoCalls: Array<[string, Record<string, unknown>?]> = [];
let unsubscribeLogSink: (() => void) | undefined;

beforeEach(() => {
  logInfoCalls.length = 0;
  unsubscribeLogSink = addLogSink((entry) => {
    if (entry.level !== "info") return;
    const { level, message, timestamp, service, ...extra } = entry;
    void level;
    void timestamp;
    void service;
    logInfoCalls.push([message as string, extra]);
  });
});

afterEach(() => {
  unsubscribeLogSink?.();
  unsubscribeLogSink = undefined;
});

const { backfill } = await import("./backfill.ts");

type QueryImpl = (...args: unknown[]) => Promise<{ rows: unknown[] }>;
type MockCalls = ReadonlyArray<readonly unknown[]>;

// Mock pool factory -- no mock.module needed since pool is injected
function createMockPool(queryImpl: QueryImpl) {
  const mockEnd = vi.fn(async () => {});
  const mockQuery = vi.fn(queryImpl);
  return {
    pool: { query: mockQuery, end: mockEnd } as unknown as pg.Pool,
    mockEnd,
    mockQuery,
  };
}

// Mock embedFn factory -- no mock.module needed since embedFn is injected
function createMockEmbedFn(impl?: (text: string) => Promise<number[] | null>) {
  return vi.fn(
    impl ?? (async () => Array(768).fill(0.1)),
  ) as unknown as typeof generateEmbedding;
}

// Default query impl: return empty rows for everything
const defaultQueryImpl: QueryImpl = async () => ({
  rows: [] as Record<string, unknown>[],
});

/** A query impl that yields `rows` once for the first matching NULL-embedding select on `table`. */
function selectOnceFor(table: string, rows: unknown[]): QueryImpl {
  let selectDone = false;
  return (async (sql: string) => {
    if (sql.includes(table) && sql.includes("WHERE embedding IS NULL") && !selectDone) {
      selectDone = true;
      return { rows };
    }
    return { rows: [] };
  }) as QueryImpl;
}

function callsContaining(calls: MockCalls, needle: string): MockCalls {
  return calls.filter(
    (call) => typeof call[0] === "string" && call[0].includes(needle),
  );
}

function embeddedTexts(embedFn: typeof generateEmbedding): unknown[] {
  const calls = (embedFn as unknown as ReturnType<typeof vi.fn>).mock
    .calls as MockCalls;
  return calls.map((call) => call[0]);
}

/** Runs backfill over one seeded table and returns the texts handed to embedFn. */
async function textsEmbeddedForTable(
  table: string,
  rows: unknown[],
): Promise<unknown[]> {
  const { pool } = createMockPool(selectOnceFor(table, rows));
  const embedFn = createMockEmbedFn();
  await backfill(pool, embedFn);
  return embeddedTexts(embedFn);
}

async function assertQueriesEachTableForNullEmbeddings(): Promise<void> {
  const { pool, mockQuery } = createMockPool(defaultQueryImpl);
  const embedFn = createMockEmbedFn();

  await backfill(pool, embedFn);

  const selectCalls = callsContaining(
    mockQuery.mock.calls as MockCalls,
    "WHERE embedding IS NULL",
  );
  expect(selectCalls.length).toBe(5);

  const tables = ["thoughts", "decisions", "relationships", "projects", "sessions"];
  for (const table of tables) {
    const found = selectCalls.some(
      (call) => typeof call[0] === "string" && call[0].includes(table),
    );
    expect(found).toBe(true);
  }
}

async function assertUpdatesRowOnSuccess(): Promise<void> {
  const { pool, mockQuery } = createMockPool(
    selectOnceFor("thoughts", [{ id: "t1", content: "test" }]),
  );
  const embedFn = createMockEmbedFn();

  await backfill(pool, embedFn);

  const updateCalls = callsContaining(mockQuery.mock.calls as MockCalls, "UPDATE");
  expect(updateCalls.length).toBeGreaterThanOrEqual(1);

  const [updateSql, updateParams] = expectDefined(
    updateCalls[0],
    "first UPDATE call",
  ) as [string, unknown[]];
  expect(updateSql).toContain("embedding =");
  expect(updateSql).toContain("content_hash =");
  expect(updateSql).toContain("embedded_at =");
  expect(updateSql).toContain("embedding_model =");
  expect(updateParams).toBeTruthy();
  // The id should be in the params
  expect(updateParams).toContain("t1");
}

async function assertSkipsRowWhenEmbedFnReturnsNull(): Promise<void> {
  const { pool, mockQuery } = createMockPool(
    selectOnceFor("thoughts", [{ id: "t1", content: "fail-embed" }]),
  );
  const embedFn = createMockEmbedFn(async () => null);

  const result = await backfill(pool, embedFn);
  expect(result.failed).toBeGreaterThanOrEqual(1);

  // Should NOT have called UPDATE for this row
  const updateCalls = callsContaining(mockQuery.mock.calls as MockCalls, "UPDATE");
  expect(updateCalls.length).toBe(0);
}

async function assertLogsPerTableProgress(): Promise<void> {
  const { pool } = createMockPool(
    selectOnceFor("thoughts", [{ id: "t1", content: "test" }]),
  );
  const embedFn = createMockEmbedFn();

  await backfill(pool, embedFn);

  const tableLog = expectDefined(
    logInfoCalls.find(([msg]) => typeof msg === "string" && msg.includes("thoughts")),
    "per-table progress log line",
  );
  expect(tableLog[1]).toHaveProperty("nullCount");
}

async function assertLogsFinalSummary(): Promise<void> {
  const { pool } = createMockPool(defaultQueryImpl);
  const embedFn = createMockEmbedFn();

  await backfill(pool, embedFn);

  const summaryLog = expectDefined(
    logInfoCalls.find(
      ([msg]) =>
        typeof msg === "string" &&
        (msg.toLowerCase().includes("summary") ||
          msg.toLowerCase().includes("complete")),
    ),
    "final summary log line",
  );
  expect(summaryLog[1]).toHaveProperty("totalProcessed");
  expect(summaryLog[1]).toHaveProperty("totalFailed");
}

async function assertDoesNotEndInjectedPool(): Promise<void> {
  const { pool, mockEnd } = createMockPool(defaultQueryImpl);
  const embedFn = createMockEmbedFn();

  await backfill(pool, embedFn);

  expect(mockEnd).not.toHaveBeenCalled();
}

async function assertReEmbedsAllRows(): Promise<void> {
  const { pool, mockQuery } = createMockPool(defaultQueryImpl);
  const embedFn = createMockEmbedFn();

  await backfill(pool, embedFn, { all: true });

  const selectCalls = (mockQuery.mock.calls as MockCalls).filter(
    (call) => typeof call[0] === "string" && call[0].startsWith("SELECT id"),
  );

  expect(selectCalls.length).toBe(5);
  for (const [sql] of selectCalls as Array<readonly [string]>) {
    expect(sql).not.toContain("WHERE embedding IS NULL");
    // Projection, not SELECT * -- existing vectors stay out of JS memory
    expect(sql).not.toContain("SELECT *");
  }
}

describe("backfill", () => {
  it("Test 1: queries each of the 5 tables for WHERE embedding IS NULL", async () => {
    await assertQueriesEachTableForNullEmbeddings();
  });

  it("Test 2: for thoughts, embeds row.content", async () => {
    const texts = await textsEmbeddedForTable("thoughts", [
      { id: "t1", content: "my thought text" },
    ]);
    expect(texts).toContain("my thought text");
  });

  it("Test 3: for decisions, embeds title + newline + rationale", async () => {
    const texts = await textsEmbeddedForTable("decisions", [
      { id: "d1", title: "Use Bun", rationale: "It is fast" },
    ]);
    expect(texts).toContain("Use Bun\nIt is fast");
  });

  it("Test 4: for relationships, embeds person_name + context + notes filtered", async () => {
    const texts = await textsEmbeddedForTable("relationships", [
      { id: "r1", person_name: "Alice", context: "coworker", notes: null },
    ]);
    // null should be filtered out, so: "Alice\ncoworker"
    expect(texts).toContain("Alice\ncoworker");
  });

  it("Test 5: for projects, embeds name + description filtered", async () => {
    const texts = await textsEmbeddedForTable("projects", [
      { id: "p1", name: "OpenBrain", description: "AI memory" },
    ]);
    expect(texts).toContain("OpenBrain\nAI memory");
  });

  it("Test 6: for sessions, embeds row.summary", async () => {
    const texts = await textsEmbeddedForTable("sessions", [
      { id: "s1", summary: "session summary text" },
    ]);
    expect(texts).toContain("session summary text");
  });

  it("Test 7: updates row with embedding, content_hash, embedded_at, embedding_model on success", async () => {
    await assertUpdatesRowOnSuccess();
  });

  it("Test 8: skips row and increments failed count when embedFn returns null", async () => {
    await assertSkipsRowWhenEmbedFnReturnsNull();
  });

  it("Test 9: logs per-table progress with nullCount", async () => {
    await assertLogsPerTableProgress();
  });

  it("Test 10: logs final summary with totalProcessed and totalFailed", async () => {
    await assertLogsFinalSummary();
  });

  it("Test 11: does not end the injected pool (caller owns its lifecycle)", async () => {
    await assertDoesNotEndInjectedPool();
  });

  it("Test 12: can re-embed all rows with all=true", async () => {
    await assertReEmbedsAllRows();
  });
});
