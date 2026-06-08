import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerListStale } from "../list-stale.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

function makeMockRows(count: number = 3) {
  return Array.from({ length: count }, (_, i) => ({
    source_type: "thought",
    id: `uuid-${i}`,
    content_preview: `Stale content ${i}`,
    tags: ["old-tag"],
    tier: "hot",
    access_count: i,
    last_accessed_at: "2026-01-01T00:00:00Z",
    created_at: "2025-12-01T00:00:00Z",
    effective_last_access: "2026-01-01T00:00:00Z",
  }));
}

async function setupToolClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: createMockEmbed() };
  registerListStale(server, deps);

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

describe("list_stale", () => {
  describe("admin role -- no params (defaults)", () => {
    it("returns stale entries from all tables, default days=30, limit=50", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (sql: string, ...rest: any[]) => {
          queryCalls.push([sql, ...rest]);
          if (sql.includes("SUM(cnt)")) return { rows: [{ total_count: 3 }] };
          return { rows: makeMockRows(3) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_stale",
          arguments: {},
        });

        expect(result.isError).toBeFalsy();

        // Verify SQL shape -- data query + count query
        expect(queryCalls.length).toBe(2);
        const [sql, params] = queryCalls[0];

        // Should query all 5 tables (admin has read on all)
        expect(sql).toContain("thoughts");
        expect(sql).toContain("decisions");
        expect(sql).toContain("relationships");
        expect(sql).toContain("projects");
        expect(sql).toContain("sessions");
        expect(sql).toContain("UNION ALL");

        // Should order by staleness ascending (oldest access first)
        expect(sql).toContain("ORDER BY effective_last_access ASC");

        // Default days=30, limit=50
        expect(params[0]).toBe(30);
        expect(params[1]).toBe(50);

        // Should filter archived entries
        expect(sql).toContain("archived_at IS NULL");

        // Should use COALESCE for last_accessed_at fallback
        expect(sql).toContain("COALESCE");
        expect(sql).toContain("last_accessed_at");

        // Verify result format
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries).toBeDefined();
        expect(Array.isArray(parsed.entries)).toBe(true);
        expect(parsed.entries.length).toBe(3);
        expect(parsed.total_count).toBe(3);
        expect(parsed.has_more).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });

  describe("table filter", () => {
    it("only queries thoughts when table='thoughts'", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (sql: string, ...rest: any[]) => {
          queryCalls.push([sql, ...rest]);
          if (sql.includes("SUM(cnt)")) return { rows: [{ total_count: 1 }] };
          return { rows: makeMockRows(1) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_stale",
          arguments: { table: "thoughts" },
        });

        expect(result.isError).toBeFalsy();
        const [sql] = queryCalls[0];

        expect(sql).toContain("FROM thoughts");
        expect(sql).not.toContain("UNION ALL");
      } finally {
        await cleanup();
      }
    });
  });

  describe("tier filter", () => {
    it("SQL contains tier filter when tier='hot'", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (sql: string, ...rest: any[]) => {
          queryCalls.push([sql, ...rest]);
          if (sql.includes("SUM(cnt)")) return { rows: [{ total_count: 2 }] };
          return { rows: makeMockRows(2) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        await client.callTool({
          name: "list_stale",
          arguments: { tier: "hot" },
        });

        const [sql] = queryCalls[0];
        expect(sql).toContain("tier = 'hot'");
      } finally {
        await cleanup();
      }
    });

    it("SQL does NOT contain tier filter when tier is omitted", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (sql: string, ...rest: any[]) => {
          queryCalls.push([sql, ...rest]);
          if (sql.includes("SUM(cnt)")) return { rows: [{ total_count: 1 }] };
          return { rows: makeMockRows(1) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        await client.callTool({
          name: "list_stale",
          arguments: {},
        });

        const [sql] = queryCalls[0];
        expect(sql).not.toContain("tier = '");
      } finally {
        await cleanup();
      }
    });
  });

  describe("custom days and limit", () => {
    it("uses days=60, limit=10 in SQL params", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (sql: string, ...rest: any[]) => {
          queryCalls.push([sql, ...rest]);
          if (sql.includes("SUM(cnt)")) return { rows: [{ total_count: 5 }] };
          return { rows: makeMockRows(5) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_stale",
          arguments: { days: 60, limit: 10 },
        });

        expect(result.isError).toBeFalsy();
        const [, params] = queryCalls[0];
        expect(params[0]).toBe(60);
        expect(params[1]).toBe(10);
      } finally {
        await cleanup();
      }
    });
  });

  describe("readonly role -- has read permission", () => {
    it("succeeds because readonly can read all tables", async () => {
      const mockPool = {
        query: async (sql: string) => {
          if (sql.includes("SUM(cnt)")) return { rows: [{ total_count: 1 }] };
          return { rows: makeMockRows(1) };
        },
      };
      const auth: AuthInfo = { role: "readonly", clientId: "ro-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_stale",
          arguments: {},
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries).toBeDefined();
        expect(Array.isArray(parsed.entries)).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describe("discord role -- no read permission", () => {
    it("returns isError because discord cannot read any table", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      const auth: AuthInfo = { role: "discord", clientId: "discord-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_stale",
          arguments: {},
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
        expect(text).toContain("no readable tables");
      } finally {
        await cleanup();
      }
    });
  });

  describe("no auth", () => {
    it("returns permission denied when auth is missing", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      // Pass undefined auth by using a special setup
      const server = new McpServer({ name: "test", version: "1.0.0" });
      const deps: ToolDeps = {
        pool: mockPool as any,
        embedFn: createMockEmbed(),
      };
      registerListStale(server, deps);

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();

      // Don't inject authInfo
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      try {
        const result = await client.callTool({
          name: "list_stale",
          arguments: {},
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

  describe("empty results", () => {
    it("returns empty entries array, no isError", async () => {
      const mockPool = {
        query: async (sql: string) => {
          if (sql.includes("SUM(cnt)")) return { rows: [{ total_count: 0 }] };
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_stale",
          arguments: {},
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries).toBeDefined();
        expect(Array.isArray(parsed.entries)).toBe(true);
        expect(parsed.entries.length).toBe(0);
        expect(parsed.total_count).toBe(0);
        expect(parsed.has_more).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });

  describe("result includes access metadata", () => {
    it("rows contain access_count, last_accessed_at, and effective_last_access", async () => {
      const mockPool = {
        query: async (sql: string) => {
          if (sql.includes("SUM(cnt)")) return { rows: [{ total_count: 1 }] };
          return { rows: makeMockRows(1) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_stale",
          arguments: {},
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries[0]).toHaveProperty("access_count");
        expect(parsed.entries[0]).toHaveProperty("last_accessed_at");
        expect(parsed.entries[0]).toHaveProperty("effective_last_access");
      } finally {
        await cleanup();
      }
    });
  });

  describe("staleness ordering", () => {
    it("SQL orders by effective_last_access ASC (stalest first)", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (sql: string, ...rest: any[]) => {
          queryCalls.push([sql, ...rest]);
          if (sql.includes("SUM(cnt)")) return { rows: [{ total_count: 0 }] };
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        await client.callTool({
          name: "list_stale",
          arguments: {},
        });

        const [sql] = queryCalls[0];
        expect(sql).toContain("ORDER BY effective_last_access ASC");
      } finally {
        await cleanup();
      }
    });
  });

  describe("table + tier combined filter", () => {
    it("filters to thoughts + hot tier", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (sql: string, ...rest: any[]) => {
          queryCalls.push([sql, ...rest]);
          if (sql.includes("SUM(cnt)")) return { rows: [{ total_count: 1 }] };
          return { rows: makeMockRows(1) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        await client.callTool({
          name: "list_stale",
          arguments: { table: "thoughts", tier: "hot" },
        });

        const [sql] = queryCalls[0];
        expect(sql).toContain("FROM thoughts");
        expect(sql).toContain("tier = 'hot'");
        expect(sql).not.toContain("UNION ALL");
      } finally {
        await cleanup();
      }
    });
  });

  describe("has_more pagination", () => {
    it("returns has_more=true when total exceeds offset+entries", async () => {
      const mockPool = {
        query: async (sql: string) => {
          if (sql.includes("SUM(cnt)")) return { rows: [{ total_count: 10 }] };
          return { rows: makeMockRows(2) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
      const { client, cleanup } = await setupToolClient(mockPool, auth);
      try {
        const result = await client.callTool({
          name: "list_stale",
          arguments: { limit: 2 },
        });
        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.has_more).toBe(true);
        expect(parsed.total_count).toBe(10);
        expect(parsed.entries.length).toBe(2);
      } finally {
        await cleanup();
      }
    });
  });

  describe("count query failure", () => {
    it("returns data with total_count=null when count query fails", async () => {
      const mockPool = {
        query: async (sql: string) => {
          if (sql.includes("SUM(cnt)")) throw new Error("connection lost");
          return { rows: makeMockRows(2) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
      const { client, cleanup } = await setupToolClient(mockPool, auth);
      try {
        const result = await client.callTool({
          name: "list_stale",
          arguments: {},
        });
        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries.length).toBe(2);
        expect(parsed.total_count).toBeNull();
        expect(parsed.has_more).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });
});
