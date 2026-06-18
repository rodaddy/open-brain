import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAccessReport } from "../access-report.ts";
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
  registerAccessReport(server, deps);

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

describe("access_report", () => {
  it("returns access report for a valid entry", async () => {
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("SELECT id FROM")) {
          return { rows: [{ id: "550e8400-e29b-41d4-a716-446655440000" }] };
        }
        if (sql.includes("COUNT(*) AS total")) {
          return { rows: [{ total: "25" }] };
        }
        if (sql.includes("DISTINCT query_text")) {
          return { rows: [{ unique_queries: "8" }] };
        }
        if (sql.includes("DISTINCT accessed_by")) {
          return { rows: [{ unique_agents: "3" }] };
        }
        if (sql.includes("recent_7d")) {
          return { rows: [{ recent_7d: "10", previous_7d: "5" }] };
        }
        if (sql.includes("MAX(accessed_at)")) {
          return { rows: [{ last_accessed: new Date().toISOString() }] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "access_report",
        arguments: {
          entry_id: "550e8400-e29b-41d4-a716-446655440000",
          days: 30,
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.entry_id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(parsed.source_table).toBe("thoughts");
      expect(parsed.total_accesses).toBe(25);
      expect(parsed.unique_queries).toBe(8);
      expect(parsed.unique_agents).toBe(3);
      expect(parsed.trend).toBe("rising");
      expect(parsed.last_accessed).toBeDefined();
      expect(parsed.days_since_last_access).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("returns stable trend when recent equals previous", async () => {
    const mockPool = {
      query: async (sql: string) => {
        if (sql.includes("SELECT id FROM")) {
          return { rows: [{ id: "550e8400-e29b-41d4-a716-446655440001" }] };
        }
        if (sql.includes("COUNT(*) AS total")) return { rows: [{ total: "10" }] };
        if (sql.includes("DISTINCT query_text")) return { rows: [{ unique_queries: "5" }] };
        if (sql.includes("DISTINCT accessed_by")) return { rows: [{ unique_agents: "2" }] };
        if (sql.includes("recent_7d")) return { rows: [{ recent_7d: "5", previous_7d: "5" }] };
        if (sql.includes("MAX(accessed_at)")) return { rows: [{ last_accessed: null }] };
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "access_report",
        arguments: { entry_id: "550e8400-e29b-41d4-a716-446655440001" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.trend).toBe("stable");
    } finally {
      await cleanup();
    }
  });

  it("requires the reported entry to be in a readable namespace", async () => {
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
        name: "access_report",
        arguments: { entry_id: "550e8400-e29b-41d4-a716-446655440010" },
      });

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("not readable");
      expect(calls[0]!.sql).toContain("namespace = ANY($2::text[])");
      expect(calls[0]!.params).toEqual([
        "550e8400-e29b-41d4-a716-446655440010",
        ["bilby", "shared-kb"],
      ]);
      expect(calls.every((call) => !call.sql.includes("entry_access_log"))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("denies unauthenticated requests", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const mockPool = { query: async () => ({ rows: [] }) };
    const deps: ToolDeps = { pool: mockPool as any, embedFn: createMockEmbed() };
    registerAccessReport(server, deps);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "access_report",
        arguments: { entry_id: "550e8400-e29b-41d4-a716-446655440002" },
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
