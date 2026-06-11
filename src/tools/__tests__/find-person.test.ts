import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerFindPerson } from "../find-person.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockPool(rows: Record<string, unknown>[] = []) {
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
  registerFindPerson(server, deps);

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

const samplePerson = {
  id: "person-uuid-1",
  person_name: "Alice Johnson",
  context: "Engineering lead at Google",
  warmth: 4,
  last_contact: "2026-01-15",
  notes: "Met at GopherCon 2025",
  tags: ["engineering", "google"],
  created_at: "2026-01-01T00:00:00Z",
};

const samplePerson2 = {
  id: "person-uuid-2",
  person_name: "Alice Smith",
  context: "Product manager at Stripe",
  warmth: 3,
  last_contact: "2026-02-10",
  notes: null,
  tags: ["product", "stripe"],
  created_at: "2026-01-05T00:00:00Z",
};

describe("find_person", () => {
  describe("name mode", () => {
    it("returns person details matching partial name", async () => {
      const mockPool = {
        query: async () => ({ rows: [samplePerson, samplePerson2] }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };
      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "find_person",
          arguments: { query: "Alice", mode: "name" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBe(2);
        expect(parsed[0].person_name).toBe("Alice Johnson");
        expect(parsed[0].context).toBe("Engineering lead at Google");
        expect(parsed[0].warmth).toBe(4);
        expect(parsed[0].last_contact).toBe("2026-01-15");
        expect(parsed[0].notes).toBe("Met at GopherCon 2025");
        expect(parsed[0].tags).toEqual(["engineering", "google"]);
      } finally {
        await cleanup();
      }
    });

    it("scopes name search to readable namespaces", async () => {
      const calls: Array<{ sql: string; params?: any[] }> = [];
      const mockPool = {
        query: async (sql: string, params?: any[]) => {
          calls.push({ sql, params });
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "agent", clientId: "bilby" };
      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        await client.callTool({
          name: "find_person",
          arguments: { query: "Alice", mode: "name" },
        });

        expect(calls[0]!.sql).toContain("namespace = ANY($4::text[])");
        expect(calls[0]!.params).toEqual(["%Alice%", 5, 0, ["bilby", "collab"]]);
      } finally {
        await cleanup();
      }
    });
  });

  describe("semantic mode", () => {
    it("returns results with distance field for semantic search", async () => {
      const semanticRow = {
        ...samplePerson,
        distance: 0.123,
      };
      const mockPool = {
        query: async () => ({ rows: [semanticRow] }),
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
          name: "find_person",
          arguments: { query: "who do I know at Google", mode: "semantic" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed[0].distance).toBe(0.123);
        expect(parsed[0].person_name).toBe("Alice Johnson");
      } finally {
        await cleanup();
      }
    });

    it("scopes semantic search to readable namespaces", async () => {
      const calls: Array<{ sql: string; params?: any[] }> = [];
      const mockPool = {
        query: async (sql: string, params?: any[]) => {
          calls.push({ sql, params });
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "agent", clientId: "bilby" };
      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        await client.callTool({
          name: "find_person",
          arguments: { query: "Alice", mode: "semantic" },
        });

        expect(calls[0]!.sql).toContain("namespace = ANY($4::text[])");
        expect(calls[0]!.params?.slice(1)).toEqual([5, 0, ["bilby", "collab"]]);
      } finally {
        await cleanup();
      }
    });

    it("returns isError when embedding generation fails", async () => {
      const mockPool = createMockPool();
      const mockEmbed = createMockEmbed(null); // Embedding fails
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };
      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "find_person",
          arguments: { query: "search query", mode: "semantic" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Failed to generate query embedding");
      } finally {
        await cleanup();
      }
    });
  });

  describe("default mode", () => {
    it("defaults to name mode when mode is omitted", async () => {
      const mockPool = {
        query: async () => ({ rows: [samplePerson] }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };
      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "find_person",
          arguments: { query: "Alice" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed[0].person_name).toBe("Alice Johnson");
      } finally {
        await cleanup();
      }
    });
  });

  describe("permission denied", () => {
    it("returns isError: true for discord role (NONE on relationships)", async () => {
      const mockPool = createMockPool();
      const auth: AuthInfo = { role: "discord", clientId: "discord-bot" };
      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "find_person",
          arguments: { query: "Alice" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });

    it("returns isError: true when auth is missing", async () => {
      const server = new McpServer({ name: "test", version: "1.0.0" });
      const deps: ToolDeps = {
        pool: createMockPool() as any,
        embedFn: createMockEmbed(),
      };
      registerFindPerson(server, deps);

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      // Do NOT inject authInfo
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      try {
        const result = await client.callTool({
          name: "find_person",
          arguments: { query: "Alice" },
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

  describe("no results", () => {
    it("returns informational message without isError", async () => {
      const mockPool = createMockPool([]); // Empty results
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };
      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "find_person",
          arguments: { query: "Nonexistent Person", mode: "name" },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        expect(text).toContain("No people found matching");
        expect(text).toContain("Nonexistent Person");
      } finally {
        await cleanup();
      }
    });
  });
});
