/**
 * Real-PostgreSQL proof that `createPool` finishes pgvector type registration
 * before a new client runs the caller's first query (issue 1502).
 *
 * The registration used to run from an un-awaited `connect` listener, so its
 * type-lookup query was still executing when the caller's query was issued on
 * the same client, and pg printed "Calling client.query() when the client is
 * already executing a query". That warning goes through `util.deprecate`, which
 * fires once per process, so it cannot be the assertion here. Instead the suite
 * counts in-flight queries per client through a wrapper on `Client.query` and
 * records every query that starts while another is still running.
 *
 * Runs against a real database and fails hard without one -- no
 * `describe.skip` (operator ruling 2026-08-27, issue #878).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { createPool, type PoolSettings } from "./legacy-pool.ts";

const DATABASE_URL = requireTestDatabaseUrl();

function settingsFrom(url: string, max: number): PoolSettings {
  const parsed = new URL(url);
  return {
    host: decodeURIComponent(parsed.hostname),
    port: Number.parseInt(parsed.port || "5432", 10),
    database: decodeURIComponent(parsed.pathname.slice(1)),
    user: decodeURIComponent(parsed.username),
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    max,
  };
}

function queryText(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg !== null && typeof arg === "object" && "text" in arg) {
    return String((arg as { text: unknown }).text);
  }
  return String(arg);
}

/**
 * Runs `fn` against a database created from template0, which has no vector
 * extension -- the state the migration runner connects to before its first
 * migration (issue 1515) -- and drops it afterwards.
 */
async function withBareDatabase(fn: (url: string) => Promise<void>): Promise<void> {
  const bare = `ob_1515_bare_${process.pid}`;
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${bare} TEMPLATE template0 ENCODING 'UTF8'`);
    const url = new URL(DATABASE_URL);
    url.pathname = `/${bare}`;
    await fn(url.toString());
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${bare} WITH (FORCE)`);
    await admin.end();
  }
}

type QueryFn = (this: pg.Client, ...args: unknown[]) => unknown;

describe("createPool pgvector registration ordering (live Postgres)", () => {
  // Read through Reflect: the method is only ever re-invoked with `.apply`
  // and a real client as `this`.
  const originalQuery = Reflect.get(pg.Client.prototype, "query") as QueryFn;
  const inFlight = new WeakMap<object, number>();
  const started: string[] = [];
  const overlaps: string[] = [];

  beforeAll(() => {
    const wrapped: QueryFn = function (this: pg.Client, ...args: unknown[]) {
      const text = queryText(args[0]);
      const running = inFlight.get(this) ?? 0;
      if (running > 0) overlaps.push(text);
      started.push(text);
      inFlight.set(this, running + 1);
      const done = (): void => {
        inFlight.set(this, (inFlight.get(this) ?? 1) - 1);
      };
      const last = args.length - 1;
      const callback = args[last];
      if (typeof callback === "function") {
        args[last] = (...cbArgs: unknown[]) => {
          done();
          return (callback as (...a: unknown[]) => unknown)(...cbArgs);
        };
        return originalQuery.apply(this, args);
      }
      const result = originalQuery.apply(this, args);
      if (result instanceof Promise) {
        result.then(done, done);
      } else {
        done();
      }
      return result;
    };
    pg.Client.prototype.query = wrapped as unknown as typeof pg.Client.prototype.query;
  });

  afterAll(() => {
    pg.Client.prototype.query =
      originalQuery as unknown as typeof pg.Client.prototype.query;
  });

  it("runs no caller query on a new client while registration is in flight", async () => {
    started.length = 0;
    overlaps.length = 0;
    const pool = createPool(settingsFrom(DATABASE_URL, 2));
    try {
      await Promise.all([pool.query("SELECT 1"), pool.query("SELECT 1")]);
    } finally {
      await pool.end();
    }

    // The probe must have seen the registration query, or zero overlaps
    // would prove nothing about the ordering.
    expect(started.filter((text) => text !== "SELECT 1").length).toBeGreaterThan(0);
    expect(overlaps).toEqual([]);
  });

  it("parses a vector column as a number array on a new client's first query", async () => {
    const pool = createPool(settingsFrom(DATABASE_URL, 1));
    try {
      const { rows } = await pool.query<{ v: unknown }>(
        "SELECT '[1,2,3]'::vector AS v",
      );
      expect(rows[0]?.v).toEqual([1, 2, 3]);
    } finally {
      await pool.end();
    }
  });

  it("skips registration with registerVectorTypes: false on a database without the extension", async () => {
    await withBareDatabase(async (bareUrl) => {
      started.length = 0;
      const pool = createPool(settingsFrom(bareUrl, 1), undefined, {
        registerVectorTypes: false,
      });
      try {
        const { rows } = await pool.query<{ ok: number }>("SELECT 1 AS ok");
        expect(rows[0]?.ok).toBe(1);
      } finally {
        await pool.end();
      }
      expect(started).toEqual(["SELECT 1 AS ok"]);
    });
  });

  it("registers the parser on every client of a concurrent burst", async () => {
    const pool = createPool(settingsFrom(DATABASE_URL, 3));
    try {
      const results = await Promise.all(
        [1, 2, 3].map((n) =>
          pool.query<{ v: unknown }>(`SELECT '[${n},${n},${n}]'::vector AS v`),
        ),
      );
      expect(results.map((r) => r.rows[0]?.v)).toEqual([
        [1, 1, 1],
        [2, 2, 2],
        [3, 3, 3],
      ]);
      expect(pool.totalCount).toBe(3);
    } finally {
      await pool.end();
    }
  });
});
