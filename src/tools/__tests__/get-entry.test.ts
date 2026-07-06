import { describe, expect, it } from "bun:test";
import { registerGetEntry } from "../get-entry.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  getErrorText,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

describe("get_entry", () => {
  it("filters scoped callers to readable namespaces", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [{ id: params?.[0], namespace: "bilby", content: "ok" }] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerGetEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_entry",
        arguments: {
          table: "thoughts",
          id: "550e8400-e29b-41d4-a716-446655440000",
        },
      });

      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result).namespace).toBe("bilby");
      expect(queries[0]?.sql).toContain("namespace = ANY($2::text[])");
      expect(queries[0]?.params).toEqual([
        "550e8400-e29b-41d4-a716-446655440000",
        ["bilby", "shared-kb"],
      ]);
    } finally {
      await cleanup();
    }
  });

  it("returns not found when scoped namespace filter excludes the row", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = {
      role: "admin",
      clientId: "bilby",
      tokenClientId: "admin",
      namespaceSource: "header",
    };
    const { client, cleanup } = await setupMcpClient(
      registerGetEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_entry",
        arguments: {
          table: "thoughts",
          id: "550e8400-e29b-41d4-a716-446655440001",
        },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("Entry not found");
    } finally {
      await cleanup();
    }
  });

  it("returns a bounded compact envelope without emitting the full row", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return {
          rows: [
            {
              id: params?.[0],
              namespace: "bilby",
              created_by: "codex",
              created_at: "2026-07-06T00:00:00.000Z",
              updated_at: "2026-07-06T00:01:00.000Z",
              tier: "warm",
              tags: ["large"],
              content_preview: "Large entry preview",
              content_length: "1200",
              content_truncated: true,
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerGetEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_entry",
        arguments: {
          table: "thoughts",
          id: "550e8400-e29b-41d4-a716-446655440010",
          render: "compact",
          max_chars: 120,
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed).toMatchObject({
        id: "550e8400-e29b-41d4-a716-446655440010",
        table: "thoughts",
        source_type: "thought",
        namespace: "bilby",
        render: "compact",
        max_chars: 120,
        content_preview: "Large entry preview",
        content_length: 1200,
        content_truncated: true,
        full_available: true,
      });
      expect(parsed.content).toBeUndefined();
      expect(parsed.source_ref).toMatchObject({
        source: "brain",
        type: "thought",
        id: "550e8400-e29b-41d4-a716-446655440010",
        namespace: "bilby",
      });
      expect(parsed.fetch_path).toEqual({
        tool: "get_entry",
        arguments: {
          table: "thoughts",
          id: "550e8400-e29b-41d4-a716-446655440010",
          render: "full",
        },
      });
      expect(queries[0]?.sql).toContain("LEFT(");
      expect(queries[0]?.sql).toContain("content_preview");
      expect(queries[0]?.sql).toContain("namespace = ANY($2::text[])");
      expect(queries[0]?.params).toEqual([
        "550e8400-e29b-41d4-a716-446655440010",
        ["bilby", "shared-kb"],
        120,
      ]);
    } finally {
      await cleanup();
    }
  });
});
