import { describe, expect, it } from "bun:test";
import { registerListEntities } from "../list-entities.ts";
import type { AuthInfo } from "../../types.ts";
import { createMockEmbed, parseToolResult, setupMcpClient } from "./test-helpers.ts";

describe("list_entities", () => {
  it("lists entities with filters and scoped namespaces", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return {
          rows: [
            {
              id: "550e8400-e29b-41d4-a716-446655440000",
              entity_type: "project",
              name: "hub",
              namespace: "bilby",
              metadata: {},
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerListEntities,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "list_entities",
        arguments: { entity_type: "project", name: "hu", limit: 10 },
      });

      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result)).toHaveLength(1);
      expect(calls[0]?.sql).toContain("FROM ob_entities");
      expect(calls[0]?.sql).toContain("archived_at IS NULL");
      expect(calls[0]?.sql).toContain("namespace = ANY($1::text[])");
      expect(calls[0]?.sql).toContain("entity_type = $2");
      expect(calls[0]?.sql).toContain("name ILIKE $3");
      expect(calls[0]?.params).toEqual([["bilby", "collab"], "project", "%hu%", 10, 0]);
    } finally {
      await cleanup();
    }
  });

  it("rejects unreadable explicit namespaces", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerListEntities,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "list_entities",
        arguments: { namespace: "other" },
      });

      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
