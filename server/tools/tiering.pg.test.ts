/**
 * Live-Postgres behavior tests for the ported tiering tools.
 *
 * The parity fixtures freeze the EMPTY shapes, which cannot catch a wrong join
 * or a wrong namespace column -- an incorrect query returns `[]` there just as
 * happily as a correct one. These tests seed real rows so the demote filter and
 * the `entry_access_log` promote join are exercised with data, and assert the
 * namespace boundary holds against a foreign row.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it (operator
 * ruling 2026-08-27, issue #878). It must point at an isolated test/playground
 * database, never the dogfood database. `bun run test:isolated` sets it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { registerTieringTools } from "./tiering.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const NAMESPACE = `tiering-pg-${process.pid}`;
const OTHER_NAMESPACE = `${NAMESPACE}-other`;

async function callTierRecommendations(
  namespace: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const server = new McpServer({ name: "tiering-test", version: "1.0.0" });
  registerTieringTools(server, {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
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
  const client = new Client({ name: "tiering-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "tier_recommendations",
      arguments: args,
    });
    const text = (result.content as Array<{ text: string }>)[0]?.text;
    if (text === undefined)
      throw new Error("tier_recommendations returned no content");
    return JSON.parse(text);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("tier_recommendations (live Postgres)", () => {
  let staleId = "";
  let accessedId = "";

  beforeAll(async () => {
    const stale = await pool.query(
      `INSERT INTO thoughts (content, namespace, created_by, tier, access_count, last_accessed_at, created_at)
       VALUES ($1, $2, $2, 'warm', 0, NULL, NOW() - INTERVAL '200 days') RETURNING id`,
      ["tiering stale entry", NAMESPACE],
    );
    staleId = stale.rows[0].id;
    const accessed = await pool.query(
      `INSERT INTO thoughts (content, namespace, created_by, tier, access_count, last_accessed_at, created_at)
       VALUES ($1, $2, $2, 'warm', 1, NOW() - INTERVAL '120 days', NOW() - INTERVAL '150 days') RETURNING id`,
      ["tiering accessed entry", NAMESPACE],
    );
    accessedId = accessed.rows[0].id;
    // A busy row in ANOTHER namespace: it must never appear for our caller.
    await pool.query(
      `INSERT INTO thoughts (content, namespace, created_by, tier, access_count, last_accessed_at, created_at)
       VALUES ($1, $2, $2, 'warm', 0, NULL, NOW() - INTERVAL '300 days')`,
      ["tiering foreign entry", OTHER_NAMESPACE],
    );
    // Seven log rows clears the observed ">5 recent accesses" promote rule.
    await pool.query(
      `INSERT INTO entry_access_log (entry_id, source_table, accessed_at, context)
       SELECT $1, 'thoughts', NOW() - INTERVAL '1 hour', 'search' FROM generate_series(1, 7)`,
      [accessedId],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM entry_access_log WHERE entry_id = $1`, [
      accessedId,
    ]);
    await pool.query(`DELETE FROM thoughts WHERE namespace = ANY($1::text[])`, [
      [NAMESPACE, OTHER_NAMESPACE],
    ]);
    await pool.end();
  });

  test("demote surfaces warm, rarely-accessed, stale entries", async () => {
    const result = await callTierRecommendations(NAMESPACE, {
      action: "demote",
    });
    expect(result.action).toBe("demote");
    expect(result.threshold_days).toBe(30);
    const ids = (result.candidates as Array<{ id: string }>).map(
      (row) => row.id,
    );
    expect(ids).toContain(staleId);
    expect(result.candidates_found).toBe(ids.length);
    for (const candidate of result.candidates as Array<{
      suggested_tier: string;
    }>) {
      expect(candidate.suggested_tier).toBe("cold");
    }
  });

  test("promote reads recency from entry_access_log, not access_count", async () => {
    const result = await callTierRecommendations(NAMESPACE, {
      action: "promote",
    });
    expect(result.action).toBe("promote");
    expect(result.threshold_days).toBe(7);
    const candidates = result.candidates as Array<{
      id: string;
      suggested_tier: string;
      recent_accesses: number;
    }>;
    const promoted = candidates.find((row) => row.id === accessedId);
    // access_count is 1; only the LOG rows can put this entry over the rule.
    expect(promoted).toBeDefined();
    expect(promoted?.suggested_tier).toBe("hot");
    expect(promoted?.recent_accesses).toBe(7);
  });

  test("never returns an entry from a namespace the caller cannot read", async () => {
    const result = await callTierRecommendations(NAMESPACE, {
      action: "demote",
    });
    const previews = (
      result.candidates as Array<{ content_preview: string }>
    ).map((row) => row.content_preview);
    expect(previews).not.toContain("tiering foreign entry");
  });
});
