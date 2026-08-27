/**
 * Live-Postgres behavior tests for the ported `list_stale`.
 *
 * The parity fixture freezes the EMPTY envelope, which cannot catch a wrong
 * staleness predicate, a wrong UNION arm, or a missing namespace clause -- all
 * of those return `[]` just as happily as a correct query. These tests seed real
 * rows so the `last_accessed_at`-falls-back-to-`created_at` rule, the tier
 * filter, pagination, and the namespace boundary are each exercised with data.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it (operator
 * ruling 2026-08-27, issue #878). It must point at an isolated test/playground database, never the
 * dogfood database.
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

const NAMESPACE = `list-stale-pg-${process.pid}`;
const OTHER_NAMESPACE = `${NAMESPACE}-other`;

interface StaleEnvelope {
  entries: Array<{
    id: string;
    source_type: string;
    content_preview: string;
    tier: string | null;
  }>;
  total_count: number | null;
  offset: number;
  limit: number;
  has_more: boolean;
}

async function callListStale(
  namespace: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const server = new McpServer({ name: "list-stale-test", version: "1.0.0" });
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
  const client = new Client({ name: "list-stale-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "list_stale",
      arguments: args,
    });
    const text = (result.content as Array<{ text: string }>)[0]?.text;
    if (text === undefined) throw new Error("list_stale returned no content");
    return JSON.parse(text);
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * Ids of the seeded rows, filled by the module-scope `beforeAll`.
 *
 * The two describes below split by SUBJECT over ONE shared fixture -- the
 * staleness predicate itself, then the envelope and boundary rules that read
 * the same rows. Seeding is module-scope rather than duplicated per describe.
 */
let neverAccessedId = "";
let longAgoId = "";
let freshId = "";
let coldId = "";

beforeAll(async () => {
  // Never accessed, created long ago: stale only if the query falls back to
  // created_at. A COALESCE-less predicate would drop this row.
  const neverAccessed = await pool.query(
    `INSERT INTO thoughts (content, namespace, created_by, tier, access_count, last_accessed_at, created_at)
       VALUES ($1, $2, $2, 'hot', 0, NULL, NOW() - INTERVAL '200 days') RETURNING id`,
    ["list-stale never accessed", NAMESPACE],
  );
  neverAccessedId = neverAccessed.rows[0].id;

  const longAgo = await pool.query(
    `INSERT INTO thoughts (content, namespace, created_by, tier, access_count, last_accessed_at, created_at)
       VALUES ($1, $2, $2, 'warm', 4, NOW() - INTERVAL '100 days', NOW() - INTERVAL '300 days') RETURNING id`,
    ["list-stale accessed long ago", NAMESPACE],
  );
  longAgoId = longAgo.rows[0].id;

  // Accessed yesterday: must NEVER appear at a 30-day threshold.
  const fresh = await pool.query(
    `INSERT INTO thoughts (content, namespace, created_by, tier, access_count, last_accessed_at, created_at)
       VALUES ($1, $2, $2, 'hot', 9, NOW() - INTERVAL '1 day', NOW() - INTERVAL '400 days') RETURNING id`,
    ["list-stale fresh", NAMESPACE],
  );
  freshId = fresh.rows[0].id;

  const cold = await pool.query(
    `INSERT INTO thoughts (content, namespace, created_by, tier, access_count, last_accessed_at, created_at)
       VALUES ($1, $2, $2, 'cold', 0, NULL, NOW() - INTERVAL '250 days') RETURNING id`,
    ["list-stale cold tier", NAMESPACE],
  );
  coldId = cold.rows[0].id;

  await pool.query(
    `INSERT INTO thoughts (content, namespace, created_by, tier, access_count, last_accessed_at, created_at)
       VALUES ($1, $2, $2, 'warm', 0, NULL, NOW() - INTERVAL '500 days')`,
    ["list-stale foreign entry", OTHER_NAMESPACE],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM thoughts WHERE namespace = ANY($1::text[])`, [
    [NAMESPACE, OTHER_NAMESPACE],
  ]);
  await pool.end();
});

describe("list_stale staleness predicate (live Postgres)", () => {
  test("falls back to created_at for entries that were never accessed", async () => {
    const result = (await callListStale(NAMESPACE, {
      table: "thoughts",
      days: 30,
    })) as StaleEnvelope;
    const ids = result.entries.map((row) => row.id);
    expect(ids).toContain(neverAccessedId);
    expect(ids).toContain(longAgoId);
  });

  test("excludes an entry accessed inside the staleness window", async () => {
    const result = (await callListStale(NAMESPACE, {
      table: "thoughts",
      days: 30,
    })) as StaleEnvelope;
    expect(result.entries.map((row) => row.id)).not.toContain(freshId);
  });

  test("labels rows with the singular source_type, not the table name", async () => {
    const result = (await callListStale(NAMESPACE, {
      table: "thoughts",
      days: 30,
    })) as StaleEnvelope;
    expect(result.entries.length).toBeGreaterThan(0);
    for (const row of result.entries) expect(row.source_type).toBe("thought");
  });

  test("tier filter narrows to exactly that tier", async () => {
    const result = (await callListStale(NAMESPACE, {
      table: "thoughts",
      days: 30,
      tier: "cold",
    })) as StaleEnvelope;
    const ids = result.entries.map((row) => row.id);
    expect(ids).toEqual([coldId]);
    expect(result.total_count).toBe(1);
  });
});

describe("list_stale envelope, paging and namespace boundary (live Postgres)", () => {
  test("envelope counts the whole match set, not just the returned page", async () => {
    const page = (await callListStale(NAMESPACE, {
      table: "thoughts",
      days: 30,
      limit: 1,
    })) as StaleEnvelope;
    expect(page.entries).toHaveLength(1);
    expect(page.limit).toBe(1);
    expect(page.offset).toBe(0);
    // 3 stale rows seeded (never-accessed, long-ago, cold); fresh is excluded.
    expect(page.total_count).toBe(3);
    expect(page.has_more).toBe(true);
  });

  test("offset walks the ordered result without repeating a row", async () => {
    const first = (await callListStale(NAMESPACE, {
      table: "thoughts",
      days: 30,
      limit: 1,
    })) as StaleEnvelope;
    const second = (await callListStale(NAMESPACE, {
      table: "thoughts",
      days: 30,
      limit: 1,
      offset: 1,
    })) as StaleEnvelope;
    expect(second.entries[0]?.id).not.toBe(first.entries[0]?.id);
    expect(second.offset).toBe(1);
  });

  test("array response_format returns a bare array for back-compat", async () => {
    const result = await callListStale(NAMESPACE, {
      table: "thoughts",
      days: 30,
      response_format: "array",
    });
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(3);
  });

  test("never returns an entry from a namespace the caller cannot read", async () => {
    const result = (await callListStale(NAMESPACE, {
      table: "thoughts",
      days: 30,
    })) as StaleEnvelope;
    const previews = result.entries.map((row) => row.content_preview);
    expect(previews).not.toContain("list-stale foreign entry");
    // The count must respect the same boundary as the rows; a count query
    // missing the predicate would report the foreign row and inflate has_more.
    expect(result.total_count).toBe(3);
  });
});
