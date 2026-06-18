import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTierRecommendations } from "../tier-recommendations.ts";
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
  registerTierRecommendations(server, deps);

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

describe("tier_recommendations", () => {
  it("returns demote candidates", async () => {
    const mockPool = {
      query: async (sql: string) => {
        if (sql.includes("tier") && sql.includes("warm") && sql.includes("access_count")) {
          return {
            rows: [
              {
                id: "demote-uuid",
                content_preview: "Rarely used thought",
                tier: "warm",
                access_count: "0",
                last_accessed_at: null,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "tier_recommendations",
        arguments: { action: "demote", threshold_days: 30 },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.action).toBe("demote");
      expect(parsed.candidates_found).toBeGreaterThan(0);
      expect(parsed.candidates[0].suggested_tier).toBe("cold");
      expect(parsed.candidates[0].reasoning).toContain("Warm entry");
    } finally {
      await cleanup();
    }
  });

  it("returns promote candidates", async () => {
    const mockPool = {
      query: async (sql: string) => {
        if (sql.includes("recent_accesses")) {
          return {
            rows: [
              {
                id: "promote-uuid",
                content_preview: "Frequently accessed decision",
                tier: "warm",
                access_count: "20",
                last_accessed_at: new Date().toISOString(),
                recent_accesses: "12",
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "tier_recommendations",
        arguments: { action: "promote", threshold_days: 7 },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.action).toBe("promote");
      expect(parsed.candidates[0].suggested_tier).toBe("hot");
    } finally {
      await cleanup();
    }
  });

  it("scopes recommendation reads to readable namespaces", async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "tier_recommendations",
        arguments: { action: "demote", threshold_days: 30 },
      });

      expect(result.isError).toBeFalsy();
      expect(calls[0]!.sql).toContain("namespace = ANY($3::text[])");
      expect(calls[0]!.params).toEqual([30, 20, ["bilby", "shared-kb"]]);
    } finally {
      await cleanup();
    }
  });

  it("scopes promote access counts to the source table", async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "tier_recommendations",
        arguments: {
          action: "promote",
          threshold_days: 7,
        },
      });

      expect(result.isError).toBeFalsy();
      expect(calls).toHaveLength(5);
      expect(calls.every((call) => call.sql.includes("eal.source_table ="))).toBe(true);
      expect(calls.some((call) => call.sql.includes("eal.source_table = 'thoughts'"))).toBe(
        true,
      );
      expect(calls.every((call) => call.sql.includes("namespace = ANY($3::text[])"))).toBe(
        true,
      );
      const scopedParams = JSON.stringify([7, 20, ["bilby", "shared-kb"]]);
      expect(
        calls.every((call) => JSON.stringify(call.params) === scopedParams),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("denies unauthenticated requests", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const mockPool = { query: async () => ({ rows: [] }) };
    const deps: ToolDeps = { pool: mockPool as any, embedFn: createMockEmbed() };
    registerTierRecommendations(server, deps);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "tier_recommendations",
        arguments: { action: "demote" },
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
