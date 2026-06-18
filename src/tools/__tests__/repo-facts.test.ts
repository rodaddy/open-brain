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
      expect(parseToolResult(result)).toHaveLength(1);
      expect(calls[0]?.sql).toContain("entity_type = 'repo_fact'");
      expect(calls[0]?.sql).toContain("namespace = ANY($1::text[])");
      expect(calls[0]?.sql).toContain("metadata->>'repo' = $2");
      expect(calls[0]?.sql).toContain("metadata->>'subject' = $3 OR metadata->>'symbol' = $3");
      expect(calls[0]?.params).toEqual([
        ["bilby", "collab"],
        "king-core",
        "ApiResponse",
        10,
        0,
      ]);
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
