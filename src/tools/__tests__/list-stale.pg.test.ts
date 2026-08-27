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
 *     rows either side of the cutoff are included/excluded correctly.
 *  2. `effective_last_access` falls back to created_at when last_accessed_at
 *     is NULL. A never-accessed old row IS stale; treating NULL as "recent"
 *     would hide exactly the entries the planner exists to find.
 *  3. Results are ordered stalest-first by that computed column, across a
 *     mix of both kinds of row -- the ordering a fixture cannot demonstrate.
 *  4. Tier filters compose with the threshold rather than replacing it.
 *  5. Namespace scoping is real: rows in another namespace are absent from
 *     the results, as are archived rows.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it (operator
 * ruling 2026-08-27, issue #878). A suite that skips itself reports `0 pass,
 * N skip` and exits 0, which is indistinguishable from a suite that ran and
 * passed. It must point at an isolated test/playground database, never the
 * dogfood database; `bun run test:isolated` sets it.
 *
 * The three describes below split by SUBJECT over one shared fixture: the
 * staleness threshold itself, the ordering it induces, and the scoping
 * predicates that compose with it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import { runMigrations } from "../../db/migrate.ts";
import { registerListStale } from "../list-stale.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

const CREATED_BY = "dream-list-stale-pg-test";
const OWNER_NS = "dream-list-stale-owner-ns";
const OTHER_NS = "dream-list-stale-other-ns";

const ownerAuth: AuthInfo = {
  role: "agent",
  clientId: OWNER_NS,
  namespaceSource: "token",
};

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

async function cleanup(): Promise<void> {
  for (const table of ["thoughts", "decisions"]) {
    await pool.query(`DELETE FROM ${table} WHERE created_by = $1`, [
      CREATED_BY,
    ]);
  }
}

beforeAll(async () => {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await runMigrations(pool);
  await cleanup();
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await pool.end();
});

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

/**
 * Call list_stale over a real in-memory MCP transport, so the tool sees the
 * same auth binding and argument validation it sees in production.
 *
 * Returns the previews of the returned entries, in the order the tool returned
 * them. The projection exposes `content_preview` (LEFT(..., 200)), not the raw
 * content column, so the seeded markers are matched against that.
 */
async function staleContents(
  auth: AuthInfo,
  args: Record<string, unknown>,
): Promise<string[]> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool, embedFn: async () => null } as ToolDeps;
  registerListStale(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, { ...options, authInfo: auth } as never);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({
      name: "list_stale",
      arguments: args,
    });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "{}";
    const parsed = JSON.parse(text) as {
      entries?: Array<{ content_preview: string }>;
    };
    return (parsed.entries ?? []).map((entry) => entry.content_preview);
  } finally {
    await client.close();
    await server.close();
  }
}

/** The standard query: thoughts older than 30 days, in the owner namespace. */
function staleThoughts(extra: Record<string, unknown> = {}): Promise<string[]> {
  return staleContents(ownerAuth, {
    table: "thoughts",
    days: 30,
    limit: 50,
    ...extra,
  });
}

describe("list_stale staleness threshold (live Postgres)", () => {
  it("includes rows older than the threshold and excludes newer ones", async () => {
    // The cutoff is a real date comparison, not a filter the fixture applied.
    await seedThought({ content: "old-90d", createdDaysAgo: 90 });
    await seedThought({ content: "recent-2d", createdDaysAgo: 2 });

    const found = await staleThoughts();

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

    const found = await staleThoughts();

    expect(found).toContain("never-accessed-old");
    expect(found).not.toContain("old-but-touched");
  });
});

describe("list_stale result ordering (live Postgres)", () => {
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

    const found = await staleThoughts();

    expect(found).toEqual([
      "stale-200d-never",
      "stale-60d-accessed",
      "stale-40d-accessed",
    ]);
  });
});

describe("list_stale scoping predicates (live Postgres)", () => {
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

    const found = await staleThoughts({ tier: "cold" });

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

    const found = await staleThoughts();

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

    const found = await staleThoughts();

    expect(found).toContain("live-stale");
    expect(found).not.toContain("archived-stale");
  });
});
