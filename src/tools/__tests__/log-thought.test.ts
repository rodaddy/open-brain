import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerLogThought } from "../log-thought.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

interface MockPool {
  query: (...args: any[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

function createMockPool(
  rows: Record<string, unknown>[] = [{ id: "test-uuid" }],
): MockPool {
  return {
    query: async () => ({ rows }),
  };
}

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

async function setupToolClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  mockEmbed: ReturnType<typeof createMockEmbed>,
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: mockEmbed };
  registerLogThought(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  // Inject authInfo into every client message
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

describe("log_thought", () => {
  describe("success with embedding", () => {
    it("inserts content, tags, source, created_by, embedding, content_hash and returns { id, embedded: true }", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [{ id: "test-uuid" }] };
        },
      };
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "A test thought", tags: ["test", "unit"] },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        const parsed = JSON.parse(text);
        expect(parsed.id).toBe("test-uuid");
        expect(parsed.embedded).toBe(true);

        // Verify SQL parameters
        expect(queryCalls.length).toBe(1);
        const [sql, params] = queryCalls[0];
        expect(sql).toContain("INSERT INTO thoughts");
        expect(sql).toContain("ON CONFLICT (content_hash)");
        expect(params[0]).toBe("A test thought"); // content
        expect(params[1]).toEqual(["test", "unit"]); // tags (original, not enriched -- extraction is fire-and-forget)
        expect(params[2]).toBe("test-client"); // created_by
        // params[3] = embedding (toSql result)
        expect(params[3]).toBeTruthy(); // embedding should be non-null
        // params[4] = content_hash
        expect(typeof params[4]).toBe("string");
        expect(params[4].length).toBeGreaterThan(0);
        expect(params.length).toBe(7);
      } finally {
        await cleanup();
      }
    });
  });

  describe("embedding failure (graceful degradation)", () => {
    it("inserts with NULL embedding and returns { id, embedded: false }", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [{ id: "degraded-uuid" }] };
        },
      };
      const mockEmbed = createMockEmbed(null); // Embedding fails
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "Thought without embedding" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("degraded-uuid");
        expect(parsed.embedded).toBe(false);

        // Verify NULL embedding in SQL params
        const [, params] = queryCalls[0];
        expect(params[3]).toBeNull(); // embedding should be null
      } finally {
        await cleanup();
      }
    });
  });

  describe("duplicate content (content_hash conflict)", () => {
    it("returns merged: true when upsert merges tags on conflict", async () => {
      const mockPool = {
        query: async () => ({
          rows: [{ id: "existing-uuid", is_new: false }],
        }),
      };
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "Duplicate content" },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        const parsed = JSON.parse(text);
        expect(parsed.merged).toBe(true);
        expect(parsed.id).toBe("existing-uuid");
      } finally {
        await cleanup();
      }
    });
  });

  describe("permission denied", () => {
    it("returns isError: true when role cannot write thoughts", async () => {
      const mockPool = createMockPool();
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "readonly", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool as any,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "Should be denied" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });

    it("returns isError: true when auth is missing", async () => {
      // No auth injection -- send without authInfo
      const server = new McpServer({ name: "test", version: "1.0.0" });
      const mockPool = createMockPool();
      const deps: ToolDeps = {
        pool: mockPool as any,
        embedFn: createMockEmbed(),
      };
      registerLogThought(server, deps);

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      // Do NOT inject authInfo
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "No auth" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});
