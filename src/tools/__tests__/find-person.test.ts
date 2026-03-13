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
    it("returns person details matching partial name via ILIKE", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [samplePerson, samplePerson2] };
        },
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

        // Verify SQL uses ILIKE with %query%
        expect(queryCalls.length).toBe(1);
        const [sql, params] = queryCalls[0];
        expect(sql).toContain("ILIKE");
        expect(params[0]).toBe("%Alice%");
      } finally {
        await cleanup();
      }
    });

    it("escapes ILIKE special characters (% and _)", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };
      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        await client.callTool({
          name: "find_person",
          arguments: { query: "100%_done", mode: "name" },
        });

        const [, params] = queryCalls[0];
        // % should be escaped to \% and _ to \_
        expect(params[0]).toBe("%100\\%\\_done%");
      } finally {
        await cleanup();
      }
    });
  });

  describe("semantic mode", () => {
    it("calls embedFn and uses cosine distance, returns results with distance field", async () => {
      const queryCalls: any[] = [];
      const semanticRow = {
        ...samplePerson,
        distance: 0.123,
      };
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [semanticRow] };
        },
      };
      let embedCalled = false;
      const mockEmbed = async (_text: string) => {
        embedCalled = true;
        return Array(768).fill(0.1);
      };
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
        expect(embedCalled).toBe(true);

        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed[0].distance).toBe(0.123);
        expect(parsed[0].person_name).toBe("Alice Johnson");

        // Verify SQL uses cosine distance operator
        const [sql, params] = queryCalls[0];
        expect(sql).toContain("<=>");
        // First param should be the embedding (non-null, toSql output)
        expect(params[0]).toBeTruthy();
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
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [samplePerson] };
        },
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
        // Should use ILIKE (name mode), not embedding
        const [sql] = queryCalls[0];
        expect(sql).toContain("ILIKE");
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

  describe("limit parameter", () => {
    it("defaults to 5 and respects custom limit", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      // Test default limit
      const { client: client1, cleanup: cleanup1 } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        await client1.callTool({
          name: "find_person",
          arguments: { query: "Alice", mode: "name" },
        });

        const [, params1] = queryCalls[0];
        expect(params1[1]).toBe(5); // Default limit
      } finally {
        await cleanup1();
      }

      // Test custom limit
      queryCalls.length = 0;
      const { client: client2, cleanup: cleanup2 } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        await client2.callTool({
          name: "find_person",
          arguments: { query: "Alice", mode: "name", limit: 10 },
        });

        const [, params2] = queryCalls[0];
        expect(params2[1]).toBe(10); // Custom limit
      } finally {
        await cleanup2();
      }
    });
  });
});
