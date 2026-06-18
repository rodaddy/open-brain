import { describe, expect, it } from "bun:test";
import { registerHydrateEntities } from "../hydrate-entities.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

describe("hydrate_entities", () => {
  it("hydrates active entities in a writable namespace", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (String(sql).startsWith("SELECT")) {
          return {
            rows: [
              {
                id: "550e8400-e29b-91d4-a716-446655440000",
                entity_type: "project",
                name: "open-brain",
                namespace: "collab",
              },
            ],
          };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupMcpClient(
      registerHydrateEntities,
      mockPool as any,
      createMockEmbed(Array(768).fill(0.2)),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "hydrate_entities",
        arguments: { namespace: "collab", only_missing_embedding: true },
      });

      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result)).toMatchObject({ matched: 1, hydrated: 1 });
      expect(calls[0]?.sql).toContain("archived_at IS NULL");
      expect(calls[0]?.sql).toContain("embedding IS NULL");
      expect(calls[1]?.sql).toContain("UPDATE ob_entities");
    } finally {
      await cleanup();
    }
  });

  it("denies readonly hydration", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupMcpClient(
      registerHydrateEntities,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "hydrate_entities",
        arguments: { namespace: "collab" },
      });
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
