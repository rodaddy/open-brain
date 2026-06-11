import { describe, expect, it } from "bun:test";
import { registerPromoteEntry } from "../promote-entry.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  getErrorText,
  setupMcpClient,
} from "./test-helpers.ts";

describe("promote_entry", () => {
  it("scopes delegated source lookup to readable namespaces", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };
    const auth: AuthInfo = {
      role: "admin",
      clientId: "bilby",
      tokenClientId: "admin",
      namespaceSource: "header",
    };
    const { client, cleanup } = await setupMcpClient(
      registerPromoteEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "promote_entry",
        arguments: {
          table: "thoughts",
          id: "550e8400-e29b-41d4-a716-446655440010",
          target_namespace: "collab",
        },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("Source entry not found");
      expect(calls[0]!.sql).toContain("namespace = ANY($2::text[])");
      expect(calls[0]!.params).toEqual([
        "550e8400-e29b-41d4-a716-446655440010",
        ["bilby", "collab"],
      ]);
    } finally {
      await cleanup();
    }
  });
});
