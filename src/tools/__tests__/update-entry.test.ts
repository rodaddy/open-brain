import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerUpdateEntry } from "../update-entry.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";
import { contentHash } from "../../embedding.ts";
import { EMBEDDING_TARGETS } from "../../embedding-targets.ts";

/**
 * Extract the content_hash value from a captured UPDATE (SET content_hash = $N).
 * Returns null when the statement did not re-embed (no content_hash SET).
 */
function updateContentHash(sql: string, params: unknown[]): string | null {
  const m = sql.match(/content_hash = \$(\d+)/);
  if (!m) return null;
  return params[Number(m[1]) - 1] as string;
}

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
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
  mockEmbed: (text: string) => Promise<number[] | null>,
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: mockEmbed };
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
    it("returns { id, table, updated: true, embedded: true } when content changes", async () => {
      let dataCallCount = 0;
      const mockPool = createMockPool(async () => {
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
      } finally {
        await cleanup();
      }
    });
  });

  describe("update decisions title+rationale", () => {
    it("returns updated: true for decision with new title and rationale", async () => {
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
        expect(parsed.embedded).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describe("update tags only -- no content change", () => {
    it("returns updated: true, embedded: false (no re-embedding needed)", async () => {
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

    it("locks the initial row lookup to the agent namespace", async () => {
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      const mockPool = createMockPool(
        async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params });
          return { rows: [] };
        },
      );
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
            id: "550e8400-e29b-41d4-a716-446655440010",
            content: "agent update blocked by namespace",
          },
        });

        expect(result.isError).toBe(true);
        expect(calls[0]!.sql).toContain("namespace = ANY($2::text[])");
        expect(calls[0]!.params).toEqual([
          "550e8400-e29b-41d4-a716-446655440010",
          ["agent-client"],
        ]);
      } finally {
        await cleanup();
      }
    });
  });

  describe("namespace-scoped collision checks", () => {
    it("checks content_hash collisions only in the existing row namespace", async () => {
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      let dataCallCount = 0;
      const mockPool = createMockPool(
        async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params });
          dataCallCount++;
          if (dataCallCount === 1) {
            return {
              rows: [
                {
                  id: "agent-uuid",
                  namespace: "agent-client",
                  content: "old",
                  tags: [],
                  archived_at: null,
                },
              ],
            };
          }
          if (dataCallCount === 2) return { rows: [] };
          return { rows: [{ id: "agent-uuid" }] };
        },
      );
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
            id: "550e8400-e29b-41d4-a716-446655440011",
            content: "new content",
          },
        });

        expect(result.isError).toBeFalsy();
        expect(calls[1]!.sql).toContain("namespace = $3");
        expect(calls[1]!.params?.[2]).toBe("agent-client");
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

  describe("canonical convergence -- no source_drift after update", () => {
    it("decision: written content_hash equals the registry sourceHash over the merged row (context/alternatives/tags)", async () => {
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      let dataCallCount = 0;
      const existing = {
        id: "dec-uuid",
        title: "old title",
        rationale: "old rationale",
        context: "old context",
        alternatives: ["keep as-is"],
        tags: ["old"],
        namespace: "admin-client",
        archived_at: null,
      };
      const mockPool = createMockPool(
        async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params });
          dataCallCount++;
          if (dataCallCount === 1) return { rows: [existing] };
          if (dataCallCount === 2) return { rows: [] }; // no hash collision
          return { rows: [{ id: "dec-uuid" }] };
        },
      );
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        // Change only title; context/alternatives/tags come from the existing row.
        const result = await client.callTool({
          name: "update_entry",
          arguments: {
            table: "decisions",
            id: "550e8400-e29b-41d4-a716-446655440020",
            title: "new title",
          },
        });

        expect(result.isError).toBeFalsy();

        // Capture the content_hash the UPDATE wrote.
        const update = calls.find((c) => c.sql.includes("content_hash = $"))!;
        const written = updateContentHash(update.sql, update.params ?? []);
        expect(written).not.toBeNull();

        // The registry recomputes its sourceHash from the FINAL post-update row.
        // If update_entry hashed a different string, repair would flag drift.
        const finalRow = {
          ...existing,
          title: "new title",
        };
        const registryHash = EMBEDDING_TARGETS.decisions!.sourceHash(finalRow);
        expect(written).toBe(registryHash);
        // Sanity: it is NOT the old title+rationale-only hash.
        expect(written).not.toBe(contentHash("new title\nold rationale"));
      } finally {
        await cleanup();
      }
    });

    it("session: written content_hash equals the registry sourceHash (summary|project, ignores key_decisions/next_steps)", async () => {
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      let dataCallCount = 0;
      const existing = {
        id: "sess-uuid",
        summary: "old summary",
        project: "openbrain",
        key_decisions: ["chose canonical builders"],
        next_steps: ["ship it"],
        blockers: [],
        namespace: "admin-client",
        archived_at: null,
      };
      const mockPool = createMockPool(
        async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params });
          dataCallCount++;
          if (dataCallCount === 1) return { rows: [existing] };
          if (dataCallCount === 2) return { rows: [] }; // no hash collision
          return { rows: [{ id: "sess-uuid" }] };
        },
      );
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
            id: "550e8400-e29b-41d4-a716-446655440021",
            summary: "new summary",
            next_steps: ["ship it", "then document"],
          },
        });

        expect(result.isError).toBeFalsy();

        const update = calls.find((c) => c.sql.includes("content_hash = $"))!;
        const written = updateContentHash(update.sql, update.params ?? []);
        expect(written).not.toBeNull();

        const finalRow = {
          ...existing,
          summary: "new summary",
          next_steps: ["ship it", "then document"],
        };
        const registryHash = EMBEDDING_TARGETS.sessions!.sourceHash(finalRow);
        expect(written).toBe(registryHash);
        // Sessions hash summary|project only -- next_steps must not enter the hash.
        expect(written).toBe(contentHash("new summary|openbrain"));
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
