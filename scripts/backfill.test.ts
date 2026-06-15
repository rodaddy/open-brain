import { describe, it, expect, mock, beforeEach } from "bun:test";
import type pg from "pg";
import type { generateEmbedding } from "../src/embedding.ts";

// Only mock the logger -- pool and embedFn are injected directly into backfill()
const logInfoCalls: Array<[string, Record<string, unknown>?]> = [];
mock.module("../src/logger.ts", () => ({
  logger: {
    info: (msg: string, extra?: Record<string, unknown>) => {
      logInfoCalls.push([msg, extra]);
    },
    warn: () => {},
    error: () => {},
    debug: mock(() => {}),
  },
}));

// Import after logger mock is set up
const { backfill } = await import("./backfill.ts");

// Mock pool factory -- no mock.module needed since pool is injected
function createMockPool(
  queryImpl: (...args: any[]) => Promise<{ rows: any[] }>,
) {
  const mockEnd = mock(async () => {});
  return {
    pool: { query: mock(queryImpl), end: mockEnd } as unknown as pg.Pool,
    mockEnd,
    get mockQuery() {
      return this.pool.query as ReturnType<typeof mock>;
    },
  };
}

// Mock embedFn factory -- no mock.module needed since embedFn is injected
function createMockEmbedFn(impl?: (text: string) => Promise<number[] | null>) {
  return mock(
    impl ?? (async () => Array(768).fill(0.1)),
  ) as unknown as typeof generateEmbedding;
}

// Default query impl: return empty rows for everything
const defaultQueryImpl = async () => ({
  rows: [] as Record<string, unknown>[],
});

beforeEach(() => {
  logInfoCalls.length = 0;
});

describe("backfill", () => {
  it("Test 1: queries each of the 5 tables for WHERE embedding IS NULL", async () => {
    const { pool, mockQuery } = createMockPool(defaultQueryImpl);
    const embedFn = createMockEmbedFn();

    await backfill(pool, embedFn);

    const selectCalls = mockQuery.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === "string" &&
        call[0].includes("WHERE embedding IS NULL"),
    );
    expect(selectCalls.length).toBe(5);

    const tables = [
      "thoughts",
      "decisions",
      "relationships",
      "projects",
      "sessions",
    ];
    for (const table of tables) {
      const found = selectCalls.some(
        (call: any[]) => typeof call[0] === "string" && call[0].includes(table),
      );
      expect(found).toBe(true);
    }
  });

  it("Test 2: for thoughts, embeds row.content", async () => {
    let selectDone = false;
    const { pool } = createMockPool(async (sql: string) => {
      if (
        sql.includes("thoughts") &&
        sql.includes("WHERE embedding IS NULL") &&
        !selectDone
      ) {
        selectDone = true;
        return { rows: [{ id: "t1", content: "my thought text" }] };
      }
      return { rows: [] };
    });
    const embedFn = createMockEmbedFn();

    await backfill(pool, embedFn);

    const embedCalls = (embedFn as ReturnType<typeof mock>).mock.calls;
    const thoughtEmbed = embedCalls.find(
      (c: any[]) => c[0] === "my thought text",
    );
    expect(thoughtEmbed).toBeTruthy();
  });

  it("Test 3: for decisions, embeds title + newline + rationale", async () => {
    let selectDone = false;
    const { pool } = createMockPool(async (sql: string) => {
      if (
        sql.includes("decisions") &&
        sql.includes("WHERE embedding IS NULL") &&
        !selectDone
      ) {
        selectDone = true;
        return {
          rows: [{ id: "d1", title: "Use Bun", rationale: "It is fast" }],
        };
      }
      return { rows: [] };
    });
    const embedFn = createMockEmbedFn();

    await backfill(pool, embedFn);

    const embedCalls = (embedFn as ReturnType<typeof mock>).mock.calls;
    const decisionEmbed = embedCalls.find(
      (c: any[]) => c[0] === "Use Bun\nIt is fast",
    );
    expect(decisionEmbed).toBeTruthy();
  });

  it("Test 4: for relationships, embeds person_name + context + notes filtered", async () => {
    let selectDone = false;
    const { pool } = createMockPool(async (sql: string) => {
      if (
        sql.includes("relationships") &&
        sql.includes("WHERE embedding IS NULL") &&
        !selectDone
      ) {
        selectDone = true;
        return {
          rows: [
            {
              id: "r1",
              person_name: "Alice",
              context: "coworker",
              notes: null,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const embedFn = createMockEmbedFn();

    await backfill(pool, embedFn);

    const embedCalls = (embedFn as ReturnType<typeof mock>).mock.calls;
    // null should be filtered out, so: "Alice\ncoworker"
    const relEmbed = embedCalls.find((c: any[]) => c[0] === "Alice\ncoworker");
    expect(relEmbed).toBeTruthy();
  });

  it("Test 5: for projects, embeds name + description filtered", async () => {
    let selectDone = false;
    const { pool } = createMockPool(async (sql: string) => {
      if (
        sql.includes("projects") &&
        sql.includes("WHERE embedding IS NULL") &&
        !selectDone
      ) {
        selectDone = true;
        return {
          rows: [{ id: "p1", name: "OpenBrain", description: "AI memory" }],
        };
      }
      return { rows: [] };
    });
    const embedFn = createMockEmbedFn();

    await backfill(pool, embedFn);

    const embedCalls = (embedFn as ReturnType<typeof mock>).mock.calls;
    const projEmbed = embedCalls.find(
      (c: any[]) => c[0] === "OpenBrain\nAI memory",
    );
    expect(projEmbed).toBeTruthy();
  });

  it("Test 6: for sessions, embeds row.summary", async () => {
    let selectDone = false;
    const { pool } = createMockPool(async (sql: string) => {
      if (
        sql.includes("sessions") &&
        sql.includes("WHERE embedding IS NULL") &&
        !selectDone
      ) {
        selectDone = true;
        return { rows: [{ id: "s1", summary: "session summary text" }] };
      }
      return { rows: [] };
    });
    const embedFn = createMockEmbedFn();

    await backfill(pool, embedFn);

    const embedCalls = (embedFn as ReturnType<typeof mock>).mock.calls;
    const sessEmbed = embedCalls.find(
      (c: any[]) => c[0] === "session summary text",
    );
    expect(sessEmbed).toBeTruthy();
  });

  it("Test 7: updates row with embedding, content_hash, embedded_at, embedding_model on success", async () => {
    let selectDone = false;
    const { pool, mockQuery } = createMockPool(async (sql: string) => {
      if (
        sql.includes("thoughts") &&
        sql.includes("WHERE embedding IS NULL") &&
        !selectDone
      ) {
        selectDone = true;
        return { rows: [{ id: "t1", content: "test" }] };
      }
      return { rows: [] };
    });
    const embedFn = createMockEmbedFn();

    await backfill(pool, embedFn);

    const updateCalls = mockQuery.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === "string" && call[0].includes("UPDATE"),
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);

    const [updateSql, updateParams] = updateCalls[0] as [string, unknown[]];
    expect(updateSql).toContain("embedding =");
    expect(updateSql).toContain("content_hash =");
    expect(updateSql).toContain("embedded_at =");
    expect(updateSql).toContain("embedding_model =");
    expect(updateParams).toBeTruthy();
    // The id should be in the params
    expect(updateParams).toContain("t1");
  });

  it("Test 8: skips row and increments failed count when embedFn returns null", async () => {
    let selectDone = false;
    const { pool, mockQuery } = createMockPool(async (sql: string) => {
      if (
        sql.includes("thoughts") &&
        sql.includes("WHERE embedding IS NULL") &&
        !selectDone
      ) {
        selectDone = true;
        return { rows: [{ id: "t1", content: "fail-embed" }] };
      }
      return { rows: [] };
    });
    const embedFn = createMockEmbedFn(async () => null);

    const result = await backfill(pool, embedFn);
    expect(result.failed).toBeGreaterThanOrEqual(1);

    // Should NOT have called UPDATE for this row
    const updateCalls = mockQuery.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === "string" && call[0].includes("UPDATE"),
    );
    expect(updateCalls.length).toBe(0);
  });

  it("Test 9: logs per-table progress with nullCount", async () => {
    let thoughtsDone = false;
    const { pool } = createMockPool(async (sql: string) => {
      if (
        sql.includes("thoughts") &&
        sql.includes("WHERE embedding IS NULL") &&
        !thoughtsDone
      ) {
        thoughtsDone = true;
        return { rows: [{ id: "t1", content: "test" }] };
      }
      return { rows: [] };
    });
    const embedFn = createMockEmbedFn();

    await backfill(pool, embedFn);

    const tableLog = logInfoCalls.find(
      ([msg]) => typeof msg === "string" && msg.includes("thoughts"),
    );
    expect(tableLog).toBeTruthy();
    expect(tableLog![1]).toHaveProperty("nullCount");
  });

  it("Test 10: logs final summary with totalProcessed and totalFailed", async () => {
    const { pool } = createMockPool(defaultQueryImpl);
    const embedFn = createMockEmbedFn();

    await backfill(pool, embedFn);

    const summaryLog = logInfoCalls.find(
      ([msg]) =>
        typeof msg === "string" &&
        (msg.toLowerCase().includes("summary") ||
          msg.toLowerCase().includes("complete")),
    );
    expect(summaryLog).toBeTruthy();
    expect(summaryLog![1]).toHaveProperty("totalProcessed");
    expect(summaryLog![1]).toHaveProperty("totalFailed");
  });

  it("Test 11: does not end the injected pool (caller owns its lifecycle)", async () => {
    const { pool, mockEnd } = createMockPool(defaultQueryImpl);
    const embedFn = createMockEmbedFn();

    await backfill(pool, embedFn);

    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("Test 12: can re-embed all rows with all=true", async () => {
    const { pool, mockQuery } = createMockPool(defaultQueryImpl);
    const embedFn = createMockEmbedFn();

    await backfill(pool, embedFn, { all: true });

    const selectCalls = mockQuery.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === "string" && call[0].startsWith("SELECT id"),
    );

    expect(selectCalls.length).toBe(5);
    for (const [sql] of selectCalls as Array<[string]>) {
      expect(sql).not.toContain("WHERE embedding IS NULL");
      // Projection, not SELECT * -- existing vectors stay out of JS memory
      expect(sql).not.toContain("SELECT *");
    }
  });
});
