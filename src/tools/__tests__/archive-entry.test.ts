import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerArchiveEntry } from "../archive-entry.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

async function setupToolClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: createMockEmbed() };
  registerArchiveEntry(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message: any, options?: any) => {
    return originalSend(message, { ...options, authInfo: auth });
  };

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

describe("archive_entry", () => {
  describe("admin role -- has delete permission", () => {
    it("returns { id, table, archived: true }", async () => {
      const mockPool = {
        query: async () => ({ rows: [{ id: "test-uuid" }] }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "archive_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440000",
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("test-uuid");
        expect(parsed.table).toBe("thoughts");
        expect(parsed.archived).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("uses a namespace predicate for delegated admin", async () => {
      const calls: Array<{ sql: string; params?: any[] }> = [];
      const mockPool = {
        query: async (sql: string, params?: any[]) => {
          calls.push({ sql, params });
          return { rows: [{ id: "test-uuid" }] };
        },
      };
      const auth: AuthInfo = {
        role: "admin",
        clientId: "bilby",
        tokenClientId: "admin",
        namespaceSource: "header",
      };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "archive_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440010",
          },
        });

        expect(result.isError).toBeFalsy();
        expect(calls[0]!.sql).toContain("namespace = ANY($2::text[])");
        expect(calls[0]!.params).toEqual([
          "550e8400-e29b-41d4-a716-446655440010",
          ["bilby"],
        ]);
      } finally {
        await cleanup();
      }
    });
  });

  describe("ob-admin role -- has delete permission", () => {
    it("succeeds because ob-admin has delete on all tables", async () => {
      const mockPool = {
        query: async () => ({ rows: [{ id: "ob-admin-uuid" }] }),
      };
      const auth: AuthInfo = { role: "ob-admin", clientId: "ob-admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "archive_entry",
          arguments: {
            table: "decisions",
            id: "550e8400-e29b-41d4-a716-446655440001",
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.archived).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describe("agent role -- NO delete permission", () => {
    it("returns isError Permission denied", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      const auth: AuthInfo = { role: "agent", clientId: "agent-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "archive_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440002",
          },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });
  });

  describe("readonly role -- NO delete permission", () => {
    it("returns isError Permission denied", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      const auth: AuthInfo = { role: "readonly", clientId: "ro-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "archive_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440003",
          },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });
  });

  describe("no auth", () => {
    it("returns isError Permission denied when auth is missing", async () => {
      const server = new McpServer({ name: "test", version: "1.0.0" });
      const mockPool = { query: async () => ({ rows: [] }) };
      const deps: ToolDeps = {
        pool: mockPool as any,
        embedFn: createMockEmbed(),
      };
      registerArchiveEntry(server, deps);

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      try {
        const result = await client.callTool({
          name: "archive_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440004",
          },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  describe("already archived or not found", () => {
    it("returns 'already archived or not found' when 0 rows returned", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }), // 0 rows = already archived or not found
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "archive_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440005",
          },
        });

        // Not an error -- idempotent behavior
        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        expect(text.toLowerCase()).toContain("already archived or not found");
      } finally {
        await cleanup();
      }
    });
  });
});
