import { describe, it, expect } from "bun:test";
import { registerSearchBrain } from "../search-brain.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  enableLegacyCollabFallback,
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

const abortAwareNeverResolvingEmbed =
  (onAbort: () => void) =>
  async (
    _text: string,
    _embeddingUrl?: string,
    options?: { signal?: AbortSignal },
  ) =>
    new Promise<number[] | null>((resolve) => {
      options?.signal?.addEventListener(
        "abort",
        () => {
          onAbort();
          resolve(null);
        },
        { once: true },
      );
    });

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

    it("parameterizes source scope in keyword SQL", async () => {
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
            query: "matter scoped search",
            namespace: "team-kb",
            search_mode: "keyword",
            source_scope: {
              client_id: "acme",
              matter_id: "lit-1",
              document_id: "doc-1",
            },
          },
        });

        expect(result.isError).toBeFalsy();
        const [sql, params] = queryCalls[0];
        const sourceScopeJson = JSON.stringify({
          client_id: "acme",
          matter_id: "lit-1",
          document_id: "doc-1",
        });
        const sourceScopeParamIndex = (params as unknown[]).indexOf(
          sourceScopeJson,
        ) + 1;
        expect(sourceScopeParamIndex).toBeGreaterThan(0);
        expect(String(sql)).toContain(
          `COALESCE(t.source_refs, '[]'::jsonb)`,
        );
        expect(String(sql)).toContain(`$${sourceScopeParamIndex}::jsonb`);
        expect(String(sql)).not.toContain("acme");
        expect(String(sql)).not.toContain("lit-1");
        expect(String(sql)).not.toContain("doc-1");
      } finally {
        await cleanup();
      }
    });

    it("excludes unscoped entity rows when source scope is supplied", async () => {
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
            query: "matter scoped search",
            search_mode: "keyword",
            source_scope: {
              client_id: "acme",
            },
          },
        });

        expect(result.isError).toBeFalsy();
        const [sql] = queryCalls[0];
        expect(String(sql)).not.toContain("entities_fts");
        expect(String(sql)).not.toContain("FROM ob_entities");
      } finally {
        await cleanup();
      }
    });

    it("denies source scope for non-admin callers before querying", async () => {
      let queried = false;
      const pool = {
        query: async () => {
          queried = true;
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "agent", clientId: "bilby" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: {
            query: "matter scoped search",
            source_scope: { client_id: "acme" },
          },
        });

        expect(result.isError).toBe(true);
        expect(getErrorText(result)).toContain("source_scope requires");
        expect(queried).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it("denies source scope for delegated admin sessions", async () => {
      let queried = false;
      const pool = {
        query: async () => {
          queried = true;
          return { rows: [] };
        },
      };
      const auth: AuthInfo = {
        role: "admin",
        clientId: "bilby",
        tokenClientId: "admin",
        namespaceSource: "header",
      };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: {
            query: "matter scoped search",
            source_scope: { client_id: "acme" },
          },
        });

        expect(result.isError).toBe(true);
        expect(getErrorText(result)).toContain("delegated namespace");
        expect(queried).toBe(false);
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
            namespace: "shared-kb",
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
          namespace: "shared-kb",
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
                namespace: "shared-kb",
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
        expect(queryCalls[0][0]).toContain("e.archived_at IS NULL");
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
            namespace: "shared-kb",
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
          namespace: "shared-kb",
          label: "Invalid timestamp row",
          preview: "Invalid timestamp row",
        });
      } finally {
        await cleanup();
      }
    });

    it("falls back from canonical shared-kb to legacy collab and canonicalizes results", async () => {
      const fallbackEnv = enableLegacyCollabFallback();
      const searchCalls: any[] = [];
      const pool = {
        query: async (...args: any[]) => {
          const [sql, params] = args;
          if (String(sql).includes("FROM ob_links")) return { rows: [] };
          if (String(sql).includes("entry_access_log")) {
            return { rows: [] };
          }
          searchCalls.push(args);
          const namespace = Array.isArray(params) ? params.at(-1) : undefined;
          if (namespace === "shared-kb") return { rows: [] };
          if (namespace === "collab") {
            return {
              rows: [
                {
                  source_type: "thought",
                  id: "00000000-0000-4000-8000-000000000099",
                  namespace: "collab",
                  content_preview: "Legacy shared hit",
                  tags: [],
                  created_by: "codex",
                  created_at: "2026-01-01T00:00:00Z",
                  usefulness: 0,
                  fts_rank: 1,
                },
              ],
            };
          }
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "agent", clientId: "bilby" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: {
            query: "legacy hit",
            namespace: "shared-kb",
            search_mode: "keyword",
            limit: 3,
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].namespace).toBe("shared-kb");
        expect(parsed[0].source_ref.namespace).toBe("shared-kb");
        expect(
          searchCalls
            .map((call) => call[1].at(-1))
            .filter((value) => typeof value === "string"),
        ).toEqual(["shared-kb", "collab"]);
      } finally {
        fallbackEnv.restore();
        await cleanup();
      }
    });

    it("does NOT query legacy collab by default after retirement (#167)", () => {
      // Regression: with the default config (no escape-hatch env), a shared-kb
      // search must never issue a second query against the collab namespace.
      const searchCalls: any[] = [];
      const pool = {
        query: async (...args: any[]) => {
          const [sql, params] = args;
          if (String(sql).includes("FROM ob_links")) return { rows: [] };
          if (String(sql).includes("entry_access_log")) return { rows: [] };
          searchCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "agent", clientId: "bilby" };
      return (async () => {
        const { client, cleanup } = await setup(pool, auth);
        try {
          const result = await client.callTool({
            name: "search_brain",
            arguments: { query: "no collab please", namespace: "shared-kb" },
          });
          expect(result.isError).toBeFalsy();
          const queriedNamespaces = searchCalls
            .map((call) => call[1]?.at?.(-1))
            .filter((value) => typeof value === "string" || Array.isArray(value));
          const flat = queriedNamespaces.flat();
          expect(flat).not.toContain("collab");
        } finally {
          await cleanup();
        }
      })();
    });

    it("uses hidden legacy collab fallback for omitted namespace scoped searches", async () => {
      const fallbackEnv = enableLegacyCollabFallback();
      const searchCalls: any[] = [];
      const pool = {
        query: async (...args: any[]) => {
          const [sql, params] = args;
          if (String(sql).includes("FROM ob_links")) return { rows: [] };
          if (String(sql).startsWith("INSERT INTO entry_access_log")) {
            return { rows: [] };
          }
          const namespace = Array.isArray(params) ? params.at(-1) : undefined;
          if (
            Array.isArray(namespace) &&
            namespace.every((value) => String(value).startsWith("00000000-"))
          ) {
            return { rows: [] };
          }
          searchCalls.push(args);
          if (Array.isArray(namespace)) {
            expect(namespace).toEqual(["bilby", "shared-kb"]);
            return { rows: [] };
          }
          if (namespace === "collab") {
            return {
              rows: [
                {
                  source_type: "thought",
                  id: "00000000-0000-4000-8000-000000000100",
                  namespace: "collab",
                  content_preview: "Implicit legacy shared hit",
                  tags: [],
                  created_by: "codex",
                  created_at: "2026-01-01T00:00:00Z",
                  usefulness: 0,
                  fts_rank: 1,
                },
              ],
            };
          }
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "agent", clientId: "bilby" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: {
            query: "legacy hit",
            search_mode: "keyword",
            limit: 3,
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].namespace).toBe("shared-kb");
        expect(
          searchCalls
            .map((call) => call[1].at(-1))
            .filter((value) => Array.isArray(value) || typeof value === "string"),
        ).toEqual([["bilby", "shared-kb"], "shared-kb", "collab"]);
      } finally {
        fallbackEnv.restore();
        await cleanup();
      }
    });

    it("still queries legacy collab when private hits fill omitted namespace search", async () => {
      const fallbackEnv = enableLegacyCollabFallback();
      const pool = {
        query: async (...args: any[]) => {
          const [sql, params] = args;
          if (String(sql).includes("FROM ob_links")) return { rows: [] };
          if (String(sql).includes("entry_access_log")) return { rows: [] };
          const namespace = Array.isArray(params) ? params.at(-1) : undefined;
          if (
            Array.isArray(namespace) &&
            namespace.every((value) => String(value).startsWith("00000000-"))
          ) {
            return { rows: [] };
          }
          if (Array.isArray(namespace)) {
            return {
              rows: [
                {
                  source_type: "thought",
                  id: "00000000-0000-4000-8000-000000000201",
                  namespace: "bilby",
                  content_preview: "Private hit 1",
                  tags: [],
                  created_by: "bilby",
                  created_at: "2026-01-01T00:00:00Z",
                  usefulness: 0,
                  fts_rank: 1,
                },
                {
                  source_type: "thought",
                  id: "00000000-0000-4000-8000-000000000202",
                  namespace: "bilby",
                  content_preview: "Private hit 2",
                  tags: [],
                  created_by: "bilby",
                  created_at: "2026-01-01T00:00:00Z",
                  usefulness: 0,
                  fts_rank: 0.9,
                },
              ],
            };
          }
          if (namespace === "shared-kb") return { rows: [] };
          if (namespace === "collab") {
            return {
              rows: [
                {
                  source_type: "thought",
                  id: "00000000-0000-4000-8000-000000000203",
                  namespace: "collab",
                  content_preview: "Legacy shared hit despite private hits",
                  tags: [],
                  created_by: "codex",
                  created_at: "2026-01-01T00:00:00Z",
                  usefulness: 0,
                  fts_rank: 0.8,
                },
              ],
            };
          }
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "agent", clientId: "bilby" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: {
            query: "legacy hit",
            search_mode: "keyword",
            limit: 2,
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(parsed.map((row: any) => row.namespace)).toEqual([
          "bilby",
          "shared-kb",
        ]);
      } finally {
        fallbackEnv.restore();
        await cleanup();
      }
    });

    it("dedupes migrated shared-kb and legacy collab fallback rows by content", async () => {
      const fallbackEnv = enableLegacyCollabFallback();
      const pool = {
        query: async (...args: any[]) => {
          const [sql, params] = args;
          if (String(sql).includes("FROM ob_links")) return { rows: [] };
          if (String(sql).includes("entry_access_log")) return { rows: [] };
          const namespace = Array.isArray(params) ? params.at(-1) : undefined;
          if (
            Array.isArray(namespace) &&
            namespace.every((value) => String(value).startsWith("00000000-"))
          ) {
            return { rows: [] };
          }
          if (namespace === "shared-kb") {
            return {
              rows: [
                {
                  source_type: "thought",
                  id: "00000000-0000-4000-8000-000000000301",
                  namespace: "shared-kb",
                  content_preview: "Migrated shared fact",
                  tags: [],
                  created_by: "promoter",
                  created_at: "2026-01-01T00:00:00Z",
                  usefulness: 0,
                  fts_rank: 1,
                },
              ],
            };
          }
          if (namespace === "collab") {
            return {
              rows: [
                {
                  source_type: "thought",
                  id: "00000000-0000-4000-8000-000000000302",
                  namespace: "collab",
                  content_preview: "Migrated shared fact",
                  tags: [],
                  created_by: "legacy",
                  created_at: "2026-01-01T00:00:00Z",
                  usefulness: 0,
                  fts_rank: 0.9,
                },
              ],
            };
          }
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "agent", clientId: "bilby" };
      const { client, cleanup } = await setup(pool, auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: {
            query: "migrated",
            namespace: "shared-kb",
            search_mode: "keyword",
            limit: 3,
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].id).toBe("00000000-0000-4000-8000-000000000301");
        expect(parsed[0].namespace).toBe("shared-kb");
      } finally {
        fallbackEnv.restore();
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

    it("falls back to keyword search when hybrid embedding times out", async () => {
      const previousTimeout = process.env.OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS;
      process.env.OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS = "10";
      let aborted = false;
      const pool = searchPool(makeMockRows(2));
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setup(
        pool,
        auth,
        abortAwareNeverResolvingEmbed(() => {
          aborted = true;
        }),
      );

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "embed timeout" },
        });
        expect(result.isError).toBeFalsy();
        expect(parseToolResult(result).length).toBe(2);
        expect(aborted).toBe(true);
      } finally {
        if (previousTimeout === undefined) {
          delete process.env.OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS;
        } else {
          process.env.OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS = previousTimeout;
        }
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
