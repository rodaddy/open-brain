import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerLaneUpsert } from "../lane-upsert.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

function createThrowingEmbed(error: Error) {
  return async (_text: string): Promise<number[] | null> => {
    throw error;
  };
}

async function setupToolClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  auth: AuthInfo,
  embedFn?: (text: string) => Promise<number[] | null>,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool: mockPool as any,
    embedFn: embedFn ?? createMockEmbed(),
  };
  registerLaneUpsert(server, deps);

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

describe("lane_upsert", () => {
  // ── AUTH PATHS ──

  it("denies write when auth is missing entirely", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: mockPool as any,
      embedFn: createMockEmbed(),
    };
    registerLaneUpsert(server, deps);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    // No authInfo injection at all
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "test" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("denies write for discord role (write-thoughts-only)", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = { role: "discord", clientId: "random-user" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "test-lane" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("denies write for readonly role", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "test-lane" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("allows admin role", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-1",
            is_new: true,
            status: "active",
            updated_at: "2026-06-07T15:30:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "test" },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  it("allows agent role", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-2",
            is_new: true,
            status: "active",
            updated_at: "2026-06-07T15:30:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "test" },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  it("allows n8n role", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-3",
            is_new: true,
            status: "active",
            updated_at: "2026-06-07T15:30:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "n8n", clientId: "n8n-worker" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "test" },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  // ── CREATE vs UPDATE ──

  it("creates a new lane — is_new=true, full field propagation", async () => {
    let capturedParams: any[] | undefined;
    const mockPool = {
      query: async (_sql: string, params?: any[]) => {
        capturedParams = params;
        return {
          rows: [
            {
              id: "uuid-new",
              is_new: true,
              status: "active",
              updated_at: "2026-06-07T15:30:00Z",
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: {
          session_key: "ob-v2-session-lanes",
          namespace: "collab",
          project: "open-brain",
          agent: "skippy",
          source: "discord",
          channel_id: "123456",
          thread_id: "789",
          topic: "Building session lane schema",
          current_context_md: "## Session Lanes\nMigration 010 written.",
          metadata: { pr: 42, branch: "feat/session-lanes" },
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.id).toBe("uuid-new");
      expect(parsed.session_key).toBe("ob-v2-session-lanes");
      expect(parsed.namespace).toBe("collab");
      expect(parsed.is_new).toBe(true);
      expect(parsed.status).toBe("active");
      expect(parsed.embedded).toBe(true);

      // Verify all params made it to the query
      expect(capturedParams![0]).toBe("ob-v2-session-lanes"); // session_key
      expect(capturedParams![1]).toBe("collab"); // namespace
      expect(capturedParams![2]).toBeNull(); // status (null = DB DEFAULT 'active')
      expect(capturedParams![3]).toBe("skippy"); // agent
      expect(capturedParams![4]).toBe("discord"); // source
      expect(capturedParams![5]).toBe("123456"); // channel_id
      expect(capturedParams![6]).toBe("789"); // thread_id
      expect(capturedParams![7]).toBe("open-brain"); // project
      expect(capturedParams![8]).toBe("Building session lane schema"); // topic
      expect(capturedParams![9]).toContain("Migration 010"); // current_context_md
      expect(JSON.parse(capturedParams![10] as string)).toEqual({
        pr: 42,
        branch: "feat/session-lanes",
      }); // metadata
    } finally {
      await cleanup();
    }
  });

  it("updates an existing lane — is_new=false on conflict", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-existing",
            is_new: false,
            status: "active",
            updated_at: "2026-06-07T16:00:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: {
          session_key: "ob-v2-session-lanes",
          current_context_md: "## Updated context\nTests passing.",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.is_new).toBe(false);
      expect(parsed.embedded).toBe(true);
    } finally {
      await cleanup();
    }
  });

  // ── NAMESPACE DEFAULTING ──

  it("defaults namespace to auth.clientId when not provided", async () => {
    let capturedParams: any[] | undefined;
    const mockPool = {
      query: async (_sql: string, params?: any[]) => {
        capturedParams = params;
        return {
          rows: [
            {
              id: "uuid-ns",
              is_new: true,
              status: "active",
              updated_at: "2026-06-07T15:30:00Z",
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "bilby-agent" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "my-lane" },
      });

      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.namespace).toBe("bilby-agent");
      expect(capturedParams![1]).toBe("bilby-agent"); // namespace param
    } finally {
      await cleanup();
    }
  });

  it("uses explicit namespace when provided", async () => {
    let capturedParams: any[] | undefined;
    const mockPool = {
      query: async (_sql: string, params?: any[]) => {
        capturedParams = params;
        return {
          rows: [
            {
              id: "uuid-ns2",
              is_new: true,
              status: "active",
              updated_at: "2026-06-07T15:30:00Z",
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "shared-lane", namespace: "collab" },
      });

      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.namespace).toBe("collab");
      expect(capturedParams![1]).toBe("collab");
    } finally {
      await cleanup();
    }
  });

  // ── STATUS TRANSITIONS ──

  it("wraps a lane — status=wrapped", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-wrap",
            is_new: false,
            status: "wrapped",
            updated_at: "2026-06-07T17:00:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "done-lane", status: "wrapped" },
      });

      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.status).toBe("wrapped");
    } finally {
      await cleanup();
    }
  });

  it("archives a lane — status=archived", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-arch",
            is_new: false,
            status: "archived",
            updated_at: "2026-06-07T18:00:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "old-lane", status: "archived" },
      });

      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.status).toBe("archived");
    } finally {
      await cleanup();
    }
  });

  // ── EMBEDDING PATHS ──

  it("skips embedding when no context or topic provided", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-noembed",
            is_new: true,
            status: "active",
            updated_at: "2026-06-07T15:30:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "bare-lane" },
      });

      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.embedded).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("embeds from topic when current_context_md is absent", async () => {
    let embedCalled = false;
    const embedFn = async (text: string) => {
      embedCalled = true;
      expect(text).toContain("my topic");
      return Array(768).fill(0.1);
    };
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-topic",
            is_new: true,
            status: "active",
            updated_at: "2026-06-07T15:30:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth, embedFn);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "topic-lane", topic: "my topic" },
      });

      expect(embedCalled).toBe(true);
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.embedded).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("returns null embedding when embedFn returns null (graceful degradation)", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-nullembed",
            is_new: true,
            status: "active",
            updated_at: "2026-06-07T15:30:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(
      mockPool,
      auth,
      createMockEmbed(null),
    );

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: {
          session_key: "null-embed-lane",
          current_context_md: "some context",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.embedded).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("continues without embedding when embedFn throws (error resilience)", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-embedfail",
            is_new: true,
            status: "active",
            updated_at: "2026-06-07T15:30:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(
      mockPool,
      auth,
      createThrowingEmbed(new Error("LiteLLM timeout")),
    );

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: {
          session_key: "embed-crash-lane",
          current_context_md: "context that triggers embed failure",
        },
      });

      // Should succeed with embedded=false, NOT crash
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.embedded).toBe(false);
    } finally {
      await cleanup();
    }
  });

  // ── DATABASE ERROR PATH ──

  it("returns isError=true with message when DB query throws", async () => {
    const mockPool = {
      query: async () => {
        throw new Error("connection refused");
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "db-fail-lane" },
      });

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("connection refused");
      expect((result.content as any)[0].text).toContain("Database error");
    } finally {
      await cleanup();
    }
  });

  // ── METADATA HANDLING ──

  it("defaults metadata to empty object when not provided", async () => {
    let capturedParams: any[] | undefined;
    const mockPool = {
      query: async (_sql: string, params?: any[]) => {
        capturedParams = params;
        return {
          rows: [
            {
              id: "uuid-nometa",
              is_new: true,
              status: "active",
              updated_at: "2026-06-07T15:30:00Z",
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "no-meta-lane" },
      });

      // metadata param is at index 10
      expect(JSON.parse(capturedParams![10] as string)).toEqual({});
    } finally {
      await cleanup();
    }
  });

  // ── EXPLICIT FIELD CLEARING ──

  it("sends null for agent param and true for clear flag when agent is empty string", async () => {
    let capturedParams: any[] | undefined;
    const mockPool = {
      query: async (_sql: string, params?: any[]) => {
        capturedParams = params;
        return {
          rows: [
            {
              id: "uuid-clear",
              is_new: false,
              status: "active",
              updated_at: "2026-06-07T15:30:00Z",
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "clear-test", agent: "" },
      });

      // agent param ($4) should be null (clearable("") => null)
      expect(capturedParams![3]).toBeNull();
      // agent clear flag ($17) should be true
      expect(capturedParams![16]).toBe(true);
    } finally {
      await cleanup();
    }
  });

  // ── STATUS PRESERVATION ──

  it("passes null for status when status param is omitted (preserves existing)", async () => {
    let capturedParams: any[] | undefined;
    const mockPool = {
      query: async (_sql: string, params?: any[]) => {
        capturedParams = params;
        return {
          rows: [
            {
              id: "uuid-preserve",
              is_new: false,
              status: "wrapped",
              updated_at: "2026-06-07T15:30:00Z",
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "status-preserve", topic: "updated topic" },
      });

      // status param ($3) should be null so CASE WHEN preserves existing
      expect(capturedParams![2]).toBeNull();
    } finally {
      await cleanup();
    }
  });

  // ── NULL OPTIONAL FIELDS ──

  it("passes null for all optional fields when omitted", async () => {
    let capturedParams: any[] | undefined;
    const mockPool = {
      query: async (_sql: string, params?: any[]) => {
        capturedParams = params;
        return {
          rows: [
            {
              id: "uuid-min",
              is_new: true,
              status: "active",
              updated_at: "2026-06-07T15:30:00Z",
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "minimal" },
      });

      // session_key, namespace, status are set; rest should be null
      expect(capturedParams![0]).toBe("minimal"); // session_key
      expect(capturedParams![3]).toBeNull(); // agent
      expect(capturedParams![4]).toBeNull(); // source
      expect(capturedParams![5]).toBeNull(); // channel_id
      expect(capturedParams![6]).toBeNull(); // thread_id
      expect(capturedParams![7]).toBeNull(); // project
      expect(capturedParams![8]).toBeNull(); // topic
      expect(capturedParams![9]).toBeNull(); // current_context_md
    } finally {
      await cleanup();
    }
  });
});
