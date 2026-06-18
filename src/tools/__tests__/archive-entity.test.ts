import { describe, expect, it } from "bun:test";
import { registerArchiveEntity } from "../archive-entity.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

const ENTITY_ID = "550e8400-e29b-91d4-a716-446655440000";

describe("archive_entity", () => {
  it("archives an entity and active links in one transaction", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const clientConn = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (String(sql).includes("UPDATE ob_entities")) {
          return { rows: [{ id: ENTITY_ID, namespace: "collab" }] };
        }
        if (String(sql).includes("UPDATE ob_links")) {
          return { rows: [], rowCount: 2 };
        }
        return { rows: [] };
      },
      release: () => undefined,
    };
    const mockPool = {
      connect: async () => clientConn,
      query: async () => ({ rows: [] }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupMcpClient(
      registerArchiveEntity,
      mockPool as any,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "archive_entity",
        arguments: { id: ENTITY_ID },
      });

      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result)).toEqual({
        id: ENTITY_ID,
        namespace: "collab",
        archived: true,
        links_archived: 2,
      });
      expect(calls.map((call) => call.sql)).toEqual(
        expect.arrayContaining(["BEGIN", "COMMIT"]),
      );
      expect(calls.some((call) => call.sql.includes("UPDATE ob_entities"))).toBe(true);
      const linkUpdate = calls.find((call) => call.sql.includes("UPDATE ob_links"));
      expect(linkUpdate?.sql).toContain("AND namespace = $2");
      expect(linkUpdate?.params).toEqual([ENTITY_ID, "collab"]);
    } finally {
      await cleanup();
    }
  });

  it("denies non-delete roles", async () => {
    const mockPool = {
      connect: async () => {
        throw new Error("should not connect");
      },
      query: async () => ({ rows: [] }),
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerArchiveEntity,
      mockPool as any,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "archive_entity",
        arguments: { id: ENTITY_ID },
      });
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
