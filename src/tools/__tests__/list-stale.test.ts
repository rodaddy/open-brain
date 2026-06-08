import { describe, it, expect } from "bun:test";
import { registerListStale } from "../list-stale.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  setupMcpClient,
  parseToolResult,
  getErrorText,
} from "./test-helpers.ts";

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

const setupToolClient = (
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  auth: AuthInfo,
) => setupMcpClient(registerListStale, mockPool, createMockEmbed(), auth);

describe("list_stale", () => {
  describe("admin role -- no params (defaults)", () => {
    it("returns stale entries with total_count and correct output shape", async () => {
      const mockPool = {
        query: async (sql: string, ...rest: any[]) => {
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

        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries).toBeDefined();
        expect(Array.isArray(parsed.entries)).toBe(true);
        expect(parsed.entries.length).toBe(3);
        expect(parsed.total_count).toBe(3);
        expect(parsed.has_more).toBe(false);

        // Verify default offset/limit in output
        expect(parsed.offset).toBe(0);
        expect(parsed.limit).toBe(50);
      } finally {
        await cleanup();
      }
    });
  });

  describe("table filter", () => {
    it("returns results filtered to thoughts only", async () => {
      const mockPool = {
        query: async (sql: string, ...rest: any[]) => {
          if (sql.includes("SUM(cnt)")) return { rows: [{ total_count: 1 }] };
          return {
            rows: [
              {
                source_type: "thought",
                id: "t-1",
                content_preview: "Stale thought",
                tags: [],
                tier: "hot",
                access_count: 0,
                last_accessed_at: null,
                created_at: "2025-12-01T00:00:00Z",
                effective_last_access: "2025-12-01T00:00:00Z",
              },
            ],
          };
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
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries.length).toBe(1);
        expect(parsed.entries[0].source_type).toBe("thought");
      } finally {
        await cleanup();
      }
    });
  });

  describe("tier filter", () => {
    it("returns results when tier='hot' is provided", async () => {
      const mockPool = {
        query: async (sql: string, ...rest: any[]) => {
          if (sql.includes("SUM(cnt)")) return { rows: [{ total_count: 2 }] };
          return { rows: makeMockRows(2) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_stale",
          arguments: { tier: "hot" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries.length).toBe(2);
        expect(parsed.total_count).toBe(2);
      } finally {
        await cleanup();
      }
    });

    it("returns results when tier is omitted (no tier filtering)", async () => {
      const mockPool = {
        query: async (sql: string, ...rest: any[]) => {
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
        expect(parsed.entries.length).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });

  describe("custom days and limit", () => {
    it("returns entries with custom limit reflected in output", async () => {
      const mockPool = {
        query: async (sql: string, ...rest: any[]) => {
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
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries.length).toBe(5);
        expect(parsed.limit).toBe(10);
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
      const pool = { query: async () => ({ rows: [] }) };
      const { client, cleanup } = await setupMcpClient(
        registerListStale,
        pool,
        createMockEmbed(),
        null,
      );

      try {
        const result = await client.callTool({
          name: "list_stale",
          arguments: {},
        });

        expect(result.isError).toBe(true);
        expect(getErrorText(result)).toContain("Permission denied");
      } finally {
        await cleanup();
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
    it("output contains entries ordered by effective_last_access (stalest first)", async () => {
      const mockPool = {
        query: async (sql: string) => {
          if (sql.includes("SUM(cnt)")) return { rows: [{ total_count: 2 }] };
          // Return rows already ordered by staleness (mock simulates DB ordering)
          return {
            rows: [
              {
                source_type: "thought",
                id: "stale-1",
                content_preview: "Oldest",
                tags: [],
                tier: "hot",
                access_count: 0,
                last_accessed_at: "2025-06-01T00:00:00Z",
                created_at: "2025-06-01T00:00:00Z",
                effective_last_access: "2025-06-01T00:00:00Z",
              },
              {
                source_type: "thought",
                id: "stale-2",
                content_preview: "Less old",
                tags: [],
                tier: "hot",
                access_count: 1,
                last_accessed_at: "2025-10-01T00:00:00Z",
                created_at: "2025-05-01T00:00:00Z",
                effective_last_access: "2025-10-01T00:00:00Z",
              },
            ],
          };
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
        // First entry should have older effective_last_access (stalest first)
        const first = new Date(
          parsed.entries[0].effective_last_access,
        ).getTime();
        const second = new Date(
          parsed.entries[1].effective_last_access,
        ).getTime();
        expect(first).toBeLessThanOrEqual(second);
      } finally {
        await cleanup();
      }
    });
  });

  describe("table + tier combined filter", () => {
    it("returns results filtered to thoughts + hot tier", async () => {
      const mockPool = {
        query: async (sql: string, ...rest: any[]) => {
          if (sql.includes("SUM(cnt)")) return { rows: [{ total_count: 1 }] };
          return {
            rows: [
              {
                source_type: "thought",
                id: "combo-1",
                content_preview: "Hot stale thought",
                tags: [],
                tier: "hot",
                access_count: 0,
                last_accessed_at: null,
                created_at: "2025-12-01T00:00:00Z",
                effective_last_access: "2025-12-01T00:00:00Z",
              },
            ],
          };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_stale",
          arguments: { table: "thoughts", tier: "hot" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries.length).toBe(1);
        expect(parsed.entries[0].source_type).toBe("thought");
        expect(parsed.entries[0].tier).toBe("hot");
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
