import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerBulkSetTier } from "../bulk-set-tier.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

async function setupToolClient(
  mockPool: any,
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: createMockEmbed() };
  registerBulkSetTier(server, deps);

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

describe("bulk_set_tier", () => {
  it("updates multiple entries in a transaction", async () => {
    const queryCalls: string[] = [];
    const mockClient = {
      query: async (sql: string, _params?: any[]) => {
        queryCalls.push(sql);
        if (sql.includes("UPDATE")) return { rowCount: 1 };
        return { rows: [] };
      },
      release: () => {},
    };
    const mockPool = {
      connect: async () => mockClient,
      query: async () => ({ rows: [] }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "bulk_set_tier",
        arguments: {
          entries: [
            { id: "550e8400-e29b-41d4-a716-446655440000", table: "thoughts", tier: "hot" },
            { id: "550e8400-e29b-41d4-a716-446655440001", table: "decisions", tier: "cold" },
          ],
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.requested).toBe(2);
      expect(parsed.updated).toBe(2);
      expect(queryCalls).toContain("BEGIN");
      expect(queryCalls).toContain("COMMIT");
    } finally {
      await cleanup();
    }
  });

  it("denies readonly role", async () => {
    const mockPool = {
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      query: async () => ({ rows: [] }),
    };
    const auth: AuthInfo = { role: "readonly", clientId: "ro-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "bulk_set_tier",
        arguments: {
          entries: [
            { id: "550e8400-e29b-41d4-a716-446655440000", table: "thoughts", tier: "hot" },
          ],
        },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as any)[0].text;
      expect(text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("rolls back on error", async () => {
    const queryCalls: string[] = [];
    const mockClient = {
      query: async (sql: string) => {
        queryCalls.push(sql);
        if (sql.includes("UPDATE")) throw new Error("DB error");
        return { rows: [] };
      },
      release: () => {},
    };
    const mockPool = {
      connect: async () => mockClient,
      query: async () => ({ rows: [] }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "bulk_set_tier",
        arguments: {
          entries: [
            { id: "550e8400-e29b-41d4-a716-446655440000", table: "thoughts", tier: "hot" },
          ],
        },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as any)[0].text;
      expect(text).toContain("Transaction failed");
      expect(queryCalls).toContain("ROLLBACK");
    } finally {
      await cleanup();
    }
  });
});
