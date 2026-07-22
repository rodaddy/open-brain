import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerArchiveEntry } from "../archive-entry.ts";
import { registerBulkArchive } from "../bulk-archive.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

// Cross-surface negative matrix for #297: a delete-capable identity whose
// namespace authority is header-bound must not be able to archive rows in
// another namespace, and the denial must be content-free (no namespace names,
// no row content in the response). Per-tool positive tests live next to each
// tool; this file pins the isolation boundary itself.

const FOREIGN_ROW_ID = "550e8400-e29b-41d4-a716-446655440000";

function headerScopedAuth(namespace: string): AuthInfo {
  return {
    role: "admin",
    clientId: namespace,
    namespaceSource: "header",
  };
}

async function setupToolClient(
  register: (server: McpServer, deps: ToolDeps) => void,
  mockPool: Record<string, unknown>,
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool: mockPool as any,
    embedFn: async () => Array(768).fill(0.1),
  };
  register(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message: any, options?: any) =>
    originalSend(message, { ...options, authInfo: auth });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("namespace isolation negative matrix (#297)", () => {
  it("archive_entry: header-scoped identity cannot archive a foreign-namespace row and the noop is content-free", async () => {
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const mockPool = {
      // Foreign-namespace row: the namespace predicate excludes it, so the
      // UPDATE matches zero rows regardless of the row existing.
      query: async (sql: string, params: unknown[]) => {
        captured.push({ sql, params });
        return { rows: [] };
      },
    };
    const auth = headerScopedAuth("bilby");
    const { client, cleanup } = await setupToolClient(
      registerArchiveEntry,
      mockPool,
      auth,
    );

    try {
      const result = await client.callTool({
        name: "archive_entry",
        arguments: { table: "thoughts", id: FOREIGN_ROW_ID },
      });

      // The UPDATE carried the auth-derived namespace predicate bound to the
      // caller's own namespace only.
      expect(captured.length).toBe(1);
      expect(captured[0]!.sql).toContain("AND namespace = ANY($2::text[])");
      expect(captured[0]!.params).toEqual([FOREIGN_ROW_ID, ["bilby"]]);

      // Denial is indistinguishable from not-found and leaks nothing.
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(text).toBe("Already archived or not found");
      expect(text).not.toContain("bilby");
      expect(result.isError).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("bulk_archive: header-scoped identity archives zero foreign-namespace rows inside the transaction", async () => {
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const mockClient = {
      query: async (sql: string, params?: unknown[]) => {
        if (params !== undefined) captured.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const mockPool = {
      connect: async () => mockClient,
    };
    const auth = headerScopedAuth("bilby");
    const { client, cleanup } = await setupToolClient(
      registerBulkArchive,
      mockPool,
      auth,
    );

    try {
      const result = await client.callTool({
        name: "bulk_archive",
        arguments: {
          entries: [
            { table: "thoughts", id: FOREIGN_ROW_ID },
            { table: "decisions", id: "660e8400-e29b-41d4-a716-446655440001" },
          ],
        },
      });

      // Every per-entry UPDATE carried the caller-bound namespace predicate.
      expect(captured.length).toBe(2);
      for (const call of captured) {
        expect(call.sql).toContain("AND namespace = ANY($2::text[])");
        expect(call.params[1]).toEqual(["bilby"]);
      }

      // Zero rows archived, reported truthfully and content-free.
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(JSON.parse(text)).toEqual({ requested: 2, archived: 0 });
      expect(text).not.toContain("bilby");
    } finally {
      await cleanup();
    }
  });

  it("token-sourced non-delete role is stopped at the permission gate before any SQL", async () => {
    let queries = 0;
    const mockPool = {
      query: async () => {
        queries += 1;
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(
      registerArchiveEntry,
      mockPool,
      auth,
    );

    try {
      const result = await client.callTool({
        name: "archive_entry",
        arguments: { table: "thoughts", id: FOREIGN_ROW_ID },
      });

      expect(result.isError).toBe(true);
      expect(queries).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
