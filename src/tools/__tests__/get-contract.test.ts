import { describe, expect, it } from "bun:test";
import { registerGetContract } from "../get-contract.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  getErrorText,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

describe("get_contract", () => {
  it("allows readonly clients to read the contract manifest", async () => {
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupMcpClient(
      registerGetContract,
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_contract",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.service).toBe("open-brain");
      expect(parsed.schema_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.capabilities.map((c: { name: string }) => c.name)).toContain(
        "lane_upsert",
      );
    } finally {
      await cleanup();
    }
  });

  it("denies unauthenticated contract reads", async () => {
    const { client, cleanup } = await setupMcpClient(
      registerGetContract,
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      null,
    );

    try {
      const result = await client.callTool({
        name: "get_contract",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });
});
