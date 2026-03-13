import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrainServer } from "../../server.ts";
import { registerAllTools } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

/**
 * Protocol-level tests using InMemoryTransport.
 * Tests the full MCP round-trip: client -> transport -> server -> tool -> response.
 */

function createMockPool(
  rows: Record<string, unknown>[] = [{ id: "proto-uuid" }],
) {
  return {
    query: async () => ({ rows }),
  } as any;
}

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

async function createProtocolClient(
  auth: AuthInfo,
  poolRows: Record<string, unknown>[] = [{ id: "proto-uuid" }],
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createBrainServer();
  registerAllTools(server, {
    pool: createMockPool(poolRows),
    embedFn: createMockEmbed(),
  });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message: any, options?: any) => {
    return originalSend(message, { ...options, authInfo: auth });
  };

  const client = new Client({ name: "proto-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("Protocol tests: write tools via InMemoryTransport", () => {
  describe("log_thought via protocol", () => {
    it("returns valid JSON with id using admin auth", async () => {
      const auth: AuthInfo = { role: "admin", clientId: "proto-admin" };
      const { client, cleanup } = await createProtocolClient(auth);

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "Protocol test thought", tags: ["protocol"] },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        const parsed = JSON.parse(text);
        expect(parsed.id).toBe("proto-uuid");
        expect(typeof parsed.embedded).toBe("boolean");
      } finally {
        await cleanup();
      }
    });

    it("returns validation error for empty content (Zod min(1))", async () => {
      const auth: AuthInfo = { role: "admin", clientId: "proto-admin" };
      const { client, cleanup } = await createProtocolClient(auth);

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "" },
        });

        // SDK should reject validation against Zod min(1)
        expect(result.isError).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describe("log_decision via protocol", () => {
    it("returns valid JSON with id using admin auth", async () => {
      const auth: AuthInfo = { role: "admin", clientId: "proto-admin" };
      const { client, cleanup } = await createProtocolClient(auth);

      try {
        const result = await client.callTool({
          name: "log_decision",
          arguments: {
            title: "Protocol Decision",
            rationale: "Testing full round-trip",
          },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        const parsed = JSON.parse(text);
        expect(parsed.id).toBe("proto-uuid");
        expect(typeof parsed.embedded).toBe("boolean");
      } finally {
        await cleanup();
      }
    });

    it("returns isError: true with readonly role", async () => {
      const auth: AuthInfo = { role: "readonly", clientId: "proto-readonly" };
      const { client, cleanup } = await createProtocolClient(auth);

      try {
        const result = await client.callTool({
          name: "log_decision",
          arguments: {
            title: "Should Fail",
            rationale: "Readonly cannot write decisions",
          },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });
  });
});
