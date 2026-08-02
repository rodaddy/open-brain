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
 * Skips loudly (via `describe.skip`) when `OPENBRAIN_TEST_DATABASE_URL` is
 * unset. It must point at an isolated test/playground database, never the
 * dogfood database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import { registerReportingTools } from "./reporting.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;
const pool = DB_URL ? new Pool({ connectionString: DB_URL }) : null;

const NAMESPACE = `reporting-pg-${process.pid}`;
const OTHER_NAMESPACE = `${NAMESPACE}-other`;

async function callTool(
  tool: string,
  namespace: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  if (!pool) throw new Error("OPENBRAIN_TEST_DATABASE_URL is required");
  const server = new McpServer({ name: "reporting-test", version: "1.0.0" });
  registerReportingTools(server, {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { role: "agent", clientId: namespace, namespaceSource: "token" },
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

dbDescribe("reporting tools (live Postgres)", () => {
  let busyId = "";
  let quietId = "";
  let foreignId = "";

  beforeAll(async () => {
    const busy = await pool!.query(
      `INSERT INTO thoughts (content, namespace, created_by, tier, access_count)
       VALUES ($1, $2, $2, 'hot', 12) RETURNING id`,
      ["reporting busy entry", NAMESPACE],
    );
    busyId = busy.rows[0].id;
    const quiet = await pool!.query(
      `INSERT INTO thoughts (content, namespace, created_by, tier, access_count)
       VALUES ($1, $2, $2, 'cold', 0) RETURNING id`,
      ["reporting quiet entry", NAMESPACE],
    );
    quietId = quiet.rows[0].id;
    const foreign = await pool!.query(
      `INSERT INTO thoughts (content, namespace, created_by, tier, access_count)
       VALUES ($1, $2, $2, 'hot', 99) RETURNING id`,
      ["reporting foreign entry", OTHER_NAMESPACE],
    );
    foreignId = foreign.rows[0].id;

    // 6 recent vs 2 in the prior window -> rising. Two distinct agents and two
    // distinct query strings, with a NULL pair that must not be counted.
    await pool!.query(
      `INSERT INTO entry_access_log (entry_id, source_table, accessed_at, accessed_by, query_text)
       SELECT $1, 'thoughts', NOW() - INTERVAL '1 hour', 'agent-a', 'query one'
         FROM generate_series(1, 3)`,
      [busyId],
    );
    await pool!.query(
      `INSERT INTO entry_access_log (entry_id, source_table, accessed_at, accessed_by, query_text)
       SELECT $1, 'thoughts', NOW() - INTERVAL '2 hours', 'agent-b', 'query two'
         FROM generate_series(1, 3)`,
      [busyId],
    );
    await pool!.query(
      `INSERT INTO entry_access_log (entry_id, source_table, accessed_at, accessed_by, query_text)
       VALUES ($1, 'thoughts', NOW() - INTERVAL '10 days', NULL, NULL),
              ($1, 'thoughts', NOW() - INTERVAL '11 days', NULL, NULL)`,
      [busyId],
    );
    // Foreign-namespace log rows: get_stats must not count these.
    await pool!.query(
      `INSERT INTO entry_access_log (entry_id, source_table, accessed_at, accessed_by, query_text)
       SELECT $1, 'thoughts', NOW() - INTERVAL '1 hour', 'agent-x', 'foreign query'
         FROM generate_series(1, 5)`,
      [foreignId],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM entry_access_log WHERE entry_id = ANY($1::uuid[])`, [
      [busyId, quietId, foreignId],
    ]);
    await pool.query(`DELETE FROM thoughts WHERE namespace = ANY($1::text[])`, [
      [NAMESPACE, OTHER_NAMESPACE],
    ]);
    await pool.end();
  });

  test("access_report counts log rows, distinct queries, and distinct agents", async () => {
    const { isError, body } = await callTool("access_report", NAMESPACE, {
      entry_id: busyId,
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

  test("access_report reports a rising trend from the 7d/prior-7d split", async () => {
    const { body } = await callTool("access_report", NAMESPACE, { entry_id: busyId });
    expect(body.trend).toBe("rising");
    // The 10/11-day-old rows land in the prior 7-14 day window, so the bands
    // are 6 vs 2 -- comfortably over the observed 1.2x rising threshold.
    expect(body.trend_detail).toEqual({ recent_7d: 6, previous_7d: 2 });
    expect(body.days_since_last_access).toBe(0);
  });

  test("access_report narrows the window with days", async () => {
    const { body } = await callTool("access_report", NAMESPACE, {
      entry_id: busyId,
      days: 5,
    });
    // The two 10/11-day-old rows fall outside a 5-day window.
    expect(body.total_accesses).toBe(6);
    expect(body.period_days).toBe(5);
  });

  test("access_report reports never-accessed entries as stable with no recency", async () => {
    const { body } = await callTool("access_report", NAMESPACE, {
      entry_id: quietId,
    });
    expect(body.total_accesses).toBe(0);
    expect(body.trend).toBe("stable");
    expect(body.last_accessed).toBeNull();
    expect(body.days_since_last_access).toBeNull();
  });

  test("access_report refuses an entry in another namespace", async () => {
    const { isError, body } = await callTool("access_report", NAMESPACE, {
      entry_id: foreignId,
    });
    expect(isError).toBe(true);
    // Same text as a genuine miss, so existence is not disclosed.
    expect(body.text).toBe("Entry not found or not readable");
  });

  test("get_stats aggregates counts, tiers, and zero-access per table", async () => {
    const { body } = await callTool("get_stats", NAMESPACE, {});
    const counts = body.entry_counts as Record<string, { active: number } | undefined>;
    expect(counts.thoughts?.active).toBe(2);
    const tiers = body.tier_distribution as Record<string, Record<string, number>>;
    expect(tiers.thoughts).toEqual({ hot: 1, cold: 1 });
    const zero = body.zero_access_entries as Record<string, number>;
    expect(zero.thoughts).toBe(1);
  });

  test("get_stats ranks top_accessed and excludes foreign rows", async () => {
    const { body } = await callTool("get_stats", NAMESPACE, {});
    const top = body.top_accessed as Array<{ id: string; access_count: number }>;
    expect(top[0]?.id).toBe(busyId);
    expect(top[0]?.access_count).toBe(12);
    expect(top.map((row) => row.id)).not.toContain(foreignId);
  });

  test("get_stats scopes the access log by joining back to the owning row", async () => {
    const { body } = await callTool("get_stats", NAMESPACE, {});
    const stats = body.access_stats as Record<string, number>;
    // 8 rows belong to this namespace; the 5 foreign rows must not be counted.
    expect(stats.total_log_entries).toBe(8);
    expect(stats.unique_entries_accessed).toBe(1);
    // (12 + 0) / 2 entries = 6, averaged over the one table with rows.
    expect(stats.avg_access_count).toBeCloseTo(6 / 5, 5);
  });

  test("get_stats namespace breakdown never lists a foreign namespace", async () => {
    const { body } = await callTool("get_stats", NAMESPACE, {});
    const namespaces = body.namespaces as Array<{ namespace: string; count: number }>;
    expect(namespaces.map((entry) => entry.namespace)).not.toContain(OTHER_NAMESPACE);
    const own = namespaces.find((entry) => entry.namespace === NAMESPACE);
    expect(own?.count).toBe(2);
  });
});
