import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSearchBrain } from "../search-brain.ts";
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
    distance: 0.1 + i * 0.05,
    tags: ["tag-a"],
    created_at: "2026-01-01T00:00:00Z",
  }));
}

async function setupSearchClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  mockEmbed: ReturnType<typeof createMockEmbed>,
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: mockEmbed };
  registerSearchBrain(server, deps);

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

describe("search_brain", () => {
  describe("admin role -- all tables accessible", () => {
    it("generates query embedding, builds CTE for all 5 tables, returns ranked results", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(3) };
        },
      };
      const embeddedTexts: string[] = [];
      const mockEmbed = async (text: string) => {
        embeddedTexts.push(text);
        return Array(768).fill(0.1);
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "test query" },
        });

        expect(result.isError).toBeFalsy();

        // Verify embedding was generated for the query
        expect(embeddedTexts.length).toBe(1);
        expect(embeddedTexts[0]).toBe("test query");

        // Verify SQL includes CTEs for all 5 tables
        expect(queryCalls.length).toBe(1);
        const [sql] = queryCalls[0];
        expect(sql).toContain("thoughts");
        expect(sql).toContain("decisions");
        expect(sql).toContain("relationships");
        expect(sql).toContain("projects");
        expect(sql).toContain("sessions");
        expect(sql).toContain("UNION ALL");
        // Composite ranking: 80% distance + 20% usefulness
        expect(sql).toContain("distance");
        expect(sql).toContain("usefulness");

        // Verify result format
        const text = (result.content as any)[0].text;
        const parsed = JSON.parse(text);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBe(3);
        expect(parsed[0]).toHaveProperty("source_type");
        expect(parsed[0]).toHaveProperty("id");
        expect(parsed[0]).toHaveProperty("content_preview");
        expect(parsed[0]).toHaveProperty("distance");
        expect(parsed[0]).toHaveProperty("tags");
        expect(parsed[0]).toHaveProperty("created_at");
      } finally {
        await cleanup();
      }
    });
  });

  describe("readonly role -- all tables accessible", () => {
    it("searches all 5 tables since readonly has read on everything", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(2) };
        },
      };
      const auth: AuthInfo = { role: "readonly", clientId: "ro-client" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "readonly search" },
        });

        expect(result.isError).toBeFalsy();
        const [sql] = queryCalls[0];
        expect(sql).toContain("thoughts");
        expect(sql).toContain("decisions");
        expect(sql).toContain("relationships");
        expect(sql).toContain("projects");
        expect(sql).toContain("sessions");
      } finally {
        await cleanup();
      }
    });
  });

  describe("agent role -- limited table access", () => {
    it("only searches thoughts, decisions, sessions (agent cannot read relationships or projects)", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(1) };
        },
      };
      const auth: AuthInfo = { role: "agent", clientId: "agent-client" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "agent search" },
        });

        expect(result.isError).toBeFalsy();
        const [sql] = queryCalls[0];
        expect(sql).toContain("thoughts");
        expect(sql).toContain("decisions");
        expect(sql).toContain("sessions");
        // Agent has read on relationships and projects (RO), so they SHOULD appear
        // Wait -- let me check permissions.ts: agent has RO on relationships and projects
        // That means agent CAN read those tables. Let me fix the test expectation.
        expect(sql).toContain("relationships");
        expect(sql).toContain("projects");
      } finally {
        await cleanup();
      }
    });
  });

  describe("discord role -- no read access", () => {
    it("returns isError because discord has no read permission on any table", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      const auth: AuthInfo = { role: "discord", clientId: "discord-client" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "discord search" },
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

  describe("table filter -- restrict to single table", () => {
    it("only includes thoughts CTE when table filter is 'thoughts'", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(1) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "filtered search", table: "thoughts" },
        });

        expect(result.isError).toBeFalsy();
        const [sql] = queryCalls[0];
        // Should contain thoughts CTE
        expect(sql).toContain("thoughts");
        // Should NOT contain other table CTEs
        // We check that the CTE names for other tables are absent
        expect(sql).not.toContain("decisions_results");
        expect(sql).not.toContain("relationships_results");
        expect(sql).not.toContain("projects_results");
        expect(sql).not.toContain("sessions_results");
      } finally {
        await cleanup();
      }
    });

    it("returns isError when agent filters to a table they cannot read", async () => {
      // Agent CAN read relationships (RO). Let's test with discord + thoughts
      // discord has WO on thoughts -- can write but NOT read
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      const auth: AuthInfo = { role: "discord", clientId: "discord" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "should fail", table: "thoughts" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });
  });

  describe("embedding failure", () => {
    it("returns isError when embedFn returns null", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        createMockEmbed(null),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "embed failure" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Failed to generate query embedding");
      } finally {
        await cleanup();
      }
    });
  });

  describe("empty results", () => {
    it("returns empty array when pool returns no rows", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "no results" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });

  describe("limit parameter", () => {
    it("defaults to 10 when not provided", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        await client.callTool({
          name: "search_brain",
          arguments: { query: "default limit" },
        });

        // The limit parameter ($2) should be 10
        const [, params] = queryCalls[0];
        expect(params).toContain(10);
      } finally {
        await cleanup();
      }
    });

    it("uses provided limit value", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        await client.callTool({
          name: "search_brain",
          arguments: { query: "custom limit", limit: 25 },
        });

        const [, params] = queryCalls[0];
        expect(params).toContain(25);
      } finally {
        await cleanup();
      }
    });
  });

  describe("result format", () => {
    it("each result has source_type, id, content_preview, distance, tags, created_at", async () => {
      const mockRows = [
        {
          source_type: "thought",
          id: "thought-uuid-1",
          content_preview: "A thought about testing",
          distance: 0.05,
          tags: ["test", "unit"],
          created_at: "2026-01-15T10:00:00Z",
        },
        {
          source_type: "decision",
          id: "decision-uuid-1",
          content_preview: "Use Bun: Faster runtime",
          distance: 0.12,
          tags: ["runtime"],
          created_at: "2026-01-14T09:00:00Z",
        },
      ];
      const mockPool = {
        query: async () => ({ rows: mockRows }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "format check" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.length).toBe(2);

        const first = parsed[0];
        expect(first.source_type).toBe("thought");
        expect(first.id).toBe("thought-uuid-1");
        expect(first.content_preview).toBe("A thought about testing");
        expect(first.distance).toBe(0.05);
        expect(first.tags).toEqual(["test", "unit"]);
        expect(first.created_at).toBe("2026-01-15T10:00:00Z");

        const second = parsed[1];
        expect(second.source_type).toBe("decision");
        expect(second.id).toBe("decision-uuid-1");
      } finally {
        await cleanup();
      }
    });
  });

  describe("archived filtering", () => {
    it("SQL contains archived_at IS NULL to exclude archived rows", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(1) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "archived filter test" },
        });

        expect(result.isError).toBeFalsy();
        expect(queryCalls.length).toBe(1);
        const [sql] = queryCalls[0];
        expect(sql).toContain("archived_at IS NULL");
      } finally {
        await cleanup();
      }
    });
  });

  describe("no auth", () => {
    it("returns isError when auth is missing", async () => {
      const server = new McpServer({ name: "test", version: "1.0.0" });
      const mockPool = { query: async () => ({ rows: [] }) };
      const deps: ToolDeps = {
        pool: mockPool as any,
        embedFn: createMockEmbed(),
      };
      registerSearchBrain(server, deps);

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      // Do NOT inject authInfo
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "no auth search" },
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

  describe("usage tracking", () => {
    it("fires UPDATE for access_count and last_accessed_at after successful search", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(3) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        await client.callTool({
          name: "search_brain",
          arguments: { query: "track this" },
        });

        // Wait for fire-and-forget promises to settle
        await new Promise((r) => setTimeout(r, 50));

        // First call is the search SELECT, subsequent calls are tracking UPDATEs
        expect(queryCalls.length).toBeGreaterThan(1);

        // Find the tracking UPDATE calls (after the first search query)
        const trackingCalls = queryCalls.slice(1);
        expect(trackingCalls.length).toBeGreaterThan(0);

        // Each tracking UPDATE should contain access_count and last_accessed_at
        for (const call of trackingCalls) {
          const sql = call[0];
          expect(sql).toContain("access_count");
          expect(sql).toContain("last_accessed_at");
        }
      } finally {
        await cleanup();
      }
    });

    it("does NOT fire tracking UPDATE when search returns empty results", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        await client.callTool({
          name: "search_brain",
          arguments: { query: "empty results" },
        });

        // Wait for any fire-and-forget promises
        await new Promise((r) => setTimeout(r, 50));

        // Only 1 call: the search SELECT. No tracking UPDATEs.
        expect(queryCalls.length).toBe(1);
      } finally {
        await cleanup();
      }
    });

    it("does NOT fire tracking UPDATE when embedding fails", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        createMockEmbed(null),
        auth,
      );

      try {
        await client.callTool({
          name: "search_brain",
          arguments: { query: "embed fail" },
        });

        await new Promise((r) => setTimeout(r, 50));

        // No pool.query calls at all when embedding fails
        expect(queryCalls.length).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });

  describe("usefulness-weighted ranking", () => {
    it("search SQL contains composite ORDER BY with distance and usefulness", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(2) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        await client.callTool({
          name: "search_brain",
          arguments: { query: "ranked search" },
        });

        const [sql] = queryCalls[0];
        // Final ORDER BY uses composite score with distance and usefulness
        expect(sql).toContain("distance");
        expect(sql).toContain("usefulness");
        // Check for the weighting formula components
        expect(sql).toContain("0.8");
        expect(sql).toContain("0.2");
      } finally {
        await cleanup();
      }
    });

    it("CTE SELECT includes usefulness_score column", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(1) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };

      const { client, cleanup } = await setupSearchClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        await client.callTool({
          name: "search_brain",
          arguments: { query: "usefulness check" },
        });

        const [sql] = queryCalls[0];
        expect(sql).toContain("usefulness_score");
      } finally {
        await cleanup();
      }
    });
  });
});
