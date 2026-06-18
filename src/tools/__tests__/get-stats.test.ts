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
        if (sql.includes("FROM ob_entities") && sql.includes("GROUP BY entity_type")) {
          return { rows: [{ entity_type: "project", count: "3" }] };
        }
        if (sql.includes("FROM ob_entities")) {
          return { rows: [{ total: "3" }] };
        }
        if (sql.includes("FROM ob_links")) {
          return { rows: [{ total: "5" }] };
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
      expect(parsed.graph_counts).toEqual({
        entities: 3,
        links: 5,
        entity_types: [{ entity_type: "project", count: 3 }],
      });
      expect(parsed.top_accessed).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("scopes aggregate queries to readable namespaces", async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        if (sql.includes("COUNT(*) FILTER")) {
          return { rows: [{ table_name: "thoughts", active: "1", archived: "0" }] };
        }
        if (sql.includes("GROUP BY tier")) {
          return { rows: [] };
        }
        if (sql.includes("GROUP BY namespace")) {
          return { rows: [] };
        }
        if (sql.includes("total_log_entries")) {
          return { rows: [{ total_log_entries: "1", unique_entries_accessed: "1" }] };
        }
        if (sql.includes("AVG")) {
          return { rows: [{ avg_access: "0" }] };
        }
        if (sql.includes("access_count, 0) = 0")) {
          return { rows: [{ table_name: "thoughts", count: "0" }] };
        }
        if (sql.includes("ORDER BY access_count DESC")) {
          return { rows: [] };
        }
        if (sql.includes("FROM ob_entities") && sql.includes("GROUP BY entity_type")) {
          return { rows: [] };
        }
        if (sql.includes("FROM ob_entities")) {
          return { rows: [{ total: "0" }] };
        }
        if (sql.includes("FROM ob_links")) {
          return { rows: [{ total: "0" }] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "get_stats",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const countCall = calls.find((call) => call.sql.includes("COUNT(*) FILTER"));
      expect(countCall!.sql).toContain("WHERE namespace = ANY($1::text[])");
      expect(countCall!.params).toEqual([["bilby", "collab"]]);
      const accessCall = calls.find((call) => call.sql.includes("total_log_entries"));
      expect(accessCall!.sql).toContain("source.namespace = ANY($1::text[])");
      expect(accessCall!.sql).toContain("source.namespace = ANY($5::text[])");
      expect(accessCall!.params).toEqual([
        ["bilby", "collab"],
        ["bilby", "collab"],
        ["bilby", "collab"],
        ["bilby", "collab"],
        ["bilby", "collab"],
      ]);
      const topAccessedCall = calls.find((call) =>
        call.sql.includes("ORDER BY access_count DESC")
      );
      expect(topAccessedCall!.sql).toContain("namespace = ANY($1::text[])");
      expect(topAccessedCall!.params).toEqual([
        ["bilby", "collab"],
        ["bilby", "collab"],
        ["bilby", "collab"],
        ["bilby", "collab"],
        ["bilby", "collab"],
      ]);
      const entityCountCall = calls.find((call) =>
        call.sql.includes("FROM ob_entities") && call.sql.includes("COUNT(*) AS total")
      );
      expect(entityCountCall!.sql).toContain("WHERE namespace = ANY($1::text[])");
      expect(entityCountCall!.params).toEqual([["bilby", "collab"]]);
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
