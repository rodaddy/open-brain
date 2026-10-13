/**
 * Live-Postgres behavior tests for the ported reporting tools.
 *
 * The parity fixture freezes the shapes on an EMPTY namespace, which cannot
 * catch a wrong aggregate, a wrong trend band, or an access-log read that
 * ignores the namespace boundary -- all of those return zeros there. These
 * tests seed real rows and real log entries so the arithmetic is exercised.
 *
 * `entry_access_log` carries no namespace column, so the boundary test matters
 * most here: the log is scoped only by joining back to the owning row.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it (operator
 * ruling 2026-08-27, issue #878). It must point at an isolated test/playground
 * database, never the dogfood database. `bun run test:isolated` sets it.
 *
 * The two describes below split by SUBJECT -- the two tools this module
 * registers -- over one shared fixture. `access_report` reads a single entry's
 * log; `get_stats` aggregates across tables. They seed the same rows, so the
 * seeding is module-scope rather than duplicated per describe.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { registerReportingTools } from "./reporting.ts";
import { DEFAULT_SHARED_NAMESPACE_NAMES } from "./shared-namespace-fixture.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const NAMESPACE = `reporting-pg-${process.pid}`;
const OTHER_NAMESPACE = `${NAMESPACE}-other`;

/** Ids of the seeded rows, filled by the module-scope `beforeAll`. */
const seeded = { busyId: "", quietId: "", foreignId: "" };

/**
 * `get_stats` totals as they stood BEFORE this file seeded anything, captured
 * by the module-scope `beforeAll`.
 *
 * This namespace is not the only writer in the set of namespaces it can read:
 * `readNamespaces` returns `[clientId, "shared-kb"]` for a non-global role
 * (server/auth/namespace-policy.ts:27-30), so every readable aggregate here
 * also counts whatever else lives in `shared-kb` -- the recall-eval corpus
 * seeder puts rows there. The counts below are therefore asserted as a DELTA
 * against this baseline.
 */
const baseline = {
  thoughtsActive: 0,
  thoughtsTiers: {} as Record<string, number>,
  thoughtsZeroAccess: 0,
};

async function callTool(
  tool: string,
  namespace: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const server = new McpServer({ name: "reporting-test", version: "1.0.0" });
  registerReportingTools(server, {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
    sharedNamespaceNames: DEFAULT_SHARED_NAMESPACE_NAMES,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: {
        role: "agent",
        clientId: namespace,
        namespaceSource: "token",
      },
    } as never);
  const client = new Client({ name: "reporting-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { isError: result.isError === true, body };
  } finally {
    await client.close();
    await server.close();
  }
}

beforeAll(async () => {
  // Read the pre-existing totals BEFORE seeding, so the assertions below can
  // measure this file's own contribution rather than an absolute that
  // silently assumes `shared-kb` is empty.
  const before = await callTool("get_stats", NAMESPACE, {});
  const beforeCounts = before.body.entry_counts as Record<
    string,
    { active: number } | undefined
  >;
  const beforeTiers = before.body.tier_distribution as Record<
    string,
    Record<string, number> | undefined
  >;
  const beforeZero = before.body.zero_access_entries as Record<string, number>;
  baseline.thoughtsActive = beforeCounts.thoughts?.active ?? 0;
  baseline.thoughtsTiers = beforeTiers.thoughts ?? {};
  baseline.thoughtsZeroAccess = beforeZero.thoughts ?? 0;

  const busy = await pool.query(
    `INSERT INTO thoughts (content, namespace, created_by, tier, access_count)
     VALUES ($1, $2, $2, 'hot', 12) RETURNING id`,
    ["reporting busy entry", NAMESPACE],
  );
  seeded.busyId = busy.rows[0].id;
  const quiet = await pool.query(
    `INSERT INTO thoughts (content, namespace, created_by, tier, access_count)
     VALUES ($1, $2, $2, 'cold', 0) RETURNING id`,
    ["reporting quiet entry", NAMESPACE],
  );
  seeded.quietId = quiet.rows[0].id;
  const foreign = await pool.query(
    `INSERT INTO thoughts (content, namespace, created_by, tier, access_count)
     VALUES ($1, $2, $2, 'hot', 99) RETURNING id`,
    ["reporting foreign entry", OTHER_NAMESPACE],
  );
  seeded.foreignId = foreign.rows[0].id;

  // 6 recent vs 2 in the prior window -> rising. Two distinct agents and two
  // distinct query strings, with a NULL pair that must not be counted.
  await pool.query(
    `INSERT INTO entry_access_log (entry_id, source_table, accessed_at, accessed_by, query_text)
     SELECT $1, 'thoughts', NOW() - INTERVAL '1 hour', 'agent-a', 'query one'
       FROM generate_series(1, 3)`,
    [seeded.busyId],
  );
  await pool.query(
    `INSERT INTO entry_access_log (entry_id, source_table, accessed_at, accessed_by, query_text)
     SELECT $1, 'thoughts', NOW() - INTERVAL '2 hours', 'agent-b', 'query two'
       FROM generate_series(1, 3)`,
    [seeded.busyId],
  );
  await pool.query(
    `INSERT INTO entry_access_log (entry_id, source_table, accessed_at, accessed_by, query_text)
     VALUES ($1, 'thoughts', NOW() - INTERVAL '10 days', NULL, NULL),
            ($1, 'thoughts', NOW() - INTERVAL '11 days', NULL, NULL)`,
    [seeded.busyId],
  );
  // Foreign-namespace log rows: get_stats must not count these.
  await pool.query(
    `INSERT INTO entry_access_log (entry_id, source_table, accessed_at, accessed_by, query_text)
     SELECT $1, 'thoughts', NOW() - INTERVAL '1 hour', 'agent-x', 'foreign query'
       FROM generate_series(1, 5)`,
    [seeded.foreignId],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM entry_access_log WHERE entry_id = ANY($1::uuid[])`, [
    [seeded.busyId, seeded.quietId, seeded.foreignId],
  ]);
  await pool.query(`DELETE FROM thoughts WHERE namespace = ANY($1::text[])`, [
    [NAMESPACE, OTHER_NAMESPACE],
  ]);
  await pool.end();
});

describe("access_report (live Postgres)", () => {
  test("counts log rows, distinct queries, and distinct agents", async () => {
    const { isError, body } = await callTool("access_report", NAMESPACE, {
      entry_id: seeded.busyId,
    });
    expect(isError).toBe(false);
    expect(body.source_table).toBe("thoughts");
    expect(body.period_days).toBe(30);
    // 6 recent + 2 older, all inside the 30-day window.
    expect(body.total_accesses).toBe(8);
    // NULL query_text/accessed_by rows are excluded from the distinct counts.
    expect(body.unique_queries).toBe(2);
    expect(body.unique_agents).toBe(2);
  });

  test("reports a rising trend from the 7d/prior-7d split", async () => {
    const { body } = await callTool("access_report", NAMESPACE, {
      entry_id: seeded.busyId,
    });
    expect(body.trend).toBe("rising");
    // The 10/11-day-old rows land in the prior 7-14 day window, so the bands
    // are 6 vs 2 -- comfortably over the observed 1.2x rising threshold.
    expect(body.trend_detail).toEqual({ recent_7d: 6, previous_7d: 2 });
    expect(body.days_since_last_access).toBe(0);
  });

  test("narrows the window with days", async () => {
    const { body } = await callTool("access_report", NAMESPACE, {
      entry_id: seeded.busyId,
      days: 5,
    });
    // The two 10/11-day-old rows fall outside a 5-day window.
    expect(body.total_accesses).toBe(6);
    expect(body.period_days).toBe(5);
  });

  test("reports never-accessed entries as stable with no recency", async () => {
    const { body } = await callTool("access_report", NAMESPACE, {
      entry_id: seeded.quietId,
    });
    expect(body.total_accesses).toBe(0);
    expect(body.trend).toBe("stable");
    expect(body.last_accessed).toBeNull();
    expect(body.days_since_last_access).toBeNull();
  });

  test("refuses an entry in another namespace", async () => {
    const { isError, body } = await callTool("access_report", NAMESPACE, {
      entry_id: seeded.foreignId,
    });
    expect(isError).toBe(true);
    // Same text as a genuine miss, so existence is not disclosed.
    expect(body.text).toBe("Entry not found or not readable");
  });
});

describe("get_stats (live Postgres)", () => {
  test("aggregates counts, tiers, and zero-access per table", async () => {
    const { body } = await callTool("get_stats", NAMESPACE, {});
    // Deltas, not absolutes: `shared-kb` is readable by design
    // (server/auth/namespace-policy.ts:27-30), so this namespace is not the
    // only writer in the readable set, and an absolute count here would
    // silently encode "nothing else is in shared-kb". The delta still proves
    // the aggregate counted exactly the 2 rows -- one hot, one cold, one of
    // them zero-access -- that this file seeded.
    const counts = body.entry_counts as Record<string, { active: number } | undefined>;
    expect(counts.thoughts?.active).toBe(baseline.thoughtsActive + 2);
    const tiers = body.tier_distribution as Record<string, Record<string, number>>;
    expect(tiers.thoughts).toEqual({
      ...baseline.thoughtsTiers,
      hot: (baseline.thoughtsTiers.hot ?? 0) + 1,
      cold: (baseline.thoughtsTiers.cold ?? 0) + 1,
    });
    const zero = body.zero_access_entries as Record<string, number>;
    expect(zero.thoughts).toBe(baseline.thoughtsZeroAccess + 1);
  });

  test("ranks top_accessed and excludes foreign rows", async () => {
    const { body } = await callTool("get_stats", NAMESPACE, {});
    const top = body.top_accessed as Array<{
      id: string;
      access_count: number;
    }>;
    expect(top[0]?.id).toBe(seeded.busyId);
    expect(top[0]?.access_count).toBe(12);
    expect(top.map((row) => row.id)).not.toContain(seeded.foreignId);
  });

  test("scopes the access log by joining back to the owning row", async () => {
    const { body } = await callTool("get_stats", NAMESPACE, {});
    const stats = body.access_stats as Record<string, number>;
    // 8 rows belong to this namespace; the 5 foreign rows must not be counted.
    expect(stats.total_log_entries).toBe(8);
    expect(stats.unique_entries_accessed).toBe(1);
    // `avg_access_count` is a MEAN over every readable row, and `shared-kb` is
    // readable by design (server/auth/namespace-policy.ts:27-30), so the
    // denominator is not this file's to control -- an absolute expectation
    // there asserts that nothing else lives in `shared-kb`, which is not a
    // property of this tool and not what this test was written to prove. The
    // invariant it WAS written to prove is the namespace boundary on the log,
    // asserted above: 8 own rows counted, the 5 foreign ones excluded. The
    // mean is checked only for the shape a caller can rely on.
    expect(stats.avg_access_count).toBeGreaterThan(0);
    expect(Number.isFinite(stats.avg_access_count)).toBe(true);
  });

  test("namespace breakdown never lists a foreign namespace", async () => {
    const { body } = await callTool("get_stats", NAMESPACE, {});
    const namespaces = body.namespaces as Array<{
      namespace: string;
      count: number;
    }>;
    expect(namespaces.map((entry) => entry.namespace)).not.toContain(OTHER_NAMESPACE);
    const own = namespaces.find((entry) => entry.namespace === NAMESPACE);
    expect(own?.count).toBe(2);
  });
});
