import { describe, expect, it } from "bun:test";
import { registerPromoteEntry } from "../promote-entry.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  getErrorText,
  setupMcpClient,
} from "./test-helpers.ts";

describe("promote_entry", () => {
  it("returns a dry-run report without inserting", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const sourceId = "550e8400-e29b-41d4-a716-446655440011";
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (calls.length === 1) {
          return {
            rows: [
              {
                id: sourceId,
                namespace: "collab",
                created_by: "legacy-agent",
                content_hash: "hash-tool-dry-run",
                extracted_metadata: {
                  event_id: "event-1",
                  repo: "rico/open-brain",
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "openbrain-promoter" };
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
          id: sourceId,
          target_namespace: "shared-kb",
          dry_run: true,
          promotion_actor: "spoofed-actor",
          reason: "verified legacy collab knowledge",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed).toMatchObject({
        status: "dry_run",
        dry_run: true,
        would_insert: true,
        source_id: sourceId,
        source_namespace: "collab",
        target_namespace: "shared-kb",
        provenance: {
          source_physical_namespace: "collab",
          source_table: "thoughts",
          source_id: sourceId,
          source_event_id: "event-1",
          source_repo: "rico/open-brain",
          promoted_by: "openbrain-promoter",
          promotion_reason: "verified legacy collab knowledge",
        },
      });
      expect(calls.length).toBe(2);
      expect(calls.some((call) => call.sql.includes("INSERT INTO"))).toBe(false);
    } finally {
      await cleanup();
    }
  });

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
        ["bilby", "shared-kb"],
      ]);
    } finally {
      await cleanup();
    }
  });
});
