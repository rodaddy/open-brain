/**
 * `bulk_set_tier` records one `tier_moves` row per entry (#1469, plan item 5).
 *
 * The second of the three existing writers. Two properties matter here beyond
 * "a row got written":
 *
 *   - the tool's reported `updated` count still counts ROWS UPDATED, not rows
 *     updated plus rows of history;
 *   - an entry the write predicate does not match records nothing, so the
 *     history cannot claim a move that was refused.
 *
 * The history is written in the same statement as the UPDATE, inside the
 * transaction `runBulkTransaction` already opens, so a batch that rolls back
 * takes its moves with it. That is a property of the statement rather than
 * something a tool-level call can stage: every failure this tool can be made to
 * take is rejected by the input schema before the transaction opens.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`; `npm run test:isolated` sets it.
 */
import { afterAll, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { registerTierMutationTools } from "./tier-mutations.ts";
import { BULK_SET_TIER_CAUSE } from "../db/tier-moves.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const NAMESPACE = `tier-moves-bulk-${process.pid}`;

async function callBulkSetTier(
  entries: Array<{ id: string; table: string; tier: string }>,
): Promise<Record<string, unknown>> {
  const server = new McpServer({ name: "tier-moves-bulk", version: "1.0.0" });
  registerTierMutationTools(server, {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
  } as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { role: "agent", clientId: NAMESPACE, namespaceSource: "token" },
    } as never);
  const client = new Client({ name: "tier-moves-bulk", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "bulk_set_tier",
      arguments: { entries },
    });
    const text = (result.content as Array<{ text: string }>)[0]?.text;
    if (text === undefined) throw new Error("bulk_set_tier returned no content");
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    await client.close();
    await server.close();
  }
}

async function seedThought(tier: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO thoughts (content, namespace, created_by, tier)
     VALUES ($1, $2, $2, $3) RETURNING id`,
    ["tier-moves bulk fixture", NAMESPACE, tier],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("seedThought inserted no row");
  return row.id;
}

async function movesFor(entryIds: string[]) {
  const { rows } = await pool.query<{
    entry_id: string;
    source_table: string;
    from_tier: string | null;
    to_tier: string;
    cause: string;
    routing_run_id: string | null;
  }>(
    `SELECT entry_id, source_table, from_tier, to_tier, cause, routing_run_id
       FROM tier_moves WHERE entry_id = ANY($1::uuid[])`,
    [entryIds],
  );
  return rows;
}

afterAll(async () => {
  await pool.query(`DELETE FROM thoughts WHERE namespace = ANY($1::text[])`, [
    [NAMESPACE, `${NAMESPACE}-other`],
  ]);
  await pool.end();
});

test("bulk_set_tier writes exactly one tier_moves row per entry", async () => {
  const cold = await seedThought("cold");
  const warm = await seedThought("warm");

  const result = await callBulkSetTier([
    { id: cold, table: "thoughts", tier: "hot" },
    { id: warm, table: "thoughts", tier: "cold" },
  ]);
  // The count is rows UPDATED; the history CTE must not inflate it.
  expect(result.updated).toBe(2);

  const moves = await movesFor([cold, warm]);
  expect(moves).toHaveLength(2);
  const byEntry = new Map(moves.map((row) => [row.entry_id, row]));
  expect(byEntry.get(cold)).toMatchObject({
    source_table: "thoughts",
    from_tier: "cold",
    to_tier: "hot",
    cause: BULK_SET_TIER_CAUSE,
    routing_run_id: null,
  });
  expect(byEntry.get(warm)).toMatchObject({
    from_tier: "warm",
    to_tier: "cold",
    cause: BULK_SET_TIER_CAUSE,
  });
});

test("an entry the caller cannot write moves nothing and records nothing", async () => {
  const foreign = await pool.query<{ id: string }>(
    `INSERT INTO thoughts (content, namespace, created_by, tier)
     VALUES ($1, $2, $2, 'cold') RETURNING id`,
    ["tier-moves bulk foreign fixture", `${NAMESPACE}-other`],
  );
  const foreignRow = foreign.rows[0];
  if (foreignRow === undefined) {
    throw new Error("foreign fixture insert returned no row");
  }
  const id = foreignRow.id;

  // The namespace predicate is on the UPDATE itself, so this entry is simply
  // not matched. Nothing moved, so nothing may be recorded as having moved --
  // the history must not claim a move the write predicate refused.
  const result = await callBulkSetTier([{ id, table: "thoughts", tier: "hot" }]);
  expect(result.updated).toBe(0);
  expect(await movesFor([id])).toHaveLength(0);
});
