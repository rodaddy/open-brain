/**
 * Live-Postgres proof that the read tools write `entry_access_log` (issue 1486).
 *
 * The log's last production row was 2026-08-08: `search_brain` and
 * `session_load` moved to server/ without the writers the legacy tools carried,
 * so the tiering promotion scan and `access_report` read a log nothing grew.
 * Each test performs the read through the registered tool and then reads the
 * log with its own pool, asserting one row with the context the removed writer
 * used ('search' carrying the query text, 'session_load' carrying none).
 *
 * The writes are fire-and-forget, as the removed ones were, so the assertions
 * poll the log briefly rather than reading it once.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL` and fails hard without it (operator
 * ruling 2026-08-27, issue #878). It must point at an isolated test database,
 * never the dogfood database.
 */
import { afterAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { registerSearchBrainTool } from "./search-brain.ts";
import { registerSessionSaveLoadTools } from "./session-save-load.ts";
import { DEFAULT_SHARED_NAMESPACE_NAMES } from "./shared-namespace-fixture.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const NAMESPACE = `access-log-pg-${process.pid}`;

interface AccessRow {
  source_table: string;
  context: string;
  query_text: string | null;
  accessed_by: string | null;
}

/** Call one tool as an agent whose namespace is {@link NAMESPACE}. */
async function callTool(name: string, args: Record<string, unknown>): Promise<void> {
  const server = new McpServer({ name: "access-log-test", version: "1.0.0" });
  const dependencies = {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
    sharedNamespaceNames: DEFAULT_SHARED_NAMESPACE_NAMES,
  };
  registerSearchBrainTool(server, dependencies);
  registerSessionSaveLoadTools(server, dependencies);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { role: "agent", clientId: NAMESPACE, namespaceSource: "token" },
    } as never);
  const client = new Client({ name: "access-log-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBeFalsy();
  } finally {
    await client.close();
    await server.close();
  }
}

/** The log rows for one entry, polled until present or two seconds pass. */
async function accessRows(entryId: string): Promise<AccessRow[]> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const { rows } = await pool.query<AccessRow>(
      `SELECT source_table, context, query_text, accessed_by
         FROM entry_access_log WHERE entry_id = $1`,
      [entryId],
    );
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

async function seedId(sql: string, values: unknown[]): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(sql, values);
  const id = rows[0]?.id;
  if (!id) throw new Error("seed insert returned no id");
  return id;
}

describe("entry_access_log writer (live Postgres)", () => {
  const seeded: string[] = [];

  afterAll(async () => {
    await pool.query(`DELETE FROM entry_access_log WHERE entry_id = ANY($1::uuid[])`, [
      seeded,
    ]);
    await pool.query(`DELETE FROM thoughts WHERE namespace = $1`, [NAMESPACE]);
    await pool.query(`DELETE FROM sessions WHERE namespace = $1`, [NAMESPACE]);
    await pool.end();
  });

  test("search_brain logs each returned entry with context 'search'", async () => {
    const query = "zanzibarquokka";
    const id = await seedId(
      `INSERT INTO thoughts (content, namespace, created_by)
         VALUES ($1, $2, $2) RETURNING id`,
      [`access log probe ${query}`, NAMESPACE],
    );
    seeded.push(id);

    await callTool("search_brain", {
      query,
      table: "thoughts",
      search_mode: "keyword",
      limit: 5,
    });

    expect(await accessRows(id)).toEqual([
      {
        source_table: "thoughts",
        context: "search",
        query_text: query,
        accessed_by: NAMESPACE,
      },
    ]);
  });

  test("session_load logs the loaded session with context 'session_load'", async () => {
    const project = `${NAMESPACE}-project`;
    const id = await seedId(
      `INSERT INTO sessions (project, summary, namespace, created_by)
         VALUES ($1, 'access log probe session', $2, $2) RETURNING id`,
      [project, NAMESPACE],
    );
    seeded.push(id);

    await callTool("session_load", { project });

    expect(await accessRows(id)).toEqual([
      {
        source_table: "sessions",
        context: "session_load",
        query_text: null,
        accessed_by: NAMESPACE,
      },
    ]);
  });
});
