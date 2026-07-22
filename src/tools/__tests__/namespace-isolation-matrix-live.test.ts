import { afterAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Pool } from "pg";
import { registerArchiveEntry } from "../archive-entry.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

// Live-Postgres anchor for the #297 negative matrix: the mock matrix proves
// SQL/param shape; this suite proves real Postgres evaluation of the
// namespace predicate leaves a foreign-namespace row truly untouched, and
// that the same call succeeds for the owning namespace (so the negative
// result is not vacuous).

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

dbDescribe("namespace isolation negative matrix (live Postgres, #297)", () => {
  const pool = new Pool({ connectionString: DB_URL });
  const victimNamespace = "matrix-live-victim-ns";
  const callerNamespace = "matrix-live-caller-ns";

  async function callArchiveEntry(
    auth: AuthInfo,
    arguments_: Record<string, unknown>,
  ) {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: pool as any,
      embedFn: async () => null,
    };
    registerArchiveEntry(server, deps);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message: any, options?: any) =>
      originalSend(message, { ...options, authInfo: auth });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return await client.callTool({
        name: "archive_entry",
        arguments: arguments_,
      });
    } finally {
      await client.close();
      await server.close();
    }
  }

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM thoughts WHERE namespace = ANY($1)", [
      [victimNamespace, callerNamespace],
    ]);
  }

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("header-scoped identity cannot archive a foreign-namespace row under real predicate evaluation", async () => {
    await cleanup();
    const { rows } = await pool.query(
      `INSERT INTO thoughts (content, created_by, namespace)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["matrix live isolation seed row", "matrix-live-test", victimNamespace],
    );
    const seededId = rows[0].id as string;

    // (1) Foreign header-scoped caller: content-free denial, row untouched.
    const denied = await callArchiveEntry(
      {
        role: "admin",
        clientId: callerNamespace,
        namespaceSource: "header",
      },
      { table: "thoughts", id: seededId },
    );
    expect(denied.isError).toBeUndefined();
    const deniedText = (denied.content as Array<{ text: string }>)[0]!.text;
    expect(deniedText).toBe("Already archived or not found");
    expect(deniedText).not.toContain(victimNamespace);

    const { rows: afterDenial } = await pool.query(
      "SELECT archived_at FROM thoughts WHERE id = $1",
      [seededId],
    );
    expect(afterDenial.length).toBe(1);
    expect(afterDenial[0].archived_at).toBeNull();

    // (2) Owning header-scoped caller: the identical call succeeds, proving
    // the denial above came from the namespace predicate, not a vacuous test.
    const allowed = await callArchiveEntry(
      {
        role: "admin",
        clientId: victimNamespace,
        namespaceSource: "header",
      },
      { table: "thoughts", id: seededId },
    );
    expect(allowed.isError).toBeUndefined();
    const allowedText = (allowed.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(allowedText)).toEqual({
      id: seededId,
      table: "thoughts",
      archived: true,
    });

    const { rows: afterArchive } = await pool.query(
      "SELECT archived_at FROM thoughts WHERE id = $1",
      [seededId],
    );
    expect(afterArchive.length).toBe(1);
    expect(afterArchive[0].archived_at).not.toBeNull();
  });
});
