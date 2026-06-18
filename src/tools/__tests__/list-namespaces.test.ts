import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerListNamespaces } from "../list-namespaces.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

async function setupToolClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: createMockEmbed() };
  registerListNamespaces(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message: any, options?: any) => {
    return originalSend(message, { ...options, authInfo: auth });
  };

  const client = new Client({ name: "test-client", version: "1.0.0" });
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

describe("list_namespaces", () => {
  it("returns namespaces with counts", async () => {
    const mockPool = {
      query: async (sql: string) => {
        if (sql.includes("GROUP BY namespace")) {
          return {
            rows: [
              { table_name: "thoughts", namespace: "collab", count: "15" },
              { table_name: "thoughts", namespace: "skippy", count: "5" },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "list_namespaces",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.namespace_count).toBeGreaterThan(0);
      expect(parsed.namespaces[0]).toEqual({
        namespace: "shared-kb",
        total: 75,
        per_table: { thoughts: 15 },
      });
    } finally {
      await cleanup();
    }
  });

  it("returns physical namespace names in raw view", async () => {
    const mockPool = {
      query: async (sql: string) => {
        if (sql.includes("GROUP BY namespace")) {
          return {
            rows: [
              { table_name: "thoughts", namespace: "collab", count: "15" },
              { table_name: "thoughts", namespace: "shared-kb", count: "5" },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "list_namespaces",
        arguments: { raw: true },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.namespaces.map((ns: any) => ns.namespace)).toContain("collab");
      expect(parsed.namespaces.map((ns: any) => ns.namespace)).toContain("shared-kb");
    } finally {
      await cleanup();
    }
  });

  it("denies discord role", async () => {
    const mockPool = {
      query: async () => ({ rows: [] }),
    };
    const auth: AuthInfo = { role: "discord", clientId: "discord-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "list_namespaces",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      const text = (result.content as any)[0].text;
      expect(text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });
});
