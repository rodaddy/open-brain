import { describe, expect, it } from "bun:test";
import { registerScanNamespace } from "../scan-namespace.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  getErrorText,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

describe("scan_namespace", () => {
  it("denies delegated admin scanning outside the delegated namespace", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = {
      role: "admin",
      clientId: "bilby",
      tokenClientId: "admin",
      namespaceSource: "header",
    };
    const { client, cleanup } = await setupMcpClient(
      registerScanNamespace,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "scan_namespace",
        arguments: { namespace: "skippy" },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("namespace read access denied");
    } finally {
      await cleanup();
    }
  });

  it("allows delegated admin scanning the delegated namespace", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = {
      role: "admin",
      clientId: "bilby",
      tokenClientId: "admin",
      namespaceSource: "header",
    };
    const { client, cleanup } = await setupMcpClient(
      registerScanNamespace,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "scan_namespace",
        arguments: { namespace: "bilby", table: "thoughts" },
      });

      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result).namespace).toBe("bilby");
    } finally {
      await cleanup();
    }
  });

  it("checks duplicates in the requested target namespace", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        if (calls.length === 1) {
          return {
            rows: [
              {
                id: "source-1",
                namespace: "bilby",
                content_hash: "hash-1",
                created_at: "2026-06-10T00:00:00.000Z",
                promoted_from: null,
              },
            ],
          };
        }
        return { rows: [{ id: "team-1" }] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupMcpClient(
      registerScanNamespace,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "scan_namespace",
        arguments: {
          namespace: "bilby",
          target_namespace: "team",
          table: "thoughts",
        },
      });

      expect(result.isError).toBeFalsy();
      expect(calls[1]!.sql).toContain("namespace = $2");
      expect(calls[1]!.params).toEqual(["hash-1", "team"]);
      expect(parseToolResult(result)).toMatchObject({
        namespace: "bilby",
        target_namespace: "team",
        duplicates: [
          {
            table: "thoughts",
            id: "source-1",
            target_namespace: "team",
            existing_target_id: "team-1",
          },
        ],
      });
      expect(parseToolResult(result).duplicates[0].existing_collab_id).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
