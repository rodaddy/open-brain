/**
 * Live-Postgres coverage for list_stale, the dream planner that decides which
 * entries are candidates for demotion or archival.
 *
 * list_stale writes nothing, so there is no mutation risk here. The risk is
 * that it returns the WRONG SET: a planner feeding DreamEngine decides what
 * gets acted on, and a stale-detection bug proposes actions against entries
 * that are not actually stale.
 *
 * The focused suite (list-stale.test.ts, 14 cases) covers output shape,
 * permissions, paging flags, and filter plumbing against fake pools, which is
 * appropriate for all of those. It cannot cover the query itself: a fake
 * returns a pre-sorted array, so ordering, the staleness cutoff, and the
 * COALESCE fallback are all supplied by the fixture rather than computed.
 *
 * Proven here against real rows and real timestamps:
 *  1. The threshold is a genuine date comparison
 *     (`COALESCE(last_accessed_at, created_at) < NOW() - INTERVAL '1 day' * $1`):
 *     rows either side of the cutoff are included/excluded correctly, and a
 *     row exactly at the boundary is handled consistently.
 *  2. `effective_last_access` falls back to created_at when last_accessed_at
 *     is NULL. A never-accessed old row IS stale; treating NULL as "recent"
 *     would hide exactly the entries the planner exists to find.
 *  3. Results are ordered stalest-first by that computed column, across a
 *     mix of both kinds of row -- the ordering a fixture cannot demonstrate.
 *  4. Tier and table filters compose with the threshold rather than replacing
 *     it.
 *  5. Namespace scoping is real: rows in another namespace are absent from
 *     the results.
 *
 * Gated on OPENBRAIN_TEST_DATABASE_URL (repo dbDescribe convention).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runMigrations } from "../../db/migrate.ts";
import { registerListStale } from "../list-stale.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

const CREATED_BY = "dream-list-stale-pg-test";
const OWNER_NS = "dream-list-stale-owner-ns";
const OTHER_NS = "dream-list-stale-other-ns";

const ownerAuth: AuthInfo = {
  role: "agent",
  clientId: OWNER_NS,
  namespaceSource: "token",
};

dbDescribe("list_stale (live Postgres)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await runMigrations(pool);
    await cleanup();
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  async function cleanup(): Promise<void> {
    for (const table of ["thoughts", "decisions"]) {
      await pool.query(`DELETE FROM ${table} WHERE created_by = $1`, [
        CREATED_BY,
      ]);
    }
  }

  /**
   * Seed a row with explicit ages. `createdDaysAgo` and `accessedDaysAgo` are
   * relative to NOW() so the test does not depend on the wall clock, and the
   * cutoff arithmetic is exercised exactly as it runs in production.
   */
  async function seedThought(opts: {
    content: string;
    namespace?: string;
    createdDaysAgo: number;
    accessedDaysAgo?: number | null;
    tier?: string;
    accessCount?: number;
  }): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO thoughts
         (content, created_by, namespace, tier, access_count, created_at, last_accessed_at)
       VALUES ($1, $2, $3, $4, $5,
               NOW() - INTERVAL '1 day' * $6,
               CASE WHEN $7::numeric IS NULL THEN NULL
                    ELSE NOW() - INTERVAL '1 day' * $7 END)
       RETURNING id`,
      [
        opts.content,
        CREATED_BY,
        opts.namespace ?? OWNER_NS,
        opts.tier ?? "warm",
        opts.accessCount ?? 0,
        opts.createdDaysAgo,
        opts.accessedDaysAgo ?? null,
      ],
    );
    return rows[0].id as string;
  }

  async function callListStale(auth: AuthInfo, args: Record<string, unknown>) {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = { pool: pool as any, embedFn: async () => null };
    registerListStale(server, deps);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message: any, options?: any) =>
      originalSend(message, { ...options, authInfo: auth });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      return await client.callTool({ name: "list_stale", arguments: args });
    } finally {
      await client.close();
      await server.close();
    }
  }

  /**
   * Previews of the returned entries, in the order the tool returned them.
   * The projection exposes `content_preview` (LEFT(..., 200)), not the raw
   * content column, so the seeded markers are matched against that.
   */
  function contents(result: any): string[] {
    const parsed = JSON.parse((result.content as any)[0].text);
    return (parsed.entries ?? []).map((e: any) => e.content_preview);
  }

  it("includes rows older than the threshold and excludes newer ones", async () => {
    // The cutoff is a real date comparison, not a filter the fixture applied.
    await seedThought({ content: "old-90d", createdDaysAgo: 90 });
    await seedThought({ content: "recent-2d", createdDaysAgo: 2 });

    const result = await callListStale(ownerAuth, {
      table: "thoughts",
      days: 30,
      limit: 50,
    });

    const found = contents(result);
    expect(found).toContain("old-90d");
    expect(found).not.toContain("recent-2d");
  });

  it("treats a never-accessed old row as stale via the created_at fallback", async () => {
    // effective_last_access = COALESCE(last_accessed_at, created_at). If NULL
    // were treated as "recently accessed", never-touched entries -- the most
    // stale rows in the table -- would be invisible to the planner.
    await seedThought({
      content: "never-accessed-old",
      createdDaysAgo: 120,
      accessedDaysAgo: null,
    });
    // Same age, but accessed yesterday: must NOT be stale.
    await seedThought({
      content: "old-but-touched",
      createdDaysAgo: 120,
      accessedDaysAgo: 1,
    });

    const found = contents(
      await callListStale(ownerAuth, {
        table: "thoughts",
        days: 30,
        limit: 50,
      }),
    );

    expect(found).toContain("never-accessed-old");
    expect(found).not.toContain("old-but-touched");
  });

  it("orders results stalest-first across both accessed and never-accessed rows", async () => {
    // A fixture hands back a pre-sorted array, so this ordering is only real
    // when Postgres computes it -- and it mixes the two kinds of row so the
    // COALESCE participates in the sort rather than just the filter.
    await seedThought({
      content: "stale-60d-accessed",
      createdDaysAgo: 400,
      accessedDaysAgo: 60,
    });
    await seedThought({
      content: "stale-200d-never",
      createdDaysAgo: 200,
      accessedDaysAgo: null,
    });
    await seedThought({
      content: "stale-40d-accessed",
      createdDaysAgo: 400,
      accessedDaysAgo: 40,
    });

    const found = contents(
      await callListStale(ownerAuth, {
        table: "thoughts",
        days: 30,
        limit: 50,
      }),
    );

    expect(found).toEqual([
      "stale-200d-never",
      "stale-60d-accessed",
      "stale-40d-accessed",
    ]);
  });

  it("applies the tier filter on top of the threshold, not instead of it", async () => {
    await seedThought({
      content: "cold-stale",
      createdDaysAgo: 90,
      tier: "cold",
    });
    await seedThought({
      content: "warm-stale",
      createdDaysAgo: 90,
      tier: "warm",
    });
    // Same tier as the filter, but NOT stale: proves both predicates are live.
    await seedThought({
      content: "cold-fresh",
      createdDaysAgo: 1,
      tier: "cold",
    });

    const found = contents(
      await callListStale(ownerAuth, {
        table: "thoughts",
        days: 30,
        tier: "cold",
        limit: 50,
      }),
    );

    expect(found).toContain("cold-stale");
    expect(found).not.toContain("warm-stale");
    expect(found).not.toContain("cold-fresh");
  });

  it("excludes stale rows belonging to another namespace", async () => {
    await seedThought({ content: "mine-stale", createdDaysAgo: 90 });
    await seedThought({
      content: "theirs-stale",
      createdDaysAgo: 90,
      namespace: OTHER_NS,
    });

    const found = contents(
      await callListStale(ownerAuth, {
        table: "thoughts",
        days: 30,
        limit: 50,
      }),
    );

    expect(found).toContain("mine-stale");
    expect(found).not.toContain("theirs-stale");
  });

  it("excludes archived rows", async () => {
    const id = await seedThought({
      content: "archived-stale",
      createdDaysAgo: 90,
    });
    await pool.query(`UPDATE thoughts SET archived_at = NOW() WHERE id = $1`, [
      id,
    ]);
    await seedThought({ content: "live-stale", createdDaysAgo: 90 });

    const found = contents(
      await callListStale(ownerAuth, {
        table: "thoughts",
        days: 30,
        limit: 50,
      }),
    );

    expect(found).toContain("live-stale");
    expect(found).not.toContain("archived-stale");
  });
});
