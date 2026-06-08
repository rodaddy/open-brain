import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSetTier } from "../set-tier.ts";
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
  registerSetTier(server, deps);

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

describe("set_tier", () => {
  describe("admin role -- set tier to hot", () => {
    it("returns { id, table, tier: 'hot' }", async () => {
      const mockPool = {
        query: async () => ({ rows: [{ id: "test-uuid", tier: "hot" }] }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "set_tier",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440000",
            tier: "hot",
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("test-uuid");
        expect(parsed.table).toBe("thoughts");
        expect(parsed.tier).toBe("hot");
      } finally {
        await cleanup();
      }
    });
  });

  describe("admin role -- set tier to cold", () => {
    it("returns tier: 'cold'", async () => {
      const mockPool = {
        query: async () => ({
          rows: [{ id: "cold-uuid", tier: "cold" }],
        }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "set_tier",
          arguments: {
            table: "decisions",
            id: "550e8400-e29b-41d4-a716-446655440001",
            tier: "cold",
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.tier).toBe("cold");
      } finally {
        await cleanup();
      }
    });
  });

  describe("admin role -- reset tier to warm", () => {
    it("returns tier: 'warm' (default)", async () => {
      const mockPool = {
        query: async () => ({
          rows: [{ id: "warm-uuid", tier: "warm" }],
        }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "set_tier",
          arguments: {
            table: "sessions",
            id: "550e8400-e29b-41d4-a716-446655440002",
            tier: "warm",
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.tier).toBe("warm");
      } finally {
        await cleanup();
      }
    });
  });

  describe("agent role -- has write permission", () => {
    it("succeeds because agent can write to thoughts", async () => {
      const mockPool = {
        query: async () => ({
          rows: [{ id: "agent-uuid", tier: "hot" }],
        }),
      };
      const auth: AuthInfo = { role: "agent", clientId: "agent-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "set_tier",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440003",
            tier: "hot",
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.tier).toBe("hot");
      } finally {
        await cleanup();
      }
    });
  });

  describe("readonly role -- permission denied", () => {
    it("returns isError because readonly cannot write", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      const auth: AuthInfo = { role: "readonly", clientId: "ro-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "set_tier",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440004",
            tier: "hot",
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

  describe("not found or archived -- 0 rows affected", () => {
    it("returns 'Entry not found or archived' when UPDATE returns 0 rows", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "set_tier",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440005",
            tier: "cold",
          },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Entry not found or archived");
      } finally {
        await cleanup();
      }
    });
  });
});
