import { describe, expect, it } from "bun:test";
import { registerGetEntity } from "../get-entity.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  getErrorText,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

describe("get_entity", () => {
  it("fetches an entity by id with namespace scoping", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return {
          rows: [
            {
              id: params?.[0],
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
      registerGetEntity,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_entity",
        arguments: { id: "550e8400-e29b-41d4-a716-446655440000" },
      });

      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result).entity_type).toBe("project");
      expect(calls[0]?.sql).toContain("FROM ob_entities");
      expect(calls[0]?.sql).toContain("namespace = ANY($2::text[])");
      expect(calls[0]?.params).toEqual([
        "550e8400-e29b-41d4-a716-446655440000",
        ["bilby", "collab"],
      ]);
    } finally {
      await cleanup();
    }
  });

  it("returns not found when scoped namespace excludes the entity", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerGetEntity,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_entity",
        arguments: { id: "550e8400-e29b-41d4-a716-446655440001" },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("Entity not found");
    } finally {
      await cleanup();
    }
  });
});
