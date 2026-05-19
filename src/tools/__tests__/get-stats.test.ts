import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerGetStats } from "../get-stats.ts";
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
  registerGetStats(server, deps);

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

describe("get_stats", () => {
  it("returns aggregate stats for admin role", async () => {
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("COUNT(*) FILTER")) {
          return { rows: [{ table_name: "thoughts", active: "10", archived: "2" }] };
        }
        if (sql.includes("GROUP BY tier")) {
          return { rows: [{ table_name: "thoughts", tier: "warm", count: "8" }] };
        }
        if (sql.includes("GROUP BY namespace")) {
          return { rows: [{ table_name: "thoughts", namespace: "collab", count: "10" }] };
        }
        if (sql.includes("total_log_entries")) {
          return { rows: [{ total_log_entries: "50", unique_entries_accessed: "20" }] };
        }
        if (sql.includes("AVG")) {
          return { rows: [{ avg_access: "3.5" }] };
        }
        if (sql.includes("access_count, 0) = 0")) {
          return { rows: [{ table_name: "thoughts", count: "4" }] };
        }
        if (sql.includes("ORDER BY access_count DESC")) {
          return { rows: [{ id: "uuid-1", table_name: "thoughts", content_preview: "test content", access_count: "15" }] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "get_stats",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.entry_counts).toBeDefined();
      expect(parsed.tier_distribution).toBeDefined();
      expect(parsed.access_stats).toBeDefined();
      expect(parsed.top_accessed).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("denies readonly with no tables", async () => {
    const mockPool = {
      query: async () => ({ rows: [] }),
    };
    const auth: AuthInfo = { role: "discord", clientId: "discord-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "get_stats",
        arguments: {},
      });

      // discord role can only write thoughts, not read
      expect(result.isError).toBe(true);
      const text = (result.content as any)[0].text;
      expect(text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });
});
