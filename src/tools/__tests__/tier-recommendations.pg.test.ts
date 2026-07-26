/**
 * Live-Postgres coverage for tier_recommendations, the dream planner that
 * proposes promote/demote actions.
 *
 * It writes nothing, so the risk is a wrong recommendation SET. Its output is
 * what a dream run acts on, so a threshold that is off by one, or a join that
 * counts the wrong rows, proposes tier changes for entries that do not warrant
 * them -- and silently omits the ones that do.
 *
 * The focused suite (5 cases) covers auth and read-namespace scoping against
 * fake pools. The selection logic is the part it cannot reach: the demote
 * branch combines a tier check, a NULL-tolerant recency test, and an
 * access_count ceiling, and the promote branch runs a CORRELATED SUBQUERY
 * against entry_access_log with a `> 5` threshold. A fake returns whatever
 * candidate list the fixture defines, so none of those predicates are
 * evaluated.
 *
 * Proven here against real rows:
 *  1. Demote selects only warm entries under the access_count ceiling that are
 *     stale, and each of the three predicates is shown to be load-bearing by a
 *     row that satisfies the other two.
 *  2. A NULL last_accessed_at counts as stale for demote (`IS NULL OR <`),
 *     matching list_stale's fallback -- never-accessed rows are exactly the
 *     demote candidates a planner must not miss.
 *  3. Demote ordering is least-accessed-first, computed by Postgres.
 *  4. Promote counts rows in entry_access_log within the threshold window and
 *     applies a strict `> 5`: five accesses is NOT a candidate, six is. The
 *     boundary is asserted on both sides because an off-by-one here is
 *     invisible in a fixture.
 *  5. Promote counts only accesses INSIDE the window and only those belonging
 *     to the right entry and source_table -- the correlated subquery's join
 *     conditions, which a fake cannot exercise.
 *
 * Gated on OPENBRAIN_TEST_DATABASE_URL (repo dbDescribe convention).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runMigrations } from "../../db/migrate.ts";
import { registerTierRecommendations } from "../tier-recommendations.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

const CREATED_BY = "dream-tier-rec-pg-test";
const OWNER_NS = "dream-tier-rec-owner-ns";

const ownerAuth: AuthInfo = {
  role: "agent",
  clientId: OWNER_NS,
  namespaceSource: "token",
};

dbDescribe("tier_recommendations (live Postgres)", () => {
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
    // entry_access_log rows are removed first: they reference the thoughts
    // this suite created, and they carry no created_by of their own.
    await pool.query(
      `DELETE FROM entry_access_log
        WHERE entry_id IN (SELECT id FROM thoughts WHERE created_by = $1)`,
      [CREATED_BY],
    );
    await pool.query(`DELETE FROM thoughts WHERE created_by = $1`, [
      CREATED_BY,
    ]);
  }

  async function seedThought(opts: {
    content: string;
    tier?: string;
    accessCount?: number;
    accessedDaysAgo?: number | null;
    namespace?: string;
  }): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO thoughts
         (content, created_by, namespace, tier, access_count, last_accessed_at)
       VALUES ($1, $2, $3, $4, $5,
               CASE WHEN $6::numeric IS NULL THEN NULL
                    ELSE NOW() - INTERVAL '1 day' * $6 END)
       RETURNING id`,
      [
        opts.content,
        CREATED_BY,
        opts.namespace ?? OWNER_NS,
        opts.tier ?? "warm",
        opts.accessCount ?? 0,
        opts.accessedDaysAgo ?? null,
      ],
    );
    return rows[0].id as string;
  }

  /** Record `count` accesses for an entry, `daysAgo` before now. */
  async function logAccesses(
    entryId: string,
    count: number,
    daysAgo: number,
    sourceTable = "thoughts",
  ): Promise<void> {
    for (let i = 0; i < count; i++) {
      await pool.query(
        `INSERT INTO entry_access_log (entry_id, source_table, accessed_at)
         VALUES ($1, $2, NOW() - INTERVAL '1 day' * $3)`,
        [entryId, sourceTable, daysAgo],
      );
    }
  }

  async function callRecommendations(
    auth: AuthInfo,
    args: Record<string, unknown>,
  ) {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = { pool: pool as any, embedFn: async () => null };
    registerTierRecommendations(server, deps);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message: any, options?: any) =>
      originalSend(message, { ...options, authInfo: auth });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      return await client.callTool({
        name: "tier_recommendations",
        arguments: args,
      });
    } finally {
      await client.close();
      await server.close();
    }
  }

  function previews(result: any): string[] {
    const parsed = JSON.parse((result.content as any)[0].text);
    return (parsed.recommendations ?? parsed.candidates ?? []).map(
      (c: any) => c.content_preview,
    );
  }

  it("demotes only warm, rarely-accessed, stale entries", async () => {
    // The candidate: warm, 1 access, last touched 90 days ago.
    await seedThought({
      content: "demote-me",
      tier: "warm",
      accessCount: 1,
      accessedDaysAgo: 90,
    });
    // Each of the following breaks exactly ONE of the three predicates while
    // satisfying the other two, so each proves its predicate is live.
    await seedThought({
      content: "wrong-tier-cold",
      tier: "cold",
      accessCount: 1,
      accessedDaysAgo: 90,
    });
    await seedThought({
      content: "too-many-accesses",
      tier: "warm",
      accessCount: 9,
      accessedDaysAgo: 90,
    });
    await seedThought({
      content: "accessed-recently",
      tier: "warm",
      accessCount: 1,
      accessedDaysAgo: 1,
    });

    const found = previews(
      await callRecommendations(ownerAuth, {
        action: "demote",
        threshold_days: 30,
        limit: 50,
      }),
    );

    expect(found).toContain("demote-me");
    expect(found).not.toContain("wrong-tier-cold");
    expect(found).not.toContain("too-many-accesses");
    expect(found).not.toContain("accessed-recently");
  });

  it("treats a never-accessed warm entry as a demote candidate", async () => {
    // `last_accessed_at IS NULL OR last_accessed_at < cutoff`. Without the
    // NULL arm, entries nobody has ever touched -- the strongest demote
    // candidates there are -- would never be recommended.
    await seedThought({
      content: "never-accessed",
      tier: "warm",
      accessCount: 0,
      accessedDaysAgo: null,
    });

    const found = previews(
      await callRecommendations(ownerAuth, {
        action: "demote",
        threshold_days: 30,
        limit: 50,
      }),
    );

    expect(found).toContain("never-accessed");
  });

  it("orders demote candidates least-accessed first", async () => {
    await seedThought({
      content: "two-accesses",
      tier: "warm",
      accessCount: 2,
      accessedDaysAgo: 90,
    });
    await seedThought({
      content: "zero-accesses",
      tier: "warm",
      accessCount: 0,
      accessedDaysAgo: 90,
    });
    await seedThought({
      content: "one-access",
      tier: "warm",
      accessCount: 1,
      accessedDaysAgo: 90,
    });

    const found = previews(
      await callRecommendations(ownerAuth, {
        action: "demote",
        threshold_days: 30,
        limit: 50,
      }),
    );

    expect(found).toEqual(["zero-accesses", "one-access", "two-accesses"]);
  });

  it("promotes on a strict access threshold: five is not enough, six is", async () => {
    // The promote branch counts entry_access_log rows in the window and
    // requires `> 5`. A fixture cannot show the boundary, so both sides are
    // asserted: an off-by-one here silently changes which entries a dream run
    // promotes.
    const five = await seedThought({ content: "exactly-five", tier: "warm" });
    const six = await seedThought({ content: "exactly-six", tier: "warm" });
    await logAccesses(five, 5, 1);
    await logAccesses(six, 6, 1);

    const found = previews(
      await callRecommendations(ownerAuth, {
        action: "promote",
        threshold_days: 7,
        limit: 50,
      }),
    );

    expect(found).toContain("exactly-six");
    expect(found).not.toContain("exactly-five");
  });

  it("counts only accesses inside the threshold window", async () => {
    // Ten accesses, all older than the window: the row must not qualify. This
    // is the `accessed_at >= NOW() - INTERVAL '1 day' * $1` arm of the
    // correlated subquery.
    const stale = await seedThought({
      content: "old-accesses-only",
      tier: "warm",
    });
    await logAccesses(stale, 10, 60);

    const fresh = await seedThought({
      content: "recent-accesses",
      tier: "warm",
    });
    await logAccesses(fresh, 10, 2);

    const found = previews(
      await callRecommendations(ownerAuth, {
        action: "promote",
        threshold_days: 7,
        limit: 50,
      }),
    );

    expect(found).toContain("recent-accesses");
    expect(found).not.toContain("old-accesses-only");
  });

  it("counts only access-log rows belonging to the same entry and table", async () => {
    // The subquery joins on BOTH eal.entry_id and eal.source_table. Logging
    // plenty of accesses under a different source_table must not promote the
    // row, or accesses to an unrelated table's entry would leak across.
    const target = await seedThought({
      content: "wrong-source-table",
      tier: "warm",
    });
    await logAccesses(target, 10, 1, "decisions");

    const found = previews(
      await callRecommendations(ownerAuth, {
        action: "promote",
        threshold_days: 7,
        limit: 50,
      }),
    );

    expect(found).not.toContain("wrong-source-table");
  });
});
