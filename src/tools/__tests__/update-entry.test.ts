import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerUpdateEntry } from "../update-entry.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  const calls: string[] = [];
  const fn = async (text: string) => {
    calls.push(text);
    return result;
  };
  return { fn, calls };
}

/** Creates a mock pool that routes both pool.query and pool.connect().query through the same function */
function createMockPool(queryFn: (...args: any[]) => Promise<{ rows: any[] }>) {
  const txAwareQuery = async (...args: any[]) => {
    // Passthrough BEGIN/COMMIT/ROLLBACK as no-ops
    if (
      typeof args[0] === "string" &&
      ["BEGIN", "COMMIT", "ROLLBACK"].includes(args[0])
    ) {
      return { rows: [] };
    }
    return queryFn(...args);
  };
  const mockClient = {
    query: txAwareQuery,
    release: () => {},
  };
  return {
    query: txAwareQuery,
    connect: async () => mockClient,
  };
}

async function setupToolClient(
  mockPool: ReturnType<typeof createMockPool>,
  mockEmbed: {
    fn: (text: string) => Promise<number[] | null>;
    calls: string[];
  },
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: mockEmbed.fn };
  registerUpdateEntry(server, deps);

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

describe("update_entry", () => {
  describe("admin role -- update thoughts content", () => {
    it("re-embeds content, recalculates content_hash, returns updated+embedded", async () => {
      const queryCalls: any[] = [];
      let dataCallCount = 0;
      const mockPool = createMockPool(async (...args: any[]) => {
        queryCalls.push(args);
        dataCallCount++;
        if (dataCallCount === 1) {
          // SELECT existing row
          return {
            rows: [
              {
                id: "test-uuid",
                content: "old content",
                tags: ["old"],
                archived_at: null,
              },
            ],
          };
        }
        if (dataCallCount === 2) {
          // Hash collision check -- no collision
          return { rows: [] };
        }
        // UPDATE RETURNING
        return { rows: [{ id: "test-uuid" }] };
      });
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "update_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440000",
            content: "new content",
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("test-uuid");
        expect(parsed.table).toBe("thoughts");
        expect(parsed.updated).toBe(true);
        expect(parsed.embedded).toBe(true);

        // Verify re-embedding was called with new content
        expect(mockEmbed.calls.length).toBe(1);
        expect(mockEmbed.calls[0]).toBe("new content");

        // Verify SQL: SELECT, hash collision check, UPDATE
        expect(queryCalls.length).toBe(3);
        const [selectSql] = queryCalls[0];
        expect(selectSql).toContain("SELECT");
        expect(selectSql).toContain("FROM thoughts");

        const [hashSql] = queryCalls[1];
        expect(hashSql).toContain("content_hash");
        expect(hashSql).toContain("id !=");

        const [updateSql] = queryCalls[2];
        expect(updateSql).toContain("UPDATE thoughts");
        expect(updateSql).toContain("SET");
        expect(updateSql).toContain("content");
        expect(updateSql).toContain("embedding");
        expect(updateSql).toContain("content_hash");
      } finally {
        await cleanup();
      }
    });
  });

  describe("update decisions title+rationale", () => {
    it("embeds concatenation of title and rationale", async () => {
      let dataCallCount = 0;
      const mockPool = createMockPool(async () => {
        dataCallCount++;
        if (dataCallCount === 1) {
          return {
            rows: [
              {
                id: "dec-uuid",
                title: "old title",
                rationale: "old rationale",
                context: "ctx",
                tags: [],
                archived_at: null,
              },
            ],
          };
        }
        if (dataCallCount === 2) return { rows: [] }; // no hash collision
        return { rows: [{ id: "dec-uuid" }] };
      });
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "update_entry",
          arguments: {
            table: "decisions",
            id: "550e8400-e29b-41d4-a716-446655440001",
            title: "new title",
            rationale: "new rationale",
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.updated).toBe(true);

        // Verify embedding text is title + "\n" + rationale
        expect(mockEmbed.calls[0]).toBe("new title\nnew rationale");
      } finally {
        await cleanup();
      }
    });
  });

  describe("update tags only -- no content change", () => {
    it("does NOT re-embed, just updates tags", async () => {
      let dataCallCount = 0;
      const mockPool = createMockPool(async () => {
        dataCallCount++;
        if (dataCallCount === 1) {
          return {
            rows: [
              {
                id: "tag-uuid",
                content: "unchanged content",
                tags: ["old-tag"],
                archived_at: null,
              },
            ],
          };
        }
        // UPDATE RETURNING (no hash collision check for tags-only)
        return { rows: [{ id: "tag-uuid" }] };
      });
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "update_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440002",
            tags: ["new-tag-1", "new-tag-2"],
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.updated).toBe(true);
        expect(parsed.embedded).toBe(false);

        // Embedding should NOT have been called
        expect(mockEmbed.calls.length).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });

  describe("content hash collision", () => {
    it("returns duplicate content error when hash matches different row", async () => {
      let dataCallCount = 0;
      const mockPool = createMockPool(async () => {
        dataCallCount++;
        if (dataCallCount === 1) {
          return {
            rows: [
              {
                id: "orig-uuid",
                content: "old content",
                tags: [],
                archived_at: null,
              },
            ],
          };
        }
        if (dataCallCount === 2) {
          // Hash collision -- different row has same hash
          return { rows: [{ id: "other-uuid" }] };
        }
        return { rows: [] };
      });
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "update_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440003",
            content: "duplicate content",
          },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Duplicate content");
      } finally {
        await cleanup();
      }
    });
  });

  describe("row not found", () => {
    it("returns 'Not found' when SELECT returns 0 rows", async () => {
      const mockPool = createMockPool(async () => ({ rows: [] }));
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "update_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440004",
            content: "update nonexistent",
          },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Not found");
      } finally {
        await cleanup();
      }
    });
  });

  describe("archived entry guard", () => {
    it("returns error when entry has archived_at set", async () => {
      const mockPool = createMockPool(async () => ({
        rows: [
          {
            id: "archived-uuid",
            content: "archived content",
            tags: [],
            archived_at: new Date("2026-01-01"),
          },
        ],
      }));
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "update_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440005",
            content: "update archived",
          },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("archived");
      } finally {
        await cleanup();
      }
    });
  });

  describe("agent role on thoughts -- has write", () => {
    it("succeeds because agent can write to thoughts", async () => {
      let dataCallCount = 0;
      const mockPool = createMockPool(async () => {
        dataCallCount++;
        if (dataCallCount === 1) {
          return {
            rows: [
              {
                id: "agent-uuid",
                content: "old",
                tags: [],
                archived_at: null,
              },
            ],
          };
        }
        if (dataCallCount === 2) return { rows: [] };
        return { rows: [{ id: "agent-uuid" }] };
      });
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "agent", clientId: "agent-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "update_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440006",
            content: "agent update",
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.updated).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describe("readonly role -- permission denied", () => {
    it("returns isError because readonly cannot write", async () => {
      const mockPool = createMockPool(async () => ({ rows: [] }));
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "readonly", clientId: "ro-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "update_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440007",
            content: "should fail",
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

  describe("embedding failure -- graceful degradation", () => {
    it("still updates content but embedded=false", async () => {
      let dataCallCount = 0;
      const mockPool = createMockPool(async () => {
        dataCallCount++;
        if (dataCallCount === 1) {
          return {
            rows: [
              {
                id: "embed-fail-uuid",
                content: "old",
                tags: [],
                archived_at: null,
              },
            ],
          };
        }
        if (dataCallCount === 2) return { rows: [] }; // no hash collision
        return { rows: [{ id: "embed-fail-uuid" }] };
      });
      const mockEmbed = createMockEmbed(null); // embedding fails
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "update_entry",
          arguments: {
            table: "thoughts",
            id: "550e8400-e29b-41d4-a716-446655440008",
            content: "update with failed embed",
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.updated).toBe(true);
        expect(parsed.embedded).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });

  describe("no valid fields for table", () => {
    it("returns error when providing thoughts fields for sessions table", async () => {
      const mockPool = createMockPool(async () => ({ rows: [] }));
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "update_entry",
          arguments: {
            table: "sessions",
            id: "550e8400-e29b-41d4-a716-446655440009",
            content: "wrong field for sessions",
          },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("No valid fields");
      } finally {
        await cleanup();
      }
    });
  });
});
