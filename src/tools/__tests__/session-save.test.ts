import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSessionSave } from "../session-save.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

async function setupToolClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  mockEmbed: ReturnType<typeof createMockEmbed>,
  auth?: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: mockEmbed };
  registerSessionSave(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  if (auth) {
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message: any, options?: any) => {
      return originalSend(message, { ...options, authInfo: auth });
    };
  }

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

describe("session_save", () => {
  describe("success with embedding", () => {
    it("inserts summary + project + TEXT[] arrays + embedding, returns { id, embedded: true }", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [{ id: "session-uuid" }] };
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
          name: "session_save",
          arguments: {
            summary: "Completed auth implementation",
            project: "open-brain",
            tags: ["auth", "phase-1"],
            blockers: ["Need API key"],
            next_steps: ["Write tests", "Deploy"],
            key_decisions: ["Use JWT", "30min TTL"],
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("session-uuid");
        expect(parsed.embedded).toBe(true);

        // Verify SQL parameters
        expect(queryCalls.length).toBe(1);
        const [sql, params] = queryCalls[0];
        expect(sql).toContain("INSERT INTO sessions");
        expect(sql).toContain("ON CONFLICT (content_hash)");
        expect(params[0]).toBe("open-brain"); // project
        expect(params[1]).toBe("Completed auth implementation"); // summary
        expect(params[2]).toEqual(["auth", "phase-1"]); // tags -- JS array
        expect(params[3]).toEqual(["Need API key"]); // blockers -- JS array
        expect(params[4]).toEqual(["Write tests", "Deploy"]); // next_steps -- JS array
        expect(params[5]).toEqual(["Use JWT", "30min TTL"]); // key_decisions -- JS array
        expect(params[6]).toBe("test-client"); // created_by
        expect(params[7]).toBeTruthy(); // embedding (toSql result)
        expect(typeof params[8]).toBe("string"); // content_hash
        expect(params[8].length).toBeGreaterThan(0);
      } finally {
        await cleanup();
      }
    });
  });

  describe("TEXT[] array handling", () => {
    it("passes JS arrays directly for TEXT[] columns (NOT JSON.stringify)", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [{ id: "array-uuid" }] };
        },
      };
      const auth: AuthInfo = { role: "agent", clientId: "test-agent" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        await client.callTool({
          name: "session_save",
          arguments: {
            summary: "Array test",
            tags: ["a", "b"],
            blockers: ["c"],
            next_steps: ["d", "e"],
            key_decisions: ["f"],
          },
        });

        const [, params] = queryCalls[0];
        // Verify params are actual arrays, not JSON strings
        expect(Array.isArray(params[2])).toBe(true); // tags
        expect(Array.isArray(params[3])).toBe(true); // blockers
        expect(Array.isArray(params[4])).toBe(true); // next_steps
        expect(Array.isArray(params[5])).toBe(true); // key_decisions
        // Explicitly NOT stringified
        expect(typeof params[2]).not.toBe("string");
        expect(typeof params[3]).not.toBe("string");
        expect(typeof params[4]).not.toBe("string");
        expect(typeof params[5]).not.toBe("string");
      } finally {
        await cleanup();
      }
    });
  });

  describe("embedding failure (graceful degradation)", () => {
    it("inserts with NULL embedding, returns { id, embedded: false }", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [{ id: "degraded-uuid" }] };
        },
      };
      const mockEmbed = createMockEmbed(null);
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: { summary: "Session without embedding" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("degraded-uuid");
        expect(parsed.embedded).toBe(false);

        const [, params] = queryCalls[0];
        expect(params[7]).toBeNull(); // embedding null
        expect(params[9]).toBeNull(); // embedded_at null
        expect(params[10]).toBeNull(); // embedding_model null
      } finally {
        await cleanup();
      }
    });
  });

  describe("duplicate content (content_hash conflict)", () => {
    it("returns Duplicate message without isError", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }), // Empty rows = ON CONFLICT DO NOTHING
      };
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: { summary: "Duplicate session content" },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        expect(text).toContain("Duplicate");
      } finally {
        await cleanup();
      }
    });
  });

  describe("permission denied", () => {
    it("returns isError for readonly role", async () => {
      const mockPool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "readonly", clientId: "test-readonly" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: { summary: "Should be denied" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });

    it("returns isError for discord role", async () => {
      const mockPool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "discord", clientId: "test-discord" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: { summary: "Discord denied" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });

    it("returns isError when auth is missing", async () => {
      const server = new McpServer({ name: "test", version: "1.0.0" });
      const mockPool = { query: async () => ({ rows: [] }) };
      const deps: ToolDeps = {
        pool: mockPool as any,
        embedFn: createMockEmbed(),
      };
      registerSessionSave(server, deps);

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: { summary: "No auth" },
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

  describe("optional fields default handling", () => {
    it("defaults project to null and arrays to empty when omitted", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [{ id: "defaults-uuid" }] };
        },
      };
      const auth: AuthInfo = { role: "n8n", clientId: "test-n8n" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: { summary: "Minimal session" },
        });

        expect(result.isError).toBeFalsy();

        const [, params] = queryCalls[0];
        expect(params[0]).toBeNull(); // project defaults to null
        expect(params[2]).toEqual([]); // tags defaults to empty array
        expect(params[3]).toEqual([]); // blockers defaults to empty array
        expect(params[4]).toEqual([]); // next_steps defaults to empty array
        expect(params[5]).toEqual([]); // key_decisions defaults to empty array
      } finally {
        await cleanup();
      }
    });
  });
});
