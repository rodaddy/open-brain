/**
 * Live-Postgres namespace-isolation tests for `get_entity`.
 *
 * The parity fixture only freezes the not-found shape, which a query with NO
 * namespace predicate would satisfy just as well as a correct one -- the two
 * are indistinguishable until a real row exists in a foreign namespace. These
 * tests seed exactly that row, so a dropped predicate fails here instead of
 * leaking across namespaces in production.
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
import { registerEntityTools } from "./entities.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const NAMESPACE = `entities-pg-${process.pid}`;
const FOREIGN_NAMESPACE = `${NAMESPACE}-foreign`;

async function getEntity(
  namespace: string,
  id: string,
): Promise<{ isError: boolean; text: string }> {
  const server = new McpServer({ name: "entities-test", version: "1.0.0" });
  registerEntityTools(server, {
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
  const client = new Client({ name: "entities-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "get_entity",
      arguments: { id },
    });
    return {
      isError: result.isError === true,
      text: (result.content as Array<{ text: string }>)[0]?.text ?? "",
    };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("get_entity namespace isolation (live Postgres)", () => {
  let ownId = "";
  let foreignId = "";
  let archivedId = "";

  beforeAll(async () => {
    const own = await pool.query(
      `INSERT INTO ob_entities (entity_type, name, namespace, created_by)
       VALUES ('service', 'own entity', $1, $1) RETURNING id`,
      [NAMESPACE],
    );
    ownId = own.rows[0].id;
    const foreign = await pool.query(
      `INSERT INTO ob_entities (entity_type, name, namespace, created_by)
       VALUES ('service', 'foreign entity', $1, $1) RETURNING id`,
      [FOREIGN_NAMESPACE],
    );
    foreignId = foreign.rows[0].id;
    const archived = await pool.query(
      `INSERT INTO ob_entities (entity_type, name, namespace, created_by, archived_at)
       VALUES ('service', 'archived entity', $1, $1, NOW()) RETURNING id`,
      [NAMESPACE],
    );
    archivedId = archived.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM ob_entities WHERE namespace = ANY($1::text[])`,
      [[NAMESPACE, FOREIGN_NAMESPACE]],
    );
    await pool.end();
  });

  test("returns an entity in the caller's own namespace", async () => {
    const result = await getEntity(NAMESPACE, ownId);
    expect(result.isError).toBe(false);
    const entity = JSON.parse(result.text);
    expect(entity.id).toBe(ownId);
    expect(entity.namespace).toBe(NAMESPACE);
    expect(entity.name).toBe("own entity");
  });

  test("refuses an entity in a namespace the caller cannot read", async () => {
    const result = await getEntity(NAMESPACE, foreignId);
    // Identical to a genuine miss: the caller never learns the row exists.
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Entity not found");
  });

  test("does not return an archived entity", async () => {
    const result = await getEntity(NAMESPACE, archivedId);
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Entity not found");
  });
});
