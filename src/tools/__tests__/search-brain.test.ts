import { describe, it, expect } from "bun:test";
import { registerSearchBrain } from "../search-brain.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  makeMockRows,
  setupMcpClient,
  parseToolResult,
  getErrorText,
} from "./test-helpers.ts";

const setup = (
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  auth: AuthInfo,
  embed = createMockEmbed(),
) => setupMcpClient(registerSearchBrain, mockPool, embed, auth);

/** Pool that returns rows for search queries and empty for links. */
const searchPool = (rows: any[]) => ({
  query: async (...args: any[]) => {
    const [sql] = args;
    if (String(sql).includes("FROM ob_links")) return { rows: [] };
    return { rows };
  },
});

function expectNamespaceParameterized(
  sql: unknown,
  params: unknown,
  namespace: string,
): void {
  expect(Array.isArray(params)).toBe(true);
  const namespaceParamIndex = (params as unknown[]).indexOf(namespace) + 1;
  expect(namespaceParamIndex).toBeGreaterThan(0);
  expect(String(sql)).toContain(`namespace = $${namespaceParamIndex}`);
  expect(String(sql)).not.toContain(namespace);
}

describe("search_brain", () => {
  describe("admin role -- all tables accessible", () => {
    it("parameterizes namespace in vector SQL", async () => {
      const maliciousNamespace = "' OR 1=1 --";
      const queryCalls: any[] = [];
      const pool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          const [sql] = args;
          if (String(sql).includes("FROM ob_links")) return { rows: [] };
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: {
            query: "namespace injection",
            namespace: maliciousNamespace,
            search_mode: "vector",
          },
        });

        expect(result.isError).toBeFalsy();
        const [sql, params] = queryCalls[0];
        expectNamespaceParameterized(sql, params, maliciousNamespace);
      } finally {
        await cleanup();
      }
    });

    it("parameterizes namespace in keyword SQL", async () => {
      const maliciousNamespace = "' OR 1=1 --";
      const queryCalls: any[] = [];
      const pool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          const [sql] = args;
          if (String(sql).includes("FROM ob_links")) return { rows: [] };
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: {
            query: "namespace injection",
            namespace: maliciousNamespace,
            search_mode: "keyword",
          },
        });

        expect(result.isError).toBeFalsy();
        const [sql, params] = queryCalls[0];
        expectNamespaceParameterized(sql, params, maliciousNamespace);
      } finally {
        await cleanup();
      }
    });

    it("parameterizes namespace in default hybrid SQL", async () => {
      const maliciousNamespace = "' OR 1=1 --";
      const searchCalls: any[] = [];
      const pool = {
        query: async (...args: any[]) => {
          const [sql] = args;
          if (String(sql).includes("FROM ob_links")) return { rows: [] };
          searchCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: {
            query: "namespace injection",
            namespace: maliciousNamespace,
          },
        });

        expect(result.isError).toBeFalsy();
        expect(searchCalls.length).toBe(2);
        for (const [sql, params] of searchCalls) {
          expectNamespaceParameterized(sql, params, maliciousNamespace);
        }
      } finally {
        await cleanup();
      }
    });

    it("rejects blank namespace instead of running an unscoped search", async () => {
      const queryCalls: any[] = [];
      const pool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: {
            query: "namespace injection",
            namespace: "   ",
            search_mode: "keyword",
          },
        });

        expect(result.isError).toBe(true);
        expect(queryCalls.length).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it("returns ranked results with expected shape", async () => {
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
      const { client, cleanup } = await setup(
        searchPool(
          makeMockRows(3).map((row) => ({
            ...row,
            namespace: "collab",
            created_by: "codex",
            updated_at: "2026-01-02T00:00:00Z",
          })),
        ),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "test query" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBe(3);
        expect(parsed[0]).toHaveProperty("source_type");
        expect(parsed[0]).toHaveProperty("id");
        expect(parsed[0]).toHaveProperty("content_preview");
        expect(parsed[0]).toHaveProperty("distance");
        expect(parsed[0]).toHaveProperty("tags");
        expect(parsed[0]).toHaveProperty("created_at");
        expect(parsed[0].source_ref).toEqual({
          source: "brain",
          type: "thought",
          id: "uuid-0",
          namespace: "collab",
          created_by: "codex",
          created_at: "2026-01-01T00:00:00.000Z",
          last_updated_at: "2026-01-02T00:00:00.000Z",
          label: "Content preview 0",
          preview: "Content preview 0",
        });
      } finally {
        await cleanup();
      }
    });

    it("can search graph entities explicitly", async () => {
      const queryCalls: any[] = [];
      const pool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          const [sql] = args;
          if (String(sql).includes("FROM ob_links")) return { rows: [] };
          return {
            rows: [
              {
                source_type: "entity",
                id: "550e8400-e29b-41d4-a716-446655440000",
                namespace: "collab",
                content_preview: "project: hub",
                tags: null,
                created_by: "codex",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-02T00:00:00Z",
                tier: "warm",
                fts_rank: 1,
                usefulness: 0.5,
                access_count: 0,
              },
            ],
          };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: {
            query: "hub",
            table: "entities",
            search_mode: "keyword",
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(parsed[0].source_type).toBe("entity");
        expect(parsed[0].source_ref.type).toBe("entity");
        expect(queryCalls[0][0]).toContain("FROM ob_entities");
      } finally {
        await cleanup();
      }
    });

    it("treats graph entities as warm-only when tier filtering", async () => {
      const queryCalls: any[] = [];
      const pool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const hotResult = await client.callTool({
          name: "search_brain",
          arguments: {
            query: "hub",
            table: "entities",
            search_mode: "keyword",
            tier: "hot",
          },
        });
        expect(hotResult.isError).toBeFalsy();
        expect(parseToolResult(hotResult)).toEqual([]);
        expect(queryCalls[0][0]).toContain("AND FALSE");

        const warmResult = await client.callTool({
          name: "search_brain",
          arguments: {
            query: "hub",
            table: "entities",
            search_mode: "keyword",
            tier: "warm",
          },
        });
        expect(warmResult.isError).toBeFalsy();
        expect(queryCalls[1][0]).not.toContain("AND FALSE");
      } finally {
        await cleanup();
      }
    });

    it("does not fail when a search row has an invalid timestamp", async () => {
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
      const { client, cleanup } = await setup(
        searchPool([
          {
            source_type: "thought",
            id: "uuid-invalid-date",
            namespace: "collab",
            content_preview: "Invalid timestamp row",
            distance: 0.1,
            tags: [],
            created_at: "not-a-date",
          },
        ]),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "invalid date" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(parsed[0].source_ref).toEqual({
          source: "brain",
          type: "thought",
          id: "uuid-invalid-date",
          namespace: "collab",
          label: "Invalid timestamp row",
          preview: "Invalid timestamp row",
        });
      } finally {
        await cleanup();
      }
    });

    it("includes explicit links for search hits", async () => {
      const thoughtId = "00000000-0000-4000-8000-000000000001";
      const decisionId = "00000000-0000-4000-8000-000000000002";
      const pool = {
        query: async (...args: any[]) => {
          const [sql] = args;
          if (String(sql).includes("FROM ob_links")) {
            return {
              rows: [
                {
                  id: "00000000-0000-4000-8000-000000000010",
                  from_type: "thought",
                  from_id: thoughtId,
                  to_type: "decision",
                  to_id: decisionId,
                  relation: "artifact",
                  weight: 0.8,
                  metadata: { ob_source_id: "obsidian-note-1" },
                  created_at: "2026-01-02T00:00:00Z",
                },
              ],
            };
          }
          return {
            rows: [
              {
                source_type: "thought",
                id: thoughtId,
                content_preview: "Linked thought",
                distance: 0.1,
                tags: ["tag-a"],
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
          };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "linked thought", search_mode: "vector" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(parsed[0].explicit_links).toEqual([
          {
            id: "00000000-0000-4000-8000-000000000010",
            direction: "outgoing",
            relation: "artifact",
            weight: 0.8,
            linked_type: "decision",
            linked_id: decisionId,
            metadata: { ob_source_id: "obsidian-note-1" },
            created_at: "2026-01-02T00:00:00.000Z",
          },
        ]);
      } finally {
        await cleanup();
      }
    });

    it("returns empty explicit_links when ob_links query throws", async () => {
      const pool = {
        query: async (...args: any[]) => {
          const [sql] = args;
          if (String(sql).includes("FROM ob_links"))
            throw new Error("relation ob_links does not exist");
          return {
            rows: [
              {
                source_type: "thought",
                id: "00000000-0000-4000-8000-000000000001",
                content_preview: "Fallback thought",
                distance: 0.1,
                tags: ["tag-a"],
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
          };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "error fallback", search_mode: "vector" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(parsed.length).toBe(1);
        expect(parsed[0].explicit_links).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it("populates incoming direction when to_id matches search result", async () => {
      const decisionId = "00000000-0000-4000-8000-000000000005";
      const thoughtId = "00000000-0000-4000-8000-000000000006";
      const pool = {
        query: async (...args: any[]) => {
          const [sql] = args;
          if (String(sql).includes("FROM ob_links")) {
            return {
              rows: [
                {
                  id: "00000000-0000-4000-8000-000000000020",
                  from_type: "thought",
                  from_id: thoughtId,
                  to_type: "decision",
                  to_id: decisionId,
                  relation: "caused_by",
                  weight: 0.9,
                  metadata: {},
                  created_at: "2026-02-01T00:00:00Z",
                },
              ],
            };
          }
          return {
            rows: [
              {
                source_type: "decision",
                id: decisionId,
                content_preview: "Incoming link target",
                distance: 0.1,
                tags: [],
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
          };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "incoming link", search_mode: "vector" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        const link = parsed[0].explicit_links[0];
        expect(link.direction).toBe("incoming");
        expect(link.linked_type).toBe("thought");
        expect(link.linked_id).toBe(thoughtId);
        expect(link.relation).toBe("caused_by");
      } finally {
        await cleanup();
      }
    });
  });

  describe("readonly role", () => {
    it("returns results since readonly has read on everything", async () => {
      const auth: AuthInfo = { role: "readonly", clientId: "ro-client" };
      const { client, cleanup } = await setup(
        searchPool(makeMockRows(2)),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "readonly search" },
        });
        expect(result.isError).toBeFalsy();
        expect(parseToolResult(result).length).toBe(2);
      } finally {
        await cleanup();
      }
    });
  });

  describe("agent role", () => {
    it("returns results from accessible tables", async () => {
      const auth: AuthInfo = { role: "agent", clientId: "agent-client" };
      const { client, cleanup } = await setup(
        searchPool(makeMockRows(1)),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "agent search" },
        });
        expect(result.isError).toBeFalsy();
        expect(parseToolResult(result).length).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });

  describe("discord role -- no read access", () => {
    it("returns isError with permission denied", async () => {
      const pool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "discord", clientId: "discord-client" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "discord search" },
        });
        expect(result.isError).toBe(true);
        expect(getErrorText(result)).toContain("Permission denied");
        expect(getErrorText(result)).toContain("no readable tables");
      } finally {
        await cleanup();
      }
    });
  });

  describe("table filter", () => {
    it("returns results from only the filtered table", async () => {
      const rows = [
        {
          source_type: "thought",
          id: "thought-1",
          content_preview: "A thought",
          distance: 0.1,
          tags: [],
          created_at: "2026-01-01T00:00:00Z",
        },
      ];
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setup(searchPool(rows), auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "filtered", table: "thoughts" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        for (const row of parsed) expect(row.source_type).toBe("thought");
      } finally {
        await cleanup();
      }
    });

    it("returns isError when discord filters to unreadable table", async () => {
      const pool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "discord", clientId: "discord" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "should fail", table: "thoughts" },
        });
        expect(result.isError).toBe(true);
        expect(getErrorText(result)).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });
  });

  describe("embedding failure", () => {
    it("returns isError when embedFn returns null", async () => {
      const pool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setup(
        pool,
        auth,
        createMockEmbed(null),
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "embed failure", search_mode: "vector" },
        });
        expect(result.isError).toBe(true);
        expect(getErrorText(result)).toContain(
          "Failed to generate query embedding",
        );
      } finally {
        await cleanup();
      }
    });
  });

  describe("empty results", () => {
    it("returns empty array when pool returns no rows", async () => {
      const pool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "no results" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(parsed).toEqual([]);
      } finally {
        await cleanup();
      }
    });
  });

  describe("limit parameter", () => {
    it("defaults to 10 results", async () => {
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setup(
        searchPool(makeMockRows(10)),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "default limit", search_mode: "vector" },
        });
        expect(result.isError).toBeFalsy();
        expect(parseToolResult(result).length).toBe(10);
      } finally {
        await cleanup();
      }
    });

    it("respects provided limit value", async () => {
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setup(
        searchPool(makeMockRows(25)),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: {
            query: "custom limit",
            limit: 25,
            search_mode: "vector",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseToolResult(result).length).toBe(25);
      } finally {
        await cleanup();
      }
    });
  });

  describe("result format", () => {
    it("returns correct field values from mock data", async () => {
      const rows = [
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
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setup(searchPool(rows), auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "format check" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(parsed.length).toBe(2);
        expect(parsed[0].source_type).toBe("thought");
        expect(parsed[0].id).toBe("thought-uuid-1");
        expect(parsed[0].content_preview).toBe("A thought about testing");
        expect(parsed[0].distance).toBe(0.05);
        expect(parsed[0].tags).toEqual(["test", "unit"]);
        expect(parsed[0].created_at).toBe("2026-01-15T10:00:00Z");
        expect(parsed[1].source_type).toBe("decision");
      } finally {
        await cleanup();
      }
    });
  });

  describe("archived filtering", () => {
    it("returns results from non-archived mock data", async () => {
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setup(
        searchPool(makeMockRows(1)),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "archived filter test" },
        });
        expect(result.isError).toBeFalsy();
        expect(parseToolResult(result).length).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });

  describe("no auth", () => {
    it("returns isError when auth is missing", async () => {
      const pool = { query: async () => ({ rows: [] }) };
      const { client, cleanup } = await setupMcpClient(
        registerSearchBrain,
        pool,
        createMockEmbed(),
        null,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "no auth search" },
        });
        expect(result.isError).toBe(true);
        expect(getErrorText(result)).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });
  });

  describe("usage tracking", () => {
    it("fires tracking queries after successful search with results", async () => {
      const queryCalls: any[] = [];
      const pool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          const [sql] = args;
          if (String(sql).includes("FROM ob_links")) return { rows: [] };
          return { rows: makeMockRows(3) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "track this", search_mode: "vector" },
        });
        expect(result.isError).toBeFalsy();
        expect(parseToolResult(result).length).toBe(3);
        await new Promise((r) => setTimeout(r, 50));
        expect(queryCalls.length).toBeGreaterThan(1);
      } finally {
        await cleanup();
      }
    });

    it("does NOT fire tracking when search returns empty", async () => {
      const queryCalls: any[] = [];
      const pool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        await client.callTool({
          name: "search_brain",
          arguments: { query: "empty results", search_mode: "vector" },
        });
        await new Promise((r) => setTimeout(r, 50));
        expect(queryCalls.length).toBe(1);
      } finally {
        await cleanup();
      }
    });

    it("does NOT fire tracking when embedding fails", async () => {
      const queryCalls: any[] = [];
      const pool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setup(
        pool,
        auth,
        createMockEmbed(null),
      );

      try {
        await client.callTool({
          name: "search_brain",
          arguments: { query: "embed fail", search_mode: "vector" },
        });
        await new Promise((r) => setTimeout(r, 50));
        expect(queryCalls.length).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });

  describe("tier filtering", () => {
    it("returns results when tier filter is provided", async () => {
      const rows = [
        {
          source_type: "thought",
          id: "hot-1",
          content_preview: "Hot thought",
          distance: 0.1,
          tags: [],
          tier: "hot",
          created_at: "2026-01-01T00:00:00Z",
        },
      ];
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setup(searchPool(rows), auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "tier test", tier: "hot" },
        });
        expect(result.isError).toBeFalsy();
        expect(parseToolResult(result).length).toBeGreaterThanOrEqual(1);
      } finally {
        await cleanup();
      }
    });

    it("returns results without tier filtering when omitted", async () => {
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setup(
        searchPool(makeMockRows(1)),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "no tier filter" },
        });
        expect(result.isError).toBeFalsy();
        expect(parseToolResult(result).length).toBe(1);
      } finally {
        await cleanup();
      }
    });

    it("keyword mode returns results with tier filter", async () => {
      const rows = [
        {
          source_type: "thought",
          id: "cold-1",
          content_preview: "Cold keyword result",
          fts_rank: 0.8,
          tags: [],
          tier: "cold",
          created_at: "2026-01-01T00:00:00Z",
        },
      ];
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setup(searchPool(rows), auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: {
            query: "keyword tier",
            search_mode: "keyword",
            tier: "cold",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseToolResult(result).length).toBeGreaterThanOrEqual(1);
      } finally {
        await cleanup();
      }
    });
  });

  describe("usefulness-weighted ranking", () => {
    it("returns results that include usefulness field", async () => {
      const rows = [
        {
          source_type: "thought",
          id: "useful-1",
          content_preview: "Highly useful",
          distance: 0.2,
          usefulness: 0.9,
          tags: [],
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          source_type: "thought",
          id: "useful-2",
          content_preview: "Less useful",
          distance: 0.15,
          usefulness: 0.1,
          tags: [],
          created_at: "2026-01-01T00:00:00Z",
        },
      ];
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setup(searchPool(rows), auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "ranked search" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(parsed.length).toBe(2);
        expect(parsed[0]).toHaveProperty("usefulness");
        expect(parsed[1]).toHaveProperty("usefulness");
      } finally {
        await cleanup();
      }
    });
  });
});
