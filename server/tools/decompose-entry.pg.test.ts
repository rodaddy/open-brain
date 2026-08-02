/**
 * Live-Postgres behavior tests for the ported `decompose_entry`.
 *
 * THE ASSERTION THAT MATTERS IS THAT PLANNING DOES NOT WRITE. The parity
 * fixture freezes the refusal strings, which proves the guards answer but not
 * that the default path leaves the database alone -- so these tests seed a real
 * oversized row, plan against it, and count `thoughts` before and after.
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
import { registerDecomposeEntryTool } from "./decompose-entry.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;
const pool = DB_URL ? new Pool({ connectionString: DB_URL }) : null;

const NAMESPACE = `decompose-pg-${process.pid}`;
const OTHER_NAMESPACE = `${NAMESPACE}-other`;
// Comfortably past CHUNK_THRESHOLD so the planner proposes replacements.
const OVERSIZED = "sentence about the schema design. ".repeat(400);

interface CallOutcome {
  isError: boolean;
  body: Record<string, unknown>;
}

async function callDecompose(
  namespace: string,
  args: Record<string, unknown>,
  role = "agent",
): Promise<CallOutcome> {
  if (!pool) throw new Error("OPENBRAIN_TEST_DATABASE_URL is required");
  const server = new McpServer({ name: "decompose-test", version: "1.0.0" });
  registerDecomposeEntryTool(server, {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
    embeddingModel: "decompose-test",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { role, clientId: namespace, namespaceSource: "token" },
    } as never);
  const client = new Client({ name: "decompose-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "decompose_entry", arguments: args });
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

async function countThoughts(namespace: string): Promise<number> {
  const { rows } = await pool!.query(
    `SELECT COUNT(*)::int AS cnt FROM thoughts WHERE namespace = $1`,
    [namespace],
  );
  return rows[0].cnt;
}

dbDescribe("decompose_entry (live Postgres)", () => {
  let sourceId = "";
  let foreignId = "";

  beforeAll(async () => {
    const source = await pool!.query(
      `INSERT INTO thoughts (content, namespace, created_by) VALUES ($1, $2, $2) RETURNING id`,
      [OVERSIZED, NAMESPACE],
    );
    sourceId = source.rows[0].id;
    const foreign = await pool!.query(
      `INSERT INTO thoughts (content, namespace, created_by) VALUES ($1, $2, $2) RETURNING id`,
      [OVERSIZED, OTHER_NAMESPACE],
    );
    foreignId = foreign.rows[0].id;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM thoughts WHERE namespace = ANY($1::text[])`, [
      [NAMESPACE, OTHER_NAMESPACE],
    ]);
    await pool.end();
  });

  test("the default call plans and writes NOTHING", async () => {
    const before = await countThoughts(NAMESPACE);
    const { isError, body } = await callDecompose(NAMESPACE, {
      table: "thoughts",
      id: sourceId,
    });
    expect(isError).toBe(false);
    expect(body.status).toBe("planned");
    expect(body.dry_run).toBe(true);
    expect(body.oversized).toBe(true);
    expect(body.would_write as number).toBeGreaterThan(0);
    // The planner proposed writes and the database is untouched.
    expect(await countThoughts(NAMESPACE)).toBe(before);
  });

  test("dry_run=false without apply_mode refuses AND writes nothing", async () => {
    const before = await countThoughts(NAMESPACE);
    const { isError, body } = await callDecompose(NAMESPACE, {
      table: "thoughts",
      id: sourceId,
      dry_run: false,
    });
    expect(isError).toBe(true);
    expect(body.text).toBe("dry_run=false requires apply_mode=write_replacements");
    expect(await countThoughts(NAMESPACE)).toBe(before);
  });

  test("reports the frozen chunk-length basis", async () => {
    const { body } = await callDecompose(NAMESPACE, {
      table: "thoughts",
      id: sourceId,
    });
    expect(body.content_length_basis).toBe("trimmed_chunk_text");
    expect(body.source_length_basis).toBe("raw_source_text");
  });

  test("cannot plan against an entry in another namespace", async () => {
    const { isError, body } = await callDecompose(NAMESPACE, {
      table: "thoughts",
      id: foreignId,
    });
    expect(isError).toBe(true);
    // Same text as a genuine miss, so existence is not disclosed.
    expect(body.text).toBe("Entry not found or archived");
  });

  test("an explicit apply writes replacements linked to the source", async () => {
    const before = await countThoughts(NAMESPACE);
    const { isError, body } = await callDecompose(NAMESPACE, {
      table: "thoughts",
      id: sourceId,
      dry_run: false,
      apply_mode: "write_replacements",
    });
    expect(isError).toBe(false);
    expect(body.status).toBe("applied");
    const writtenIds = body.written_ids as string[];
    expect(writtenIds.length).toBeGreaterThan(0);
    expect(await countThoughts(NAMESPACE)).toBe(before + writtenIds.length);

    // parent_id is the joinable lineage; provenance JSON alone is not.
    const { rows } = await pool!.query(
      `SELECT parent_id, chunk_index, source FROM thoughts WHERE id = ANY($1::uuid[]) ORDER BY chunk_index`,
      [writtenIds],
    );
    expect(rows.length).toBe(writtenIds.length);
    for (const row of rows) {
      expect(row.parent_id).toBe(sourceId);
      expect(row.source).toBe("dreamengine-decomposition");
    }
  });

  test("re-applying is idempotent: duplicates are reported, not re-written", async () => {
    const before = await countThoughts(NAMESPACE);
    const { body } = await callDecompose(NAMESPACE, {
      table: "thoughts",
      id: sourceId,
      dry_run: false,
      apply_mode: "write_replacements",
    });
    const summary = body.apply_summary as Record<string, number>;
    expect(body.written_ids as string[]).toHaveLength(0);
    expect(summary.preexisting_duplicate_count).toBeGreaterThan(0);
    expect(await countThoughts(NAMESPACE)).toBe(before);
  });

  test("a readonly role cannot apply", async () => {
    const before = await countThoughts(NAMESPACE);
    const { isError, body } = await callDecompose(
      NAMESPACE,
      {
        table: "thoughts",
        id: sourceId,
        dry_run: false,
        apply_mode: "write_replacements",
      },
      "readonly",
    );
    expect(isError).toBe(true);
    expect(String(body.text)).toContain("Permission denied");
    expect(await countThoughts(NAMESPACE)).toBe(before);
  });
});
