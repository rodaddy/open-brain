/**
 * Database ownership boundary tests.
 * Design authority: `docs/code-brain-design.md` section 2 requires explicit
 * runtime health evidence rather than inferring success from silence.
 */
import { describe, expect, it } from "bun:test";
import pino from "pino";
import { createDatabase, ownDatabasePool, type DatabasePool } from "./pool.ts";
import { selectById } from "./query.ts";

class FakePool implements DatabasePool {
  readonly totalCount = 3;
  readonly idleCount = 2;
  readonly waitingCount = 1;
  closed = false;

  constructor(private readonly queryError?: Error) {}

  async query(_text: string): Promise<unknown> {
    if (this.queryError) throw this.queryError;
    return { rows: [{ healthy: true }] };
  }

  async end(): Promise<void> {
    this.closed = true;
  }

  on(_event: "error", _listener: (error: Error) => void): this {
    return this;
  }
}

const logger = pino({ level: "silent" });
const OWNED_POOL_IS_QUERYABLE: ReturnType<typeof createDatabase>["pool"] extends Parameters<typeof selectById>[0]
  ? true
  : false = true;

describe("database pool ownership", () => {
  it("exposes the created pool to the parameterized query boundary", () => {
    expect(OWNED_POOL_IS_QUERYABLE).toBe(true);
  });

  it("reports observed pool health and closes the owned pool", async () => {
    const pool = new FakePool();
    const database = ownDatabasePool(pool, logger);
    expect(await database.health()).toEqual({
      connected: true,
      total: 3,
      idle: 2,
      waiting: 1,
    });
    await database.close();
    expect(pool.closed).toBe(true);
  });

  it("returns a stable failure category without inventing zero counts", async () => {
    const database = ownDatabasePool(new FakePool(new TypeError("unavailable")), logger);
    expect(await database.health()).toEqual({
      connected: false,
      total: 3,
      idle: 2,
      waiting: 1,
      errorCategory: "TypeError",
    });
  });
});
