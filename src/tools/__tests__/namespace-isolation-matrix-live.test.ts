/**
 * Live-Postgres anchor for the #297 negative matrix.
 *
 * The mock matrix proves SQL/param shape; this suite proves real Postgres
 * evaluation of the namespace predicate leaves a foreign-namespace row truly
 * untouched, and that the same call succeeds for the owning namespace (so the
 * negative result is not vacuous).
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it (operator
 * ruling 2026-08-27, issue #878). `bun run test:isolated` sets it.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import { registerArchiveEntry } from "../archive-entry.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const victimNamespace = "matrix-live-victim-ns";
const callerNamespace = "matrix-live-caller-ns";

type ToolResult = { isError?: boolean; content?: Array<{ text: string }> };

async function callArchiveEntry(
  auth: AuthInfo,
  arguments_: Record<string, unknown>,
): Promise<ToolResult> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool,
    embedFn: async () => null,
  } as ToolDeps;
  registerArchiveEntry(server, deps);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, { ...options, authInfo: auth } as never);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return (await client.callTool({
      name: "archive_entry",
      arguments: arguments_,
    })) as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

/** First text block of a tool result, or the empty string when there is none. */
function firstText(result: ToolResult): string {
  return result.content?.[0]?.text ?? "";
}

async function cleanup(): Promise<void> {
  await pool.query("DELETE FROM thoughts WHERE namespace = ANY($1)", [
    [victimNamespace, callerNamespace],
  ]);
}

async function seedVictimRow(): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO thoughts (content, created_by, namespace)
     VALUES ($1, $2, $3)
     RETURNING id`,
    ["matrix live isolation seed row", "matrix-live-test", victimNamespace],
  );
  return rows[0].id as string;
}

async function archivedAt(id: string): Promise<Array<{ archived_at: unknown }>> {
  const { rows } = await pool.query(
    "SELECT archived_at FROM thoughts WHERE id = $1",
    [id],
  );
  return rows;
}

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("#297 namespace isolation negative matrix (live Postgres)", () => {
  it("denies a foreign header-scoped caller and leaves the row untouched", async () => {
    await cleanup();
    const seededId = await seedVictimRow();

    const denied = await callArchiveEntry(
      { role: "admin", clientId: callerNamespace, namespaceSource: "header" },
      { table: "thoughts", id: seededId },
    );
    expect(denied.isError).toBeUndefined();
    const deniedText = firstText(denied);
    expect(deniedText).toBe("Already archived or not found");
    expect(deniedText).not.toContain(victimNamespace);

    const after = await archivedAt(seededId);
    expect(after.length).toBe(1);
    expect(after[0]?.archived_at).toBeNull();
  });

  it("lets the owning header-scoped caller archive the same row", async () => {
    await cleanup();
    const seededId = await seedVictimRow();

    const allowed = await callArchiveEntry(
      { role: "admin", clientId: victimNamespace, namespaceSource: "header" },
      { table: "thoughts", id: seededId },
    );
    expect(allowed.isError).toBeUndefined();
    expect(JSON.parse(firstText(allowed))).toEqual({
      id: seededId,
      table: "thoughts",
      archived: true,
    });

    const after = await archivedAt(seededId);
    expect(after.length).toBe(1);
    expect(after[0]?.archived_at).not.toBeNull();
  });
});
