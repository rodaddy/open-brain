/**
 * Live-Postgres behavior tests for `session_save` (issue 831).
 *
 * The tool's response reports `id`, `merged`, and `embedded`; none of that
 * proves the ROW. A save that wrote the wrong column, dropped the namespace,
 * or overwrote a neighbouring namespace's row returns exactly the same
 * envelope. These tests call the registered tool through an in-memory MCP
 * transport and then read the `sessions` row back with their own pool, so the
 * assertions are on stored state rather than on what the handler said.
 *
 * Harness mirrors `server/tools/session-lifecycle.pg.test.ts`.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL` and fails hard without it (operator
 * ruling 2026-08-27, issue #878). It must point at an isolated test/playground
 * database, never the dogfood database.
 */
import { afterAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { registerSessionSaveLoadTools } from "./session-save-load.ts";
import { contentHash } from "./memory-helpers.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const NAMESPACE = `session-save-pg-${process.pid}`;
const OTHER_NAMESPACE = `${NAMESPACE}-other`;
const EMBEDDING_MODEL = "test-embed-768";

interface SaveEnvelope {
  id: string;
  namespace: string;
  session_id?: string;
  embedded: boolean;
  merged: boolean;
}

/** A deterministic unit vector of the stored 768-dim width. */
function fakeEmbedding(): number[] {
  return Array.from({ length: 768 }, (_, i) => (i % 7) / 10);
}

async function callSave(
  args: Record<string, unknown>,
  options: { namespace?: string; embed?: boolean } = {},
): Promise<SaveEnvelope> {
  const namespace = options.namespace ?? NAMESPACE;
  const server = new McpServer({
    name: "session-save-load-test",
    version: "1.0.0",
  });
  registerSessionSaveLoadTools(server, {
    pool,
    embedFn: async () => (options.embed ? fakeEmbedding() : null),
    embeddingModel: EMBEDDING_MODEL,
    logger: pino({ level: "silent" }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, sendOptions) =>
    originalSend(message, {
      ...sendOptions,
      authInfo: {
        role: "agent",
        clientId: namespace,
        namespaceSource: "token",
      },
    } as never);
  const client = new Client({
    name: "session-save-load-test",
    version: "1.0.0",
  });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const result = await client.callTool({
    name: "session_save",
    arguments: args,
  });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  await client.close();
  return JSON.parse(text) as SaveEnvelope;
}

async function readRows(
  namespace: string,
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await pool.query(
    `SELECT id, session_id, project, summary, tags, created_by, namespace,
            content_hash, embedding, embedded_at, embedding_model
       FROM sessions
      WHERE namespace = $1 AND session_id = $2`,
    [namespace, sessionId],
  );
  return rows.rows;
}

/** The single row for (namespace, session_id), failing loudly if it is absent. */
async function readOneRow(
  namespace: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const rows = await readRows(namespace, sessionId);
  expect(rows.length).toBe(1);
  const row = rows[0];
  if (!row) throw new Error(`no sessions row for ${namespace}/${sessionId}`);
  return row;
}

describe("session_save writes the row it claims (live Postgres)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM sessions WHERE namespace = ANY($1)`, [
      [NAMESPACE, OTHER_NAMESPACE],
    ]);
    await pool.end();
  });

  test("stores summary, project, tags, namespace, and the content hash", async () => {
    const sessionId = `${NAMESPACE}-basic`;
    const summary = "lane 6 proved the row";
    const project = "open-brain";
    const saved = await callSave({
      summary,
      project,
      session_id: sessionId,
      tags: ["issue-831", "pg"],
    });

    expect(saved.merged).toBe(false);
    expect(saved.embedded).toBe(false);
    expect(saved.namespace).toBe(NAMESPACE);

    const row = await readOneRow(NAMESPACE, sessionId);
    expect(row.summary).toBe(summary);
    expect(row.project).toBe(project);
    expect(row.tags).toEqual(["issue-831", "pg"]);
    expect(row.created_by).toBe(NAMESPACE);
    expect(row.namespace).toBe(NAMESPACE);
    expect(row.content_hash).toBe(contentHash(`${summary}|${project}`));
    expect(row.embedding).toBeNull();
    expect(row.embedded_at).toBeNull();
    expect(row.embedding_model).toBeNull();
  });

  test("the same session_id merges into one row rather than adding a second", async () => {
    const sessionId = `${NAMESPACE}-merge`;
    const first = await callSave({
      summary: "first pass",
      project: "open-brain",
      session_id: sessionId,
    });
    expect(first.merged).toBe(false);

    const second = await callSave({
      summary: "second pass",
      project: "open-brain",
      session_id: sessionId,
    });
    expect(second.merged).toBe(true);

    const row = await readOneRow(NAMESPACE, sessionId);
    expect(row.summary).toBe("second pass");
  });

  test("a foreign namespace saving the same session_id gets its own row", async () => {
    const sessionId = `${NAMESPACE}-shared-id`;
    await callSave({
      summary: "owned by the first namespace",
      project: "open-brain",
      session_id: sessionId,
    });
    const foreign = await callSave(
      {
        summary: "owned by the second namespace",
        project: "open-brain",
        session_id: sessionId,
      },
      { namespace: OTHER_NAMESPACE },
    );

    expect(foreign.merged).toBe(false);
    expect(foreign.namespace).toBe(OTHER_NAMESPACE);

    const mine = await readOneRow(NAMESPACE, sessionId);
    const theirs = await readOneRow(OTHER_NAMESPACE, sessionId);
    expect(mine.id).not.toBe(theirs.id);
    // The first namespace's row is untouched by the foreign write.
    expect(mine.summary).toBe("owned by the first namespace");
    expect(mine.created_by).toBe(NAMESPACE);
  });

  test("an embedding vector lands with its model and timestamp", async () => {
    const sessionId = `${NAMESPACE}-embedded`;
    const saved = await callSave(
      {
        summary: "embedded save",
        project: "open-brain",
        session_id: sessionId,
      },
      { embed: true },
    );
    expect(saved.embedded).toBe(true);

    const row = await readOneRow(NAMESPACE, sessionId);
    expect(row.embedding).not.toBeNull();
    expect(row.embedding_model).toBe(EMBEDDING_MODEL);
    expect(row.embedded_at).not.toBeNull();
  });
});
