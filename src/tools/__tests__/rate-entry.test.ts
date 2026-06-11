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
    it("returns { id, table, usefulness_score } for valid rating", async () => {
      const mockPool = {
        query: async () => ({
          rows: [{ id: "test-uuid", usefulness_score: 1.0 }],
        }),
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
      } finally {
        await cleanup();
      }
    });

    it("uses a namespace predicate for delegated admin", async () => {
      const calls: Array<{ sql: string; params?: any[] }> = [];
      const mockPool = {
        query: async (sql: string, params?: any[]) => {
          calls.push({ sql, params });
          return {
            rows: [{ id: "test-uuid", usefulness_score: 1.0 }],
          };
        },
      };
      const auth: AuthInfo = {
        role: "admin",
        clientId: "bilby",
        tokenClientId: "admin",
        namespaceSource: "header",
      };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "rate_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440010",
            score: 1.0,
          },
        });

        expect(result.isError).toBeFalsy();
        expect(calls[0]!.sql).toContain("namespace = ANY($3::text[])");
        expect(calls[0]!.params).toEqual([
          1,
          "550e8400-e29b-41d4-a716-446655440010",
          ["bilby"],
        ]);
      } finally {
        await cleanup();
      }
    });
  });

  describe("score 0.0 -- thumbs down", () => {
    it("returns usefulness_score of 0.0", async () => {
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
    it("returns usefulness_score of 0.5", async () => {
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
