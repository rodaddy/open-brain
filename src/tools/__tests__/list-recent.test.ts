import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerListRecent } from "../list-recent.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

function makeMockRows(count: number = 3) {
  return Array.from({ length: count }, (_, i) => ({
    source_type: "thought",
    id: `uuid-${i}`,
    content_preview: `Content preview ${i}`,
    tags: ["tag-a"],
    created_at: "2026-01-01T00:00:00Z",
  }));
}

async function setupToolClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: createMockEmbed() };
  registerListRecent(server, deps);

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

describe("list_recent", () => {
  describe("admin role -- no params (defaults)", () => {
    it("returns entries from last 7 days, limit 20, excludes archived", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(3) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_recent",
          arguments: {},
        });

        expect(result.isError).toBeFalsy();

        // Verify SQL shape
        expect(queryCalls.length).toBe(2); // data query + count query
        const [sql, params] = queryCalls[0];

        // Should query all 5 tables (admin has read on all)
        expect(sql).toContain("thoughts");
        expect(sql).toContain("decisions");
        expect(sql).toContain("relationships");
        expect(sql).toContain("projects");
        expect(sql).toContain("sessions");
        expect(sql).toContain("UNION ALL");
        expect(sql).toContain("ORDER BY created_at DESC");

        // Default days=7 and limit=20
        expect(params[0]).toBe(7);
        expect(params[1]).toBe(20);

        // Should filter archived by default
        expect(sql).toContain("archived_at IS NULL");

        // Verify result format
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries).toBeDefined();
        expect(Array.isArray(parsed.entries)).toBe(true);
        expect(typeof parsed.total_count).toBe("number");
        expect(typeof parsed.has_more).toBe("boolean");
        expect(parsed.entries.length).toBe(3);
      } finally {
        await cleanup();
      }
    });
  });

  describe("table filter", () => {
    it("only queries thoughts when table='thoughts'", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(1) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_recent",
          arguments: { table: "thoughts" },
        });

        expect(result.isError).toBeFalsy();
        const [sql] = queryCalls[0];

        // Should only contain thoughts, not other tables in UNION
        expect(sql).toContain("FROM thoughts");
        expect(sql).not.toContain("UNION ALL");
      } finally {
        await cleanup();
      }
    });
  });

  describe("include_archived=true", () => {
    it("SQL does NOT contain 'archived_at IS NULL'", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(2) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_recent",
          arguments: { include_archived: true },
        });

        expect(result.isError).toBeFalsy();
        const [sql] = queryCalls[0];
        expect(sql).not.toContain("archived_at IS NULL");
      } finally {
        await cleanup();
      }
    });
  });

  describe("include_archived=false (default)", () => {
    it("SQL contains 'archived_at IS NULL'", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        await client.callTool({
          name: "list_recent",
          arguments: {},
        });

        const [sql] = queryCalls[0];
        expect(sql).toContain("archived_at IS NULL");
      } finally {
        await cleanup();
      }
    });
  });

  describe("custom days and limit", () => {
    it("uses days=30, limit=5 in SQL params", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(5) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_recent",
          arguments: { days: 30, limit: 5 },
        });

        expect(result.isError).toBeFalsy();
        const [, params] = queryCalls[0];
        expect(params[0]).toBe(30);
        expect(params[1]).toBe(5);
      } finally {
        await cleanup();
      }
    });
  });

  describe("readonly role -- has read permission", () => {
    it("succeeds because readonly can read all tables", async () => {
      const mockPool = {
        query: async () => ({ rows: makeMockRows(1) }),
      };
      const auth: AuthInfo = { role: "readonly", clientId: "ro-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_recent",
          arguments: {},
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries).toBeDefined();
        expect(Array.isArray(parsed.entries)).toBe(true);
        expect(typeof parsed.total_count).toBe("number");
        expect(typeof parsed.has_more).toBe("boolean");
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
          name: "list_recent",
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

  describe("tier in SELECT columns", () => {
    it("SQL SELECT includes tier column", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(1) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        await client.callTool({
          name: "list_recent",
          arguments: {},
        });

        const [sql] = queryCalls[0];
        expect(sql).toContain(".tier");
      } finally {
        await cleanup();
      }
    });
  });

  describe("tier filter", () => {
    it("SQL contains tier filter when tier param is provided", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(1) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        await client.callTool({
          name: "list_recent",
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
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(1) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        await client.callTool({
          name: "list_recent",
          arguments: {},
        });

        const [sql] = queryCalls[0];
        expect(sql).not.toContain("tier = '");
      } finally {
        await cleanup();
      }
    });
  });

  describe("empty results", () => {
    it("returns empty array, no isError", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_recent",
          arguments: {},
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries).toBeDefined();
        expect(Array.isArray(parsed.entries)).toBe(true);
        expect(typeof parsed.total_count).toBe("number");
        expect(typeof parsed.has_more).toBe("boolean");
        expect(parsed.entries.length).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });
});
