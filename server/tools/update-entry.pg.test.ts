/**
 * Live-Postgres behavior tests for `update_entry`'s three early-return guards.
 *
 * THE ASSERTION THAT MATTERS IS THAT A DENIED GUARD STILL ANSWERS. The
 * not-found and archived guards each used to end the transaction with a
 * hand-rolled mid-flight ROLLBACK and RETURN the envelope rather than throw.
 * The port (issue 1209) expresses them as `control.abort(envelope)` inside
 * `withTransaction`, which is a rollback with a returned value; nothing else in
 * the suite pins those strings, so a regression there would be silent. The
 * third test pins the commit path, because an abort that swallowed the ordinary
 * return would look identical to a guard firing.
 *
 * The third guard, the content-hash collision, is NOT covered here: reaching it
 * needs a real embedding provider to produce the matching hash, and this suite
 * runs with `embedFn` returning null. It stays unpinned, and that is stated
 * rather than implied.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it (operator
 * ruling 2026-08-27, issue #878). It must point at an isolated test/playground
 * database, never the dogfood database. `bun run test:isolated` sets it.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { registerUpdateEntryTool } from "./update-entry.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const NAMESPACE = `update-entry-pg-${process.pid}`;

interface CallOutcome {
  isError: boolean;
  text: string;
}

async function callUpdate(args: Record<string, unknown>): Promise<CallOutcome> {
  const server = new McpServer({ name: "update-entry-test", version: "1.0.0" });
  registerUpdateEntryTool(server, {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
    embeddingModel: "update-entry-test",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { role: "agent", clientId: NAMESPACE, namespaceSource: "token" },
    } as never);
  const client = new Client({ name: "update-entry-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "update_entry", arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    return { isError: result.isError === true, text };
  } finally {
    await client.close();
    await server.close();
  }
}

/** Ids of the seeded rows, filled by the module-scope `beforeAll`. */
let liveId = "";
let archivedId = "";

beforeAll(async () => {
  const live = await pool.query(
    `INSERT INTO thoughts (content, namespace, created_by) VALUES ($1, $2, $2) RETURNING id`,
    ["the row this suite updates", NAMESPACE],
  );
  liveId = live.rows[0].id;
  const archived = await pool.query(
    `INSERT INTO thoughts (content, namespace, created_by, archived_at)
     VALUES ($1, $2, $2, NOW()) RETURNING id`,
    ["an already archived row", NAMESPACE],
  );
  archivedId = archived.rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM thoughts WHERE namespace = $1`, [NAMESPACE]);
  await pool.end();
});

describe("update_entry early-return guards (live Postgres)", () => {
  test("an unknown id answers Not found and writes nothing", async () => {
    const outcome = await callUpdate({
      table: "thoughts",
      id: "00000000-0000-0000-0000-000000000000",
      content: "never applied",
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("Not found");
  });

  test("an archived row is refused and stays archived", async () => {
    const outcome = await callUpdate({
      table: "thoughts",
      id: archivedId,
      content: "never applied",
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("Entry is archived -- restore it first");
    const { rows } = await pool.query(`SELECT content FROM thoughts WHERE id = $1`, [
      archivedId,
    ]);
    expect(rows[0].content).toBe("an already archived row");
  });

  test("the happy path commits, so the guards above are the only refusals", async () => {
    const outcome = await callUpdate({
      table: "thoughts",
      id: liveId,
      content: "updated by the suite",
    });
    expect(outcome.isError).toBe(false);
    const { rows } = await pool.query(`SELECT content FROM thoughts WHERE id = $1`, [
      liveId,
    ]);
    expect(rows[0].content).toBe("updated by the suite");
  });
});
