import { describe, it, expect } from "bun:test";
import { registerListRecent } from "../list-recent.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  makeMockRows,
  setupMcpClient,
  parseToolResult,
  getErrorText,
} from "./test-helpers.ts";

const setupToolClient = (
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  auth: AuthInfo,
) => setupMcpClient(registerListRecent, mockPool, createMockEmbed(), auth);

describe("list_recent", () => {
  describe("admin role -- no params (defaults)", () => {
    it("returns entries with total_count and has_more=false when all fit", async () => {
      const mockPool = {
        query: async (...args: any[]) => {
          const [sql] = args;
          if (sql.includes("SUM(cnt)")) {
            return { rows: [{ total_count: 3 }] };
          }
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

        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries).toBeDefined();
        expect(Array.isArray(parsed.entries)).toBe(true);
        expect(parsed.total_count).toBe(3);
        expect(parsed.has_more).toBe(false);
        expect(parsed.entries.length).toBe(3);

        // Verify each entry has expected fields
        for (const entry of parsed.entries) {
          expect(entry).toHaveProperty("source_type");
          expect(entry).toHaveProperty("id");
          expect(entry).toHaveProperty("content_preview");
          expect(entry).toHaveProperty("tags");
          expect(entry).toHaveProperty("created_at");
        }
      } finally {
        await cleanup();
      }
    });
  });

  describe("table filter", () => {
    it("returns only thoughts when table='thoughts'", async () => {
      const mockPool = {
        query: async (...args: any[]) => {
          const [sql] = args;
          if (sql.includes("SUM(cnt)")) {
            return { rows: [{ total_count: 1 }] };
          }
          return {
            rows: [
              {
                source_type: "thought",
                id: "t-1",
                content_preview: "A thought",
                tags: [],
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
          };
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
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries.length).toBe(1);
        expect(parsed.entries[0].source_type).toBe("thought");
      } finally {
        await cleanup();
      }
    });
  });

  describe("include_archived=true", () => {
    it("returns results (archived entries included by mock)", async () => {
      const mockPool = {
        query: async (...args: any[]) => {
          const [sql] = args;
          if (sql.includes("SUM(cnt)")) {
            return { rows: [{ total_count: 2 }] };
          }
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
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries.length).toBe(2);
        expect(parsed.total_count).toBe(2);
      } finally {
        await cleanup();
      }
    });
  });

  describe("include_archived=false (default)", () => {
    it("returns results (only non-archived by default)", async () => {
      const mockPool = {
        query: async (...args: any[]) => {
          const [sql] = args;
          if (sql.includes("SUM(cnt)")) {
            return { rows: [{ total_count: 0 }] };
          }
          return { rows: [] };
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
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries.length).toBe(0);
        expect(parsed.total_count).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });

  describe("custom days and limit", () => {
    it("returns the expected number of entries with custom params", async () => {
      const mockPool = {
        query: async (...args: any[]) => {
          const [sql] = args;
          if (sql.includes("SUM(cnt)")) {
            return { rows: [{ total_count: 5 }] };
          }
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
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries.length).toBe(5);
        expect(parsed.total_count).toBe(5);
        expect(parsed.limit).toBe(5);
      } finally {
        await cleanup();
      }
    });
  });

  describe("readonly role -- has read permission", () => {
    it("succeeds because readonly can read all tables", async () => {
      const mockPool = {
        query: async (...args: any[]) => {
          const [sql] = args;
          if (sql.includes("SUM(cnt)")) {
            return { rows: [{ total_count: 1 }] };
          }
          return { rows: makeMockRows(1) };
        },
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
        expect(parsed.total_count).toBe(1);
        expect(parsed.has_more).toBe(false);
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

  describe("tier filter", () => {
    it("returns results when tier='hot' is provided", async () => {
      const mockPool = {
        query: async (...args: any[]) => {
          const [sql] = args;
          if (sql.includes("SUM(cnt)")) {
            return { rows: [{ total_count: 1 }] };
          }
          return {
            rows: [
              {
                source_type: "thought",
                id: "hot-1",
                content_preview: "Hot thought",
                tags: [],
                tier: "hot",
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
          };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_recent",
          arguments: { tier: "hot" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries.length).toBe(1);
        expect(parsed.total_count).toBe(1);
      } finally {
        await cleanup();
      }
    });

    it("returns results when tier is omitted", async () => {
      const mockPool = {
        query: async (...args: any[]) => {
          const [sql] = args;
          if (sql.includes("SUM(cnt)")) {
            return { rows: [{ total_count: 1 }] };
          }
          return { rows: makeMockRows(1) };
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
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries.length).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });

  describe("empty results", () => {
    it("returns empty array, no isError", async () => {
      const mockPool = {
        query: async (...args: any[]) => {
          const [sql] = args;
          if (sql.includes("SUM(cnt)")) {
            return { rows: [{ total_count: 0 }] };
          }
          return { rows: [] };
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
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries).toBeDefined();
        expect(Array.isArray(parsed.entries)).toBe(true);
        expect(parsed.total_count).toBe(0);
        expect(parsed.has_more).toBe(false);
        expect(parsed.entries.length).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });

  describe("has_more pagination", () => {
    it("returns has_more=true when total_count exceeds returned rows", async () => {
      const mockPool = {
        query: async (...args: any[]) => {
          const [sql] = args;
          if (sql.includes("SUM(cnt)")) {
            return { rows: [{ total_count: 10 }] };
          }
          return { rows: makeMockRows(2) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "list_recent",
          arguments: { limit: 2, offset: 0 },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries.length).toBe(2);
        expect(parsed.total_count).toBe(10);
        expect(parsed.has_more).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describe("count query failure", () => {
    it("returns data with total_count=null and has_more=false when count query fails", async () => {
      const mockPool = {
        query: async (...args: any[]) => {
          const [sql] = args;
          if (sql.includes("SUM(cnt)")) {
            throw new Error("connection timeout");
          }
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
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.entries.length).toBe(3);
        expect(parsed.total_count).toBeNull();
        expect(parsed.has_more).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });
});
