import { describe, expect, it } from "bun:test";
import {
  registerListRepoFacts,
  registerUpsertRepoFact,
} from "../repo-facts.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  getErrorText,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

const repoFact = {
  source_system: "qmd",
  repo: "king-core",
  collection: "king",
  path: "king-core/src/types/api.ts",
  symbol: "ApiResponse",
  fact_type: "api_contract",
  fact: "Use ApiResponse<T> from @king-capital/core/types; do not hand-roll response envelopes.",
  source_commit: "3e48e2f0085a0ff03ddbccb84ae826d21c77aed4",
  source_url:
    "https://github.com/rodaddy/king-core/blob/3e48e2f0085a0ff03ddbccb84ae826d21c77aed4/src/types/api.ts",
  verified_at: "2026-06-18T06:00:00.000Z",
  confidence: 1,
  staleness_policy: "stable_fact_verify_source",
  refresh_hint: "Verify live shape in source before editing response contracts.",
} as const;

describe("repo fact tools", () => {
  it("upserts a curated qmd repo fact as a graph entity", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return {
          rows: [
            {
              id: "550e8400-e29b-41d4-a716-446655440000",
              is_new: true,
              entity_type: "repo_fact",
              name: params?.[0],
              canonical_id: params?.[1],
              namespace: params?.[2],
              metadata: JSON.parse(params?.[3] as string),
              created_at: "2026-06-18T06:00:00.000Z",
              updated_at: "2026-06-18T06:00:00.000Z",
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupMcpClient(
      registerUpsertRepoFact,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "upsert_repo_fact",
        arguments: { namespace: "collab", metadata: repoFact },
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.entity_type).toBe("repo_fact");
      expect(parsed.namespace).toBe("collab");
      expect(parsed.canonical_id).toContain("repo_fact:qmd:king-core");
      expect(parsed.metadata.source_system).toBe("qmd");
      expect(parsed.metadata.source_commit).toBe(repoFact.source_commit);
      expect(calls[0]?.sql).toContain("entity_type, name, canonical_id");
      expect(calls[0]?.sql).toContain("ON CONFLICT");
    } finally {
      await cleanup();
    }
  });

  it("rejects fact bodies that look like raw code chunks", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupMcpClient(
      registerUpsertRepoFact,
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "upsert_repo_fact",
        arguments: {
          metadata: {
            ...repoFact,
            fact: "export interface ApiResponse<T> {\n  success: boolean;\n  data?: T;\n}",
          },
        },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("raw code chunk");
    } finally {
      await cleanup();
    }
  });

  it("rejects short Python code chunks", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupMcpClient(
      registerUpsertRepoFact,
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "upsert_repo_fact",
        arguments: {
          metadata: {
            ...repoFact,
            fact: "def load_contract(path):\n    return open(path).read()",
          },
        },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("raw code chunk");
    } finally {
      await cleanup();
    }
  });

  it("rejects credential-like material before embedding or storage", async () => {
    let queried = false;
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupMcpClient(
      registerUpsertRepoFact,
      {
        query: async () => {
          queried = true;
          return { rows: [] };
        },
      },
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "upsert_repo_fact",
        arguments: {
          metadata: {
            ...repoFact,
            fact: ["token=", "not-a-real-token-value"].join(""),
          },
        },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("credential-like material");
      expect(queried).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("rejects AWS secret-access-key-like material before embedding or storage", async () => {
    let queried = false;
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupMcpClient(
      registerUpsertRepoFact,
      {
        query: async () => {
          queried = true;
          return { rows: [] };
        },
      },
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "upsert_repo_fact",
        arguments: {
          metadata: {
            ...repoFact,
            fact: "Never store this fixture: abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
          },
        },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("credential-like material");
      expect(queried).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("requires either symbol or subject", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupMcpClient(
      registerUpsertRepoFact,
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      auth,
    );

    const { symbol: _symbol, ...metadataWithoutSubject } = repoFact;

    try {
      const result = await client.callTool({
        name: "upsert_repo_fact",
        arguments: { metadata: metadataWithoutSubject },
      });
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("requires trusted HTTPS GitHub source URLs", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupMcpClient(
      registerUpsertRepoFact,
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "upsert_repo_fact",
        arguments: {
          metadata: {
            ...repoFact,
            source_url: "http://localhost/source",
          },
        },
      });
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("requires source URLs to include the source commit and path", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupMcpClient(
      registerUpsertRepoFact,
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "upsert_repo_fact",
        arguments: {
          metadata: {
            ...repoFact,
            source_url:
              "https://github.com/rodaddy/king-core/blob/main/src/types/api.ts",
          },
        },
      });
      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain(
        "source_url must include source_commit and source path",
      );
    } finally {
      await cleanup();
    }
  });

  it("rejects source commit hidden in query or fragment", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupMcpClient(
      registerUpsertRepoFact,
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      auth,
    );

    try {
      for (const source_url of [
        `https://github.com/rodaddy/king-core/blob/main/src/types/api.ts?commit=${repoFact.source_commit}`,
        `https://github.com/rodaddy/king-core/blob/main/src/types/api.ts#${repoFact.source_commit}`,
      ]) {
        const result = await client.callTool({
          name: "upsert_repo_fact",
          arguments: {
            metadata: {
              ...repoFact,
              source_url,
            },
          },
        });
        expect(result.isError).toBe(true);
        expect(getErrorText(result)).toContain(
          "source_url must include source_commit and source path",
        );
      }
    } finally {
      await cleanup();
    }
  });

  it("rejects source URLs from a different repository or suffix path", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupMcpClient(
      registerUpsertRepoFact,
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      auth,
    );

    try {
      for (const source_url of [
        `https://github.com/rodaddy/other-repo/blob/${repoFact.source_commit}/src/types/api.ts`,
        `https://github.com/rodaddy/king-core/blob/${repoFact.source_commit}/src/types/api.ts.evil`,
      ]) {
        const result = await client.callTool({
          name: "upsert_repo_fact",
          arguments: {
            metadata: {
              ...repoFact,
              source_url,
            },
          },
        });
        expect(result.isError).toBe(true);
        expect(getErrorText(result)).toContain(
          "source_url must include source_commit and source path",
        );
      }
    } finally {
      await cleanup();
    }
  });

  it("rejects future verification timestamps", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupMcpClient(
      registerUpsertRepoFact,
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "upsert_repo_fact",
        arguments: {
          metadata: {
            ...repoFact,
            verified_at: "2999-01-01T00:00:00.000Z",
          },
        },
      });
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("allows normal prose with colon punctuation", async () => {
    const mockPool = {
      query: async (_sql: string, params?: unknown[]) => ({
        rows: [
          {
            id: "550e8400-e29b-41d4-a716-446655440000",
            is_new: true,
            entity_type: "repo_fact",
            name: params?.[0],
            canonical_id: params?.[1],
            namespace: params?.[2],
            metadata: JSON.parse(params?.[3] as string),
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupMcpClient(
      registerUpsertRepoFact,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "upsert_repo_fact",
        arguments: {
          metadata: {
            ...repoFact,
            fact: "Note: read the source pointer before changing the response envelope.",
          },
        },
      });

      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  it("adds a digest to canonical IDs so long truncated paths do not collide", async () => {
    const ids: string[] = [];
    const mockPool = {
      query: async (_sql: string, params?: unknown[]) => {
        ids.push(params?.[1] as string);
        return {
          rows: [
            {
              id: `id-${ids.length}`,
              is_new: true,
              entity_type: "repo_fact",
              name: params?.[0],
              canonical_id: params?.[1],
              namespace: params?.[2],
              metadata: JSON.parse(params?.[3] as string),
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupMcpClient(
      registerUpsertRepoFact,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const longPath = `${"a".repeat(220)}/api.ts`;
      await client.callTool({
        name: "upsert_repo_fact",
        arguments: {
          metadata: {
            ...repoFact,
            path: longPath,
            source_url: `https://github.com/rodaddy/king-core/blob/${repoFact.source_commit}/${longPath}`,
          },
        },
      });
      await client.callTool({
        name: "upsert_repo_fact",
        arguments: {
          metadata: {
            ...repoFact,
            path: `${"a".repeat(220)}/db.ts`,
            source_url: `https://github.com/rodaddy/king-core/blob/${repoFact.source_commit}/${"a".repeat(220)}/db.ts`,
          },
        },
      });

      expect(ids[0]).not.toBe(ids[1]);
      expect(ids[0]?.split(":").at(-1)).toMatch(/^[0-9a-f]{16}$/);
      expect(ids[1]?.split(":").at(-1)).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      await cleanup();
    }
  });

  it("enforces namespace write policy", async () => {
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerUpsertRepoFact,
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "upsert_repo_fact",
        arguments: { namespace: "collab", metadata: repoFact },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("lists repo facts with readable namespace scoping", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return {
          rows: [
            {
              id: "550e8400-e29b-41d4-a716-446655440000",
              entity_type: "repo_fact",
              name: "king-core:api",
              namespace: "collab",
              metadata: repoFact,
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerListRepoFacts,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "list_repo_facts",
        arguments: { repo: "king-core", subject: "ApiResponse", limit: 10 },
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].namespace).toBe("shared-kb");
      expect(calls[0]?.sql).toContain("entity_type = 'repo_fact'");
      expect(calls[0]?.sql).toContain("namespace = ANY($1::text[])");
      expect(calls[0]?.sql).toContain("metadata->>'repo' = $2");
      expect(calls[0]?.sql).toContain("metadata->>'subject' = $3 OR metadata->>'symbol' = $3");
      expect(calls[0]?.params).toEqual([
        ["bilby", "shared-kb"],
        "king-core",
        "ApiResponse",
        10,
        0,
      ]);
    } finally {
      await cleanup();
    }
  });

  it("falls back from shared-kb to legacy collab when listing repo facts", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        const namespace = params?.[0];
        if (namespace === "shared-kb") return { rows: [] };
        if (namespace === "collab") {
          return {
            rows: [
              {
                id: "550e8400-e29b-41d4-a716-446655440001",
                entity_type: "repo_fact",
                name: "king-core:api",
                namespace: "collab",
                metadata: repoFact,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupMcpClient(
      registerListRepoFacts,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "list_repo_facts",
        arguments: { namespace: "shared-kb", limit: 10 },
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].namespace).toBe("shared-kb");
      expect(calls.map((call) => call.params?.[0])).toEqual([
        "shared-kb",
        "collab",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("uses hidden legacy collab fallback for omitted namespace repo fact reads", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        const namespace = params?.[0];
        if (Array.isArray(namespace)) {
          expect(namespace).toEqual(["bilby", "shared-kb"]);
          return { rows: [] };
        }
        if (namespace === "collab") {
          return {
            rows: [
              {
                id: "550e8400-e29b-41d4-a716-446655440002",
                entity_type: "repo_fact",
                name: "king-core:legacy-api",
                namespace: "collab",
                metadata: repoFact,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerListRepoFacts,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "list_repo_facts",
        arguments: { limit: 10 },
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].namespace).toBe("shared-kb");
      expect(calls.map((call) => call.params?.[0])).toEqual([
        ["bilby", "shared-kb"],
        "shared-kb",
        "collab",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("still queries legacy collab when private repo facts fill omitted namespace reads", async () => {
    const mockPool = {
      query: async (_sql: string, params?: unknown[]) => {
        const namespace = params?.[0];
        if (Array.isArray(namespace)) {
          return {
            rows: [
              {
                id: "550e8400-e29b-41d4-a716-446655440101",
                entity_type: "repo_fact",
                name: "private-one",
                namespace: "bilby",
                metadata: { ...repoFact, subject: "private-one" },
              },
              {
                id: "550e8400-e29b-41d4-a716-446655440102",
                entity_type: "repo_fact",
                name: "private-two",
                namespace: "bilby",
                metadata: { ...repoFact, subject: "private-two" },
              },
            ],
          };
        }
        if (namespace === "shared-kb") return { rows: [] };
        if (namespace === "collab") {
          return {
            rows: [
              {
                id: "550e8400-e29b-41d4-a716-446655440103",
                entity_type: "repo_fact",
                name: "legacy-shared",
                namespace: "collab",
                metadata: { ...repoFact, subject: "legacy-shared" },
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerListRepoFacts,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "list_repo_facts",
        arguments: { limit: 2 },
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.map((row: any) => row.namespace)).toEqual([
        "bilby",
        "bilby",
        "shared-kb",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("dedupes migrated shared-kb and legacy collab repo facts by stable identity", async () => {
    const mockPool = {
      query: async (_sql: string, params?: unknown[]) => {
        const namespace = params?.[0];
        if (namespace === "shared-kb") {
          return {
            rows: [
              {
                id: "550e8400-e29b-41d4-a716-446655440201",
                canonical_id: "repo-fact:shared",
                entity_type: "repo_fact",
                name: "shared-fact",
                namespace: "shared-kb",
                metadata: repoFact,
              },
            ],
          };
        }
        if (namespace === "collab") {
          return {
            rows: [
              {
                id: "550e8400-e29b-41d4-a716-446655440202",
                canonical_id: "repo-fact:shared",
                entity_type: "repo_fact",
                name: "shared-fact",
                namespace: "collab",
                metadata: repoFact,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerListRepoFacts,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "list_repo_facts",
        arguments: { namespace: "shared-kb", limit: 3 },
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe("550e8400-e29b-41d4-a716-446655440201");
      expect(parsed[0].namespace).toBe("shared-kb");
    } finally {
      await cleanup();
    }
  });

  it("rejects unreadable explicit namespaces when listing repo facts", async () => {
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerListRepoFacts,
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "list_repo_facts",
        arguments: { namespace: "other" },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("namespace read access denied");
    } finally {
      await cleanup();
    }
  });
});
