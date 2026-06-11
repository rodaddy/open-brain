import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerFindDuplicates } from "../find-duplicates.ts";
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
  registerFindDuplicates(server, deps);

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

describe("find_duplicates", () => {
  it("returns duplicate pairs", async () => {
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("embedding <=> b.embedding")) {
          return {
            rows: [
              {
                id_a: "uuid-1",
                preview_a: "First entry content",
                id_b: "uuid-2",
                preview_b: "Almost identical content",
                distance: 0.03,
              },
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
        name: "find_duplicates",
        arguments: { table: "thoughts", threshold: 0.08 },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.duplicates_found).toBe(1);
      expect(parsed.duplicates[0].entry_a.id).toBe("uuid-1");
      expect(parsed.duplicates[0].entry_b.id).toBe("uuid-2");
      expect(parsed.duplicates[0].distance).toBe(0.03);
    } finally {
      await cleanup();
    }
  });

  it("returns empty when no duplicates found", async () => {
    const mockPool = {
      query: async () => ({ rows: [] }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "find_duplicates",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.duplicates_found).toBe(0);
      expect(parsed.duplicates).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("scopes duplicate pair reads to readable namespaces", async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "find_duplicates",
        arguments: { table: "thoughts", threshold: 0.08 },
      });

      expect(result.isError).toBeFalsy();
      expect(calls[0]!.sql).toContain("a.namespace = ANY($3::text[])");
      expect(calls[0]!.sql).toContain("b.namespace = ANY($4::text[])");
      expect(calls[0]!.params).toEqual([
        0.08,
        20,
        ["bilby", "collab"],
        ["bilby", "collab"],
      ]);
    } finally {
      await cleanup();
    }
  });

  it("denies discord role (no read access)", async () => {
    const mockPool = {
      query: async () => ({ rows: [] }),
    };
    const auth: AuthInfo = { role: "discord", clientId: "discord-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "find_duplicates",
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
