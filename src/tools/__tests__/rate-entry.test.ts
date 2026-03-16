import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerRateEntry } from "../rate-entry.ts";
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
  registerRateEntry(server, deps);

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

describe("rate_entry", () => {
  describe("admin role -- score 1.0", () => {
    it("sets usefulness_score and returns result", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return {
            rows: [{ id: "test-uuid", usefulness_score: 1.0 }],
          };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "rate_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440000",
            score: 1.0,
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("test-uuid");
        expect(parsed.table).toBe("thoughts");
        expect(parsed.usefulness_score).toBe(1.0);

        // Verify SQL shape
        expect(queryCalls.length).toBe(1);
        const [sql, params] = queryCalls[0];
        expect(sql).toContain("UPDATE");
        expect(sql).toContain("usefulness_score");
        expect(sql).toContain("archived_at IS NULL");
        expect(sql).toContain("RETURNING");
        expect(params[0]).toBe(1.0);
        expect(params[1]).toBe("550e8400-e29b-41d4-a716-446655440000");
      } finally {
        await cleanup();
      }
    });
  });

  describe("score 0.0 -- thumbs down", () => {
    it("sets usefulness_score to 0.0", async () => {
      const mockPool = {
        query: async () => ({
          rows: [{ id: "zero-uuid", usefulness_score: 0.0 }],
        }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "rate_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440001",
            score: 0.0,
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.usefulness_score).toBe(0.0);
      } finally {
        await cleanup();
      }
    });
  });

  describe("score 0.5 -- explicit float", () => {
    it("sets usefulness_score to 0.5", async () => {
      const mockPool = {
        query: async () => ({
          rows: [{ id: "half-uuid", usefulness_score: 0.5 }],
        }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "rate_entry",
          arguments: {
            table: "decisions",
            id: "550e8400-e29b-41d4-a716-446655440002",
            score: 0.5,
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.usefulness_score).toBe(0.5);
      } finally {
        await cleanup();
      }
    });
  });

  describe("agent role -- has write permission", () => {
    it("succeeds because agent can write to thoughts", async () => {
      const mockPool = {
        query: async () => ({
          rows: [{ id: "agent-uuid", usefulness_score: 0.8 }],
        }),
      };
      const auth: AuthInfo = { role: "agent", clientId: "agent-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "rate_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440003",
            score: 0.8,
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.usefulness_score).toBe(0.8);
      } finally {
        await cleanup();
      }
    });
  });

  describe("readonly role -- permission denied", () => {
    it("returns isError because readonly cannot write", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      const auth: AuthInfo = { role: "readonly", clientId: "ro-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "rate_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440004",
            score: 0.5,
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

  describe("not found or archived -- 0 rows affected", () => {
    it("returns 'Cannot rate archived entry' when UPDATE returns 0 rows", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }), // 0 rows = not found or archived
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "rate_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440005",
            score: 1.0,
          },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Cannot rate archived entry");
      } finally {
        await cleanup();
      }
    });
  });
});
