/**
 * `set_tier` records its move in `tier_moves` (#1469, plan item 5).
 *
 * Migration 050 created the table and left it unwired on purpose; this proves
 * the first of the three existing writers is now wired, and wired exactly once:
 * one row per tier change, carrying the tier it came FROM -- the value the bare
 * `UPDATE ... SET tier` used to destroy.
 *
 * Driven through the registered `set_tier` tool rather than the repository, so
 * the auth-derived namespace predicate is part of the path under test: a
 * history row that appears for a write the predicate refuses would be worse
 * than no history at all.
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
import { registerTierMutationTools } from "../tools/tier-mutations.ts";
import { SET_TIER_CAUSE } from "./tier-moves.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const NAMESPACE = `tier-moves-set-${process.pid}`;
const OTHER_NAMESPACE = `${NAMESPACE}-other`;

async function callSetTier(
  namespace: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = new McpServer({ name: "tier-moves-test", version: "1.0.0" });
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
      authInfo: { role: "agent", clientId: namespace, namespaceSource: "token" },
    } as never);
  const client = new Client({ name: "tier-moves-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "set_tier", arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text;
    if (text === undefined) throw new Error("set_tier returned no content");
    // Returned RAW: set_tier answers a success with JSON and a refusal with a
    // plain sentence, so parsing here would turn a refusal into a crash.
    return text;
  } finally {
    await client.close();
    await server.close();
  }
}

async function seedThought(namespace: string, tier: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO thoughts (content, namespace, created_by, tier)
     VALUES ($1, $2, $2, $3) RETURNING id`,
    ["tier-moves set_tier fixture", namespace, tier],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("seedThought inserted no row");
  return row.id;
}

async function movesFor(entryId: string) {
  const { rows } = await pool.query<{
    source_table: string;
    from_tier: string | null;
    to_tier: string;
    cause: string;
    routing_run_id: string | null;
  }>(
    `SELECT source_table, from_tier, to_tier, cause, routing_run_id
       FROM tier_moves WHERE entry_id = $1 ORDER BY moved_at`,
    [entryId],
  );
  return rows;
}

afterAll(async () => {
  await pool.query(`DELETE FROM thoughts WHERE namespace = ANY($1::text[])`, [
    [NAMESPACE, OTHER_NAMESPACE],
  ]);
  await pool.end();
});

test("set_tier writes exactly one tier_moves row naming the move", async () => {
  const id = await seedThought(NAMESPACE, "cold");
  const result = await callSetTier(NAMESPACE, { table: "thoughts", id, tier: "hot" });
  expect(JSON.parse(result).tier).toBe("hot");

  const moves = await movesFor(id);
  expect(moves).toHaveLength(1);
  expect(moves[0]).toMatchObject({
    source_table: "thoughts",
    from_tier: "cold",
    to_tier: "hot",
    cause: SET_TIER_CAUSE,
    routing_run_id: null,
  });
});

test("a second set_tier appends rather than overwriting", async () => {
  const id = await seedThought(NAMESPACE, "warm");
  await callSetTier(NAMESPACE, { table: "thoughts", id, tier: "hot" });
  await callSetTier(NAMESPACE, { table: "thoughts", id, tier: "cold" });

  const moves = await movesFor(id);
  expect(moves.map((row) => [row.from_tier, row.to_tier])).toEqual([
    ["warm", "hot"],
    ["hot", "cold"],
  ]);
});

test("a refused write records no move", async () => {
  const id = await seedThought(OTHER_NAMESPACE, "cold");
  const result = await callSetTier(NAMESPACE, { table: "thoughts", id, tier: "hot" });
  expect(result).toContain("not found");

  expect(await movesFor(id)).toHaveLength(0);
  const { rows } = await pool.query<{ tier: string }>(
    `SELECT tier FROM thoughts WHERE id = $1`,
    [id],
  );
  const tierRow = rows[0];
  if (tierRow === undefined) throw new Error("tier read returned no row");
  expect(tierRow.tier).toBe("cold");
});
