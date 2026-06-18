import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import { registerDemoteEntry } from "../demote-entry.ts";
import {
  createMockEmbed,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

describe("demote_entry", () => {
  it("scopes delegated lookup and archive update to allowed namespaces", async () => {
    const promotedId = "550e8400-e29b-41d4-a716-446655440000";
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        if (sql.startsWith("SELECT")) {
          return {
            rows: [
              {
                id: promotedId,
                namespace: "bilby",
                promoted_from: {
                  source_id: "550e8400-e29b-41d4-a716-446655440001",
                  source_namespace: "personal",
                },
              },
            ],
          };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    const auth: AuthInfo = {
      role: "admin",
      clientId: "bilby",
      tokenClientId: "admin",
      namespaceSource: "header",
    };
    const { client, cleanup } = await setupMcpClient(
      registerDemoteEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "demote_entry",
        arguments: { table: "thoughts", id: promotedId },
      });

      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result).status).toBe("demoted");
      expect(calls[0]!.sql).toContain("namespace = ANY($2::text[])");
      expect(calls[0]!.params).toEqual([promotedId, ["bilby", "shared-kb"]]);
      expect(calls[1]!.sql).toContain("namespace = ANY($2::text[])");
      expect(calls[1]!.params).toEqual([promotedId, ["bilby"]]);
    } finally {
      await cleanup();
    }
  });
});
