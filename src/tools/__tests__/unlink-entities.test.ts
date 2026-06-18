import { describe, expect, it } from "bun:test";
import { registerUnlinkEntities } from "../unlink-entities.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

const FROM_ID = "aaaaaaaa-bbbb-9ccc-8ddd-eeeeeeeeeeee";
const TO_ID = "11111111-2222-9333-9444-555555555555";

describe("unlink_entities", () => {
  it("soft-deletes one active graph link by tuple and namespace", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [{ id: "link-id" }] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupMcpClient(
      registerUnlinkEntities,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "unlink_entities",
        arguments: {
          namespace: "collab",
          from_type: "entity",
          from_id: FROM_ID,
          to_type: "entity",
          to_id: TO_ID,
          relation: "depends_on",
        },
      });

      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result)).toEqual({
        id: "link-id",
        namespace: "collab",
        unlinked: true,
      });
      expect(calls[0]?.sql).toContain("SET archived_at = NOW()");
      expect(calls[0]?.sql).toContain("namespace = $1");
      expect(calls[0]?.params).toEqual([
        "collab",
        "entity",
        FROM_ID,
        "entity",
        TO_ID,
        "depends_on",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("denies non-delete roles", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerUnlinkEntities,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "unlink_entities",
        arguments: {
          from_type: "entity",
          from_id: FROM_ID,
          to_type: "entity",
          to_id: TO_ID,
          relation: "depends_on",
        },
      });
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
