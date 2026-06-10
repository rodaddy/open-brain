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
});
