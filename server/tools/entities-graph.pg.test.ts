/**
 * Live-Postgres namespace-isolation tests for the ported graph and people tools.
 *
 * The parity fixtures run everything as ONE identity, so they prove the shapes
 * but never cross a namespace boundary -- and an ID-based read or mutation
 * without a namespace predicate is exactly the isolation bug class the repo
 * rules call out. These tests seed rows owned by a foreign namespace and prove
 * each tool refuses to read, list, mutate, or hydrate them.
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
import { registerPeopleTools } from "./people.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const NAMESPACE = `graph-pg-${process.pid}`;
const OTHER_NAMESPACE = `${NAMESPACE}-other`;

async function callTool(
  tool: string,
  namespace: string,
  args: Record<string, unknown>,
  role = "agent",
): Promise<{ isError: boolean; body: unknown }> {
  const server = new McpServer({ name: "graph-test", version: "1.0.0" });
  const dependencies = {
    pool,
    embedFn: async () => Array(768).fill(0.01) as number[],
    logger: pino({ level: "silent" }),
    embeddingModel: "graph-test",
  };
  registerEntityTools(server, dependencies);
  registerPeopleTools(server, dependencies);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { role, clientId: namespace, namespaceSource: "token" },
    } as never);
  const client = new Client({ name: "graph-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { isError: result.isError === true, body };
  } finally {
    await client.close();
    await server.close();
  }
}

/** Ids of the foreign-namespace rows, filled by the module-scope `beforeAll`. */
let foreignEntityId = "";
let foreignLinkTargetId = "";

beforeAll(async () => {
  const foreign = await pool.query(
    `INSERT INTO ob_entities (entity_type, name, namespace, created_by, metadata)
       VALUES ('host', 'foreign-only-entity', $1, $1, '{}'::jsonb) RETURNING id`,
    [OTHER_NAMESPACE],
  );
  foreignEntityId = foreign.rows[0].id;
  const target = await pool.query(
    `INSERT INTO ob_entities (entity_type, name, namespace, created_by, metadata)
       VALUES ('host', 'foreign-link-target', $1, $1, '{}'::jsonb) RETURNING id`,
    [OTHER_NAMESPACE],
  );
  foreignLinkTargetId = target.rows[0].id;
  await pool.query(
    `INSERT INTO ob_links (from_type, from_id, to_type, to_id, relation, weight, namespace, metadata, created_by)
       VALUES ('entity', $1, 'entity', $2, 'relates_to', 1.0, $3, '{}'::jsonb, $3)`,
    [foreignEntityId, foreignLinkTargetId, OTHER_NAMESPACE],
  );
  await pool.query(
    `INSERT INTO relationships (person_name, context, namespace, created_by)
       VALUES ('Foreign Person', 'lives in another lane', $1, $1)`,
    [OTHER_NAMESPACE],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM ob_links WHERE namespace = ANY($1::text[])`, [
    [NAMESPACE, OTHER_NAMESPACE],
  ]);
  await pool.query(
    `DELETE FROM ob_entities WHERE namespace = ANY($1::text[])`,
    [[NAMESPACE, OTHER_NAMESPACE]],
  );
  await pool.query(
    `DELETE FROM relationships WHERE namespace = ANY($1::text[])`,
    [[NAMESPACE, OTHER_NAMESPACE]],
  );
  await pool.end();
});

describe("entity and link tools (live Postgres)", () => {
  test("list_entities never returns a foreign-namespace row", async () => {
    const { isError, body } = await callTool("list_entities", NAMESPACE, {});
    expect(isError).toBe(false);
    const names = (body as Array<{ name: string }>).map((row) => row.name);
    expect(names).not.toContain("foreign-only-entity");
  });

  test("get_entity hides a foreign entity behind the not-found text", async () => {
    const { isError, body } = await callTool("get_entity", NAMESPACE, {
      id: foreignEntityId,
    });
    expect(isError).toBe(true);
    // Identical to a genuine miss, so existence is not disclosed.
    expect(body).toBe("Entity not found");
  });

  test("upsert_entity writes into the caller's lane, not a requested foreign one", async () => {
    const { isError, body } = await callTool("upsert_entity", NAMESPACE, {
      entity_type: "host",
      name: "isolation-probe",
      namespace: OTHER_NAMESPACE,
    });
    expect(isError).toBe(true);
    expect(String(body)).toContain("Permission denied");
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM ob_entities WHERE namespace = $1 AND name = 'isolation-probe'`,
      [OTHER_NAMESPACE],
    );
    expect(rows[0].cnt).toBe(0);
  });

  test("upsert_entity is idempotent on name case within a lane", async () => {
    const first = await callTool("upsert_entity", NAMESPACE, {
      entity_type: "service",
      name: "Case Probe",
    });
    const second = await callTool("upsert_entity", NAMESPACE, {
      entity_type: "service",
      name: "CASE PROBE",
    });
    expect((first.body as { is_new: boolean }).is_new).toBe(true);
    expect((second.body as { is_new: boolean }).is_new).toBe(false);
    expect((second.body as { id: string }).id).toBe(
      (first.body as { id: string }).id,
    );
  });

  test("unlink_entities cannot archive a foreign namespace's link", async () => {
    const { body } = await callTool(
      "unlink_entities",
      NAMESPACE,
      {
        from_type: "entity",
        from_id: foreignEntityId,
        to_type: "entity",
        to_id: foreignLinkTargetId,
        relation: "relates_to",
      },
      "admin",
    );
    // Admin may delete, but the predicate binds to the caller's own lane, so
    // the foreign link is simply not found -- and must remain active.
    expect(body).toBe("Already unlinked or not found");
    const { rows } = await pool.query(
      `SELECT archived_at FROM ob_links WHERE namespace = $1`,
      [OTHER_NAMESPACE],
    );
    expect(rows[0].archived_at).toBeNull();
  });

  test("hydrate_entities does not embed a foreign namespace's entity", async () => {
    const { isError, body } = await callTool("hydrate_entities", NAMESPACE, {
      only_missing_embedding: true,
    });
    expect(isError).toBe(false);
    expect((body as { matched: number }).matched).toBe(0);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM ob_entities
        WHERE namespace = $1 AND embedding IS NOT NULL`,
      [OTHER_NAMESPACE],
    );
    expect(rows[0].cnt).toBe(0);
  });
});

describe("people tools (live Postgres)", () => {
  test("find_person never returns a person from another lane", async () => {
    const { isError, body } = await callTool("find_person", NAMESPACE, {
      query: "Foreign",
    });
    expect(isError).toBe(false);
    // Same text as a genuine miss.
    expect(body).toBe("No people found matching: Foreign");
  });

  test("upsert_person then find_person round-trips inside one lane", async () => {
    const created = await callTool("upsert_person", NAMESPACE, {
      name: "Local Person",
      context: "same lane",
      warmth: 4,
    });
    expect((created.body as { action: string }).action).toBe("created");
    const found = await callTool("find_person", NAMESPACE, { query: "Local" });
    const rows = found.body as Array<{ person_name: string; warmth: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.person_name).toBe("Local Person");
    expect(rows[0]?.warmth).toBe(4);
  });

  test("find_person treats ILIKE wildcards in the query as literal text", async () => {
    // A bare `%` would match every person if it were not escaped.
    const { body } = await callTool("find_person", NAMESPACE, { query: "%" });
    expect(body).toBe("No people found matching: %");
  });
});
