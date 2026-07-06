import { describe, it, expect, afterAll } from "bun:test";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAppendSessionEvent } from "../append-session-event.ts";
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
  registerAppendSessionEvent(server, deps);

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

/** Mock pool that returns a lane for the lookup query, then returns event data for the insert. */
function createLaneFoundPool(
  laneId = "lane-uuid-1",
  eventId = "event-uuid-1",
  createdAt = "2026-06-08T10:00:00Z",
  status = "active",
) {
  return {
    query: async (sql: string, _params?: any[]) => {
      if (sql.includes("ob_session_lanes")) {
        return { rows: [{ id: laneId, status }] };
      }
      // INSERT into ob_session_events
      return { rows: [{ id: eventId, created_at: createdAt }] };
    },
  };
}

/** Mock pool that returns no lanes (lane not found). */
function createLaneNotFoundPool() {
  return {
    query: async (sql: string, _params?: any[]) => {
      if (sql.includes("ob_session_lanes")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe("append_session_event", () => {
  // ── AUTH PATHS ──

  it("denies write when auth is missing entirely", async () => {
    const mockPool = createLaneFoundPool();
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: mockPool as any,
      embedFn: createMockEmbed(),
    };
    registerAppendSessionEvent(server, deps);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          content: "test content",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("denies write for discord role", async () => {
    const mockPool = createLaneFoundPool();
    const auth: AuthInfo = { role: "discord", clientId: "random-user" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          content: "test content",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("denies write for readonly role", async () => {
    const mockPool = createLaneFoundPool();
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          content: "test content",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  // ── HAPPY PATH ──

  it("admin can append event — full output fields", async () => {
    const mockPool = createLaneFoundPool(
      "lane-uuid-1",
      "event-uuid-1",
      "2026-06-08T10:00:00Z",
    );
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "ob-v2-dev",
          namespace: "team-kb",
          event_type: "decision",
          content: "Decided to use append-only event journal",
          source: "skippy",
          artifact_path: "/src/tools/append-session-event.ts",
          importance: "hot",
          metadata: { pr: 42 },
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.event_id).toBe("event-uuid-1");
      expect(parsed.lane_id).toBe("lane-uuid-1");
      expect(parsed.event_type).toBe("decision");
      expect(parsed.importance).toBe("hot");
      expect(parsed.created_at).toBe("2026-06-08T10:00:00Z");
    } finally {
      await cleanup();
    }
  });

  it("allows agent role", async () => {
    const mockPool = createLaneFoundPool();
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          content: "Agent recorded a fact",
        },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  it("allows ob-admin role", async () => {
    const mockPool = createLaneFoundPool();
    const auth: AuthInfo = { role: "ob-admin", clientId: "ob-admin-worker" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "receipt",
          content: "Workflow completed",
        },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  // ── LANE NOT FOUND ──

  it("returns error when lane not found", async () => {
    const mockPool = createLaneNotFoundPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "nonexistent",
          event_type: "fact",
          content: "This lane does not exist",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Lane not found");
      expect((result.content as any)[0].text).toContain("nonexistent");
    } finally {
      await cleanup();
    }
  });

  it("creates a scoped lane on first append when create_if_missing is true", async () => {
    const captured: {
      laneInsertParams?: any[];
      eventInsertParams?: any[];
    } = {};
    const mockPool = {
      query: async (sql: string, params?: any[]) => {
        if (sql.includes("INSERT INTO ob_session_lanes")) {
          captured.laneInsertParams = params;
          return {
            rows: [
              {
                id: "lane-uuid-new",
                status: "active",
                agent: "nagatha",
                source: "discord",
                channel_id: "channel-1",
                thread_id: "thread-1",
                metadata: { server_id: "guild-1" },
              },
            ],
          };
        }
        if (sql.includes("FROM ob_session_lanes")) {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO ob_session_events")) {
          captured.eventInsertParams = params;
          return {
            rows: [{ id: "event-uuid-1", created_at: "2026-06-28T18:00:00Z" }],
          };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "discord:guild-1:channel-1:thread-1:nagatha",
          create_if_missing: true,
          agent: "nagatha",
          platform: "discord",
          server_id: "guild-1",
          channel_id: "channel-1",
          thread_id: "thread-1",
          project: "rtech-hermes",
          topic: "Nagatha Discord scoped memory",
          event_type: "correction",
          content: "GitHub issue URLs must use live gh first.",
          source: "nagatha",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.event_id).toBe("event-uuid-1");
      expect(parsed.lane_id).toBe("lane-uuid-new");
      expect(parsed.lane_created).toBe(true);
      expect(captured.laneInsertParams).toEqual([
        "discord:guild-1:channel-1:thread-1:nagatha",
        "nagatha",
        "nagatha",
        "discord",
        "channel-1",
        "thread-1",
        "rtech-hermes",
        "Nagatha Discord scoped memory",
        JSON.stringify({ server_id: "guild-1" }),
        "nagatha",
      ]);
      expect(captured.eventInsertParams?.[0]).toBe("lane-uuid-new");
    } finally {
      await cleanup();
    }
  });

  it("reuses an existing scoped lane when create_if_missing is true", async () => {
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return {
            rows: [
              {
                id: "lane-uuid-existing",
                status: "active",
                agent: "nagatha",
                source: "discord",
                channel_id: "channel-1",
                thread_id: "thread-1",
                metadata: { server_id: "guild-1" },
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO ob_session_events")) {
          return {
            rows: [{ id: "event-uuid-1", created_at: "2026-06-28T18:00:00Z" }],
          };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "discord:guild-1:channel-1:thread-1:nagatha",
          create_if_missing: true,
          agent: "nagatha",
          platform: "discord",
          server_id: "guild-1",
          channel_id: "channel-1",
          thread_id: "thread-1",
          event_type: "fact",
          content: "Existing scoped lane append succeeds.",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.lane_id).toBe("lane-uuid-existing");
      expect(parsed.lane_created).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("handles first-write lane creation races by returning the existing lane", async () => {
    let laneSelects = 0;
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("INSERT INTO ob_session_lanes")) {
          return { rows: [] };
        }
        if (sql.includes("FROM ob_session_lanes")) {
          laneSelects += 1;
          if (laneSelects === 1) return { rows: [] };
          return {
            rows: [
              {
                id: "lane-uuid-raced",
                status: "active",
                agent: "nagatha",
                source: "discord",
                channel_id: "channel-1",
                thread_id: null,
                metadata: { server_id: "guild-1" },
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO ob_session_events")) {
          return {
            rows: [{ id: "event-uuid-1", created_at: "2026-06-28T18:00:00Z" }],
          };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "discord:guild-1:channel-1:nagatha",
          create_if_missing: true,
          agent: "nagatha",
          platform: "discord",
          server_id: "guild-1",
          channel_id: "channel-1",
          event_type: "fact",
          content: "Raced lane creation still appends.",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.lane_id).toBe("lane-uuid-raced");
      expect(parsed.lane_created).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("denies append when supplied exact scope conflicts with the existing lane", async () => {
    let eventInsertAttempted = false;
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return {
            rows: [
              {
                id: "lane-uuid-1",
                status: "active",
                agent: "nagatha",
                source: "discord",
                channel_id: "channel-1",
                thread_id: "thread-1",
                metadata: { server_id: "guild-1" },
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO ob_session_events")) {
          eventInsertAttempted = true;
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "discord:guild-1:channel-1:thread-1:nagatha",
          create_if_missing: true,
          agent: "nagatha",
          platform: "discord",
          server_id: "guild-1",
          channel_id: "other-channel",
          thread_id: "thread-1",
          event_type: "fact",
          content: "This should not spill into another channel.",
        },
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.error).toBe("scope_validation");
      expect(parsed.retryable).toBe(false);
      expect(parsed.conflicts).toEqual(["channel_id"]);
      expect(eventInsertAttempted).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("denies unthreaded realtime append against an existing threaded lane", async () => {
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return {
            rows: [
              {
                id: "lane-uuid-threaded",
                status: "active",
                agent: "nagatha",
                source: "discord",
                channel_id: "channel-1",
                thread_id: "thread-1",
                metadata: { server_id: "guild-1" },
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "discord:guild-1:channel-1:nagatha",
          create_if_missing: true,
          agent: "nagatha",
          platform: "discord",
          server_id: "guild-1",
          channel_id: "channel-1",
          event_type: "fact",
          content: "Unthreaded writes must not target threaded lanes.",
        },
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.error).toBe("scope_validation");
      expect(parsed.conflicts).toEqual(["thread_id"]);
    } finally {
      await cleanup();
    }
  });

  it("appends to a session_start-created lane with null scope without false conflict", async () => {
    // Lanes created by session_start/lane_upsert do not write the `source`
    // column or `metadata.server_id`. A later scoped realtime append must
    // attach to such a lane rather than fail scope_validation on null vs
    // "discord"/"guild-1".
    let eventInsertAttempted = false;
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return {
            rows: [
              {
                id: "lane-uuid-sessionstart",
                status: "active",
                agent: "nagatha",
                source: null,
                channel_id: "channel-1",
                thread_id: null,
                metadata: {},
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO ob_session_events")) {
          eventInsertAttempted = true;
          return {
            rows: [{ id: "event-uuid-1", created_at: "2026-06-28T10:00:00Z" }],
          };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "discord:guild-1:channel-1:nagatha",
          agent: "nagatha",
          platform: "discord",
          server_id: "guild-1",
          channel_id: "channel-1",
          event_type: "fact",
          content: "Scoped append onto a session_start-created lane.",
        },
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.event_id).toBe("event-uuid-1");
      expect(eventInsertAttempted).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("still denies a non-null scope mismatch against an existing lane", async () => {
    // The null-tolerance above must not weaken real spill protection: a lane
    // that DID assert a channel still rejects a mismatched scoped append.
    let eventInsertAttempted = false;
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return {
            rows: [
              {
                id: "lane-uuid-asserted",
                status: "active",
                agent: "nagatha",
                source: "discord",
                channel_id: "channel-1",
                thread_id: null,
                metadata: { server_id: "guild-1" },
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO ob_session_events")) {
          eventInsertAttempted = true;
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "discord:guild-1:channel-1:nagatha",
          agent: "nagatha",
          platform: "discord",
          server_id: "guild-1",
          channel_id: "channel-2",
          event_type: "fact",
          content: "Mismatched channel must still be denied.",
        },
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.error).toBe("scope_validation");
      expect(parsed.conflicts).toEqual(["channel_id"]);
      expect(eventInsertAttempted).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("returns retryable_outage when the database fails before append", async () => {
    const mockPool = {
      query: async () => {
        throw new Error("connection timeout");
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "discord:guild-1:channel-1:nagatha",
          create_if_missing: true,
          event_type: "fact",
          content: "This should be spooled by Hermes.",
        },
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.error).toBe("retryable_outage");
      expect(parsed.retryable).toBe(true);
      expect(parsed.message).toContain("connection timeout");
    } finally {
      await cleanup();
    }
  });

  // ── ARCHIVED LANE ──

  it("rejects append to archived lane", async () => {
    const mockPool = createLaneFoundPool(
      "lane-uuid-1",
      "event-uuid-1",
      "2026-06-08T10:00:00Z",
      "archived",
    );
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "old-lane",
          event_type: "fact",
          content: "Should not be appended",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("archived");
      expect((result.content as any)[0].text).toContain("reactivate");
    } finally {
      await cleanup();
    }
  });

  it("allows append to wrapped lane", async () => {
    const mockPool = createLaneFoundPool(
      "lane-uuid-1",
      "event-uuid-1",
      "2026-06-08T10:00:00Z",
      "wrapped",
    );
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "wrapped-lane",
          event_type: "handoff",
          content: "Late event during wrap",
        },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  // ── DUPLICATE DETECTION ──

  it("returns duplicate response when content_hash conflicts", async () => {
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("ob_session_lanes")) {
          return { rows: [{ id: "lane-uuid-1", status: "active" }] };
        }
        // INSERT returns no rows due to ON CONFLICT DO NOTHING
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          content: "Already exists",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.duplicate).toBe(true);
      expect(parsed.message).toContain("identical content");
      expect(parsed.writer_identity).toBe("skippy");
      expect(parsed.token_identity).toBe("skippy");
      expect(parsed.delegated_agent_id).toBeNull();
      expect(parsed.namespace_source).toBe("token");
    } finally {
      await cleanup();
    }
  });

  // ── NAMESPACE DEFAULTING ──

  it("defaults namespace to auth.clientId when not provided", async () => {
    const mockPool = createLaneFoundPool();
    const auth: AuthInfo = { role: "admin", clientId: "bilby-agent" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "my-lane",
          event_type: "fact",
          content: "Something happened",
        },
      });

      // Tool succeeds -- lane was found using the defaulted namespace
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.event_id).toBe("event-uuid-1");
      expect(parsed.lane_id).toBe("lane-uuid-1");
    } finally {
      await cleanup();
    }
  });

  // ── IMPORTANCE DEFAULTING ──

  it("defaults importance to 'warm' when not provided", async () => {
    const mockPool = createLaneFoundPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          content: "Default importance test",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.importance).toBe("warm");
    } finally {
      await cleanup();
    }
  });

  // ── EMBEDDING PATHS ──

  it("embedding failure is non-fatal — event still inserted", async () => {
    const mockPool = createLaneFoundPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(
      mockPool,
      auth,
      createThrowingEmbed(new Error("embedding provider timeout")),
    );

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "blocker",
          content: "Something is blocking progress",
        },
      });

      // Should succeed despite embedding failure
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.event_id).toBe("event-uuid-1");
    } finally {
      await cleanup();
    }
  });

  // ── ALL EVENT TYPES ──

  const allEventTypes = [
    "fact",
    "decision",
    "blocker",
    "action",
    "artifact",
    "receipt",
    "question",
    "correction",
    "handoff",
  ] as const;

  for (const eventType of allEventTypes) {
    it(`accepts event_type="${eventType}"`, async () => {
      const mockPool = createLaneFoundPool();
      const auth: AuthInfo = { role: "admin", clientId: "skippy" };
      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "append_session_event",
          arguments: {
            session_key: "test",
            event_type: eventType,
            content: `Testing ${eventType} event type`,
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.event_type).toBe(eventType);
      } finally {
        await cleanup();
      }
    });
  }

  // ── OPTIONAL FIELDS ──

  it("succeeds with only required fields (source, artifact_path omitted)", async () => {
    const mockPool = createLaneFoundPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          content: "Minimal event",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.event_id).toBe("event-uuid-1");
      expect(parsed.event_type).toBe("fact");
      expect(parsed.importance).toBe("warm");
    } finally {
      await cleanup();
    }
  });

  // ── SYNC SHARE-NOMINATION GATE (Issue #161, Q1) ──
  // adjudicateNominationSync runs inline on the write path: a share_candidate
  // carrying a secret or person-private content is hard-rejected, the nomination
  // flag is STRIPPED before persist (so the async promoter never sweeps it), a
  // share_rejected_sync marker is stamped on the persisted metadata, and the
  // tool response surfaces share_candidate_rejected. Clean/absent nominations
  // pass through untouched — worthiness stays for the async cron, NOT this gate.
  //
  // We assert the persisted metadata by capturing the INSERT params on the mock
  // pool. The metadata is the 7th INSERT param ($7, index 6), JSON.stringify'd.

  /** Lane-found pool that captures the params of the events INSERT. */
  function createCapturingPool(priorRejectedResubmits = 0) {
    const captured: {
      createdBy: string | null;
      metadata: Record<string, unknown> | null;
    } = {
      createdBy: null,
      metadata: null,
    };
    const pool = {
      captured,
      query: async (sql: string, params?: any[]) => {
        if (sql.includes("ob_session_lanes")) {
          return { rows: [{ id: "lane-uuid-1", status: "active" }] };
        }
        if (sql.includes("COUNT(*)::int AS rejected_count")) {
          return { rows: [{ rejected_count: priorRejectedResubmits }] };
        }
        // INSERT INTO ob_session_events — $7 (index 6) is the metadata JSON.
        if (params && typeof params[6] === "string") {
          captured.metadata = JSON.parse(params[6]);
          captured.createdBy = params[11] ?? null;
        }
        return { rows: [{ id: "event-uuid-1", created_at: "2026-06-08T10:00:00Z" }] };
      },
    };
    return pool;
  }

  it("records distinct writer and token provenance for cross-namespace writes", async () => {
    const mockPool = createCapturingPool();
    const auth: AuthInfo = {
      role: "admin",
      clientId: "rico",
      tokenClientId: "rico",
      namespaceSource: "token",
    };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          namespace: "nagatha",
          event_type: "fact",
          content: "Nagatha delegated write provenance canary",
          source: "nagatha",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.writer_identity).toBe("rico");
      expect(parsed.token_identity).toBe("rico");
      expect(parsed.delegated_agent_id).toBeNull();
      expect(parsed.namespace_source).toBe("token");

      expect(mockPool.captured.createdBy).toBe("rico");
      expect(mockPool.captured.metadata).not.toBeNull();
      expect(mockPool.captured.metadata!._openbrain).toEqual({
        writer: {
          client_id: "rico",
          token_client_id: "rico",
          agent_id: null,
          namespace_source: "token",
        },
      });
    } finally {
      await cleanup();
    }
  });

  it("does not treat X-Agent-Id as delegated provenance without X-Namespace", async () => {
    const mockPool = createCapturingPool();
    const auth: AuthInfo = {
      role: "agent",
      clientId: "skippy",
      tokenClientId: "skippy",
      agentId: "spoofed-agent",
      namespaceSource: "token",
    };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          content: "Non-delegated agent id should not become provenance",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.writer_identity).toBe("skippy");
      expect(parsed.token_identity).toBe("skippy");
      expect(parsed.delegated_agent_id).toBeNull();
      expect(parsed.namespace_source).toBe("token");

      expect(mockPool.captured.metadata).not.toBeNull();
      expect(mockPool.captured.metadata!._openbrain).toEqual({
        writer: {
          client_id: "skippy",
          token_client_id: "skippy",
          agent_id: null,
          namespace_source: "token",
        },
      });
    } finally {
      await cleanup();
    }
  });

  it("records delegated namespace writer separately from token provenance", async () => {
    const mockPool = createCapturingPool();
    const auth: AuthInfo = {
      role: "admin",
      clientId: "nagatha",
      tokenClientId: "rico",
      agentId: "nagatha",
      namespaceSource: "header",
    };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          namespace: "nagatha",
          event_type: "fact",
          content: "Nagatha header delegated write provenance canary",
          source: "nagatha",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.writer_identity).toBe("nagatha");
      expect(parsed.token_identity).toBe("rico");
      expect(parsed.delegated_agent_id).toBe("nagatha");
      expect(parsed.namespace_source).toBe("header");

      expect(mockPool.captured.createdBy).toBe("nagatha");
      expect(mockPool.captured.metadata).not.toBeNull();
      expect(mockPool.captured.metadata!._openbrain).toEqual({
        writer: {
          client_id: "nagatha",
          token_client_id: "rico",
          agent_id: "nagatha",
          namespace_source: "header",
        },
      });
    } finally {
      await cleanup();
    }
  });

  it("preserves caller _openbrain metadata while stamping trusted writer provenance", async () => {
    const mockPool = createCapturingPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          content: "Caller metadata should not clobber OpenBrain provenance",
          metadata: {
            _openbrain: { writer: { client_id: "spoofed" } },
            user_value: "kept",
          },
        },
      });

      expect(result.isError).toBeFalsy();
      expect(mockPool.captured.metadata).not.toBeNull();
      expect(mockPool.captured.metadata!.user_value).toBe("kept");
      expect(mockPool.captured.metadata!._caller_openbrain_metadata).toEqual({
        writer: { client_id: "spoofed" },
      });
      expect(mockPool.captured.metadata!._openbrain).toEqual({
        writer: {
          client_id: "skippy",
          token_client_id: "skippy",
          agent_id: null,
          namespace_source: "token",
        },
      });
    } finally {
      await cleanup();
    }
  });

  it("strips share_candidate and reports reject-secret when content carries a secret", async () => {
    const mockPool = createCapturingPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          // Substantive content that also embeds an OpenAI-style key.
          content:
            "Configured the deploy pipeline with key " + "sk-" + "a".repeat(20),
          metadata: { share_candidate: true },
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.share_candidate_rejected).toBe("reject-secret");
      expect(parsed.reject_detail).toMatchObject({
        category: "reject-secret",
        matched_kind: "openai_api_key",
        span_count: 1,
        resubmittable: true,
        resubmit_attempt: 0,
        max_resubmit_attempts: 2,
        resubmit_metadata: {
          sanitized_resubmit_of: "event-uuid-1",
          sanitized_resubmit_attempt: 1,
        },
      });
      expect(JSON.stringify(parsed.reject_detail)).not.toContain("sk-");
      expect(parsed.reject_detail.redaction_hint).toContain(
        "Remove the credential",
      );

      // Persisted metadata: nomination stripped, audit marker stamped.
      expect(mockPool.captured.metadata).not.toBeNull();
      expect(mockPool.captured.metadata!.share_candidate).toBeUndefined();
      expect(mockPool.captured.metadata!.share_rejected_sync).toBe(
        "reject-secret",
      );
    } finally {
      await cleanup();
    }
  });

  it("treats string \"true\" nomination like boolean true (matches async SQL truthiness)", async () => {
    // The async promoter nominates on `metadata->>'share_candidate' = 'true'`,
    // which matches a JSON string "true". If the sync gate only accepted boolean
    // true, a mistyped nomination would skip the inline secret check yet still
    // be swept async — voiding this gate. Regression for that bypass.
    const mockPool = createCapturingPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          content:
            "Configured the deploy pipeline with key " + "sk-" + "a".repeat(20),
          metadata: { share_candidate: "true" },
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.share_candidate_rejected).toBe("reject-secret");
      expect(parsed.reject_detail).toMatchObject({
        category: "reject-secret",
        matched_kind: "openai_api_key",
        resubmittable: true,
        resubmit_metadata: {
          sanitized_resubmit_of: "event-uuid-1",
          sanitized_resubmit_attempt: 1,
        },
      });
      expect(mockPool.captured.metadata!.share_candidate).toBeUndefined();
      expect(mockPool.captured.metadata!.share_rejected_sync).toBe(
        "reject-secret",
      );
    } finally {
      await cleanup();
    }
  });

  it("strips share_candidate and reports reject-private when metadata.private is true", async () => {
    const mockPool = createCapturingPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          // Clean, substantive content — only the private marker triggers reject.
          content: "This is a substantive personal note about my own plans.",
          metadata: { share_candidate: true, private: true },
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.share_candidate_rejected).toBe("reject-private");
      expect(parsed.reject_detail).toMatchObject({
        category: "reject-private",
        matched_kind: "private-flag",
        span_count: 1,
        resubmittable: true,
        resubmit_metadata: {
          sanitized_resubmit_of: "event-uuid-1",
          sanitized_resubmit_attempt: 1,
        },
      });

      expect(mockPool.captured.metadata).not.toBeNull();
      expect(mockPool.captured.metadata!.share_candidate).toBeUndefined();
      expect(mockPool.captured.metadata!.share_rejected_sync).toBe(
        "reject-private",
      );
      // The original private marker is preserved (only share_candidate stripped).
      expect(mockPool.captured.metadata!.private).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("marks repeated rejected sanitized resubmits non-resubmittable at the bound", async () => {
    const mockPool = createCapturingPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    const fakeKey = "sk" + "-" + "a".repeat(20);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          content: `Sanitized resend still accidentally carries ${fakeKey}`,
          metadata: {
            share_candidate: true,
            sanitized_resubmit_of: "event-original",
            sanitized_resubmit_attempt: 2,
          },
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.share_candidate_rejected).toBe("reject-secret");
      expect(parsed.reject_detail).toMatchObject({
        category: "reject-secret",
        matched_kind: "openai_api_key",
        resubmittable: false,
        resubmit_attempt: 2,
        max_resubmit_attempts: 2,
        resubmit_metadata: {
          sanitized_resubmit_of: "event-uuid-1",
          sanitized_resubmit_attempt: 2,
        },
      });
      expect(JSON.stringify(parsed.reject_detail)).not.toContain(fakeKey);
    } finally {
      await cleanup();
    }
  });

  it("does not trust a reset sanitized_resubmit_attempt when prior rejected resubmits exist", async () => {
    const mockPool = createCapturingPool(1);
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    const fakeKey = "sk" + "-" + "a".repeat(20);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          content: `Reset resend still accidentally carries ${fakeKey}`,
          metadata: {
            share_candidate: true,
            sanitized_resubmit_of: "event-original",
            sanitized_resubmit_attempt: 0,
          },
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.share_candidate_rejected).toBe("reject-secret");
      expect(parsed.reject_detail).toMatchObject({
        category: "reject-secret",
        matched_kind: "openai_api_key",
        resubmittable: false,
        resubmit_attempt: 2,
        max_resubmit_attempts: 2,
        resubmit_metadata: {
          sanitized_resubmit_of: "event-uuid-1",
          sanitized_resubmit_attempt: 2,
        },
      });
      expect(JSON.stringify(parsed.reject_detail)).not.toContain(fakeKey);
    } finally {
      await cleanup();
    }
  });

  it("keeps share_candidate for clean substantive content — async cron owns worthiness", async () => {
    const mockPool = createCapturingPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          content:
            "Chose pgvector halfvec(768) for the embedding column to halve storage.",
          metadata: { share_candidate: true },
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      // No sync rejection — the sync gate ONLY hard-rejects secret/private.
      expect(parsed.share_candidate_rejected).toBeUndefined();

      // Nomination survives to persist; the async promoter decides worthiness.
      expect(mockPool.captured.metadata).not.toBeNull();
      expect(mockPool.captured.metadata!.share_candidate).toBe(true);
      expect(mockPool.captured.metadata!.share_rejected_sync).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("accepts a clean sanitized resubmit without emitting rejection detail", async () => {
    const mockPool = createCapturingPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          content:
            "Replaced the credential-bearing deployment note with a sanitized operational summary.",
          metadata: {
            share_candidate: true,
            sanitized_resubmit_of: "event-original",
            sanitized_resubmit_attempt: 1,
          },
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.share_candidate_rejected).toBeUndefined();
      expect(parsed.reject_detail).toBeUndefined();

      expect(mockPool.captured.metadata).not.toBeNull();
      expect(mockPool.captured.metadata!.share_candidate).toBe(true);
      expect(mockPool.captured.metadata!.sanitized_resubmit_of).toBe(
        "event-original",
      );
      expect(mockPool.captured.metadata!.sanitized_resubmit_attempt).toBe(1);
      expect(mockPool.captured.metadata!.share_rejected_sync).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("passes metadata through unchanged when no share_candidate is present", async () => {
    const mockPool = createCapturingPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          // Content that WOULD be a secret, but with no nomination the sync gate
          // must not run — share_rejected_sync must never appear.
          content: "password: hunter2something nominated nowhere",
          metadata: { pr: 42 },
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.share_candidate_rejected).toBeUndefined();

      expect(mockPool.captured.metadata).not.toBeNull();
      expect(mockPool.captured.metadata!.pr).toBe(42);
      expect(mockPool.captured.metadata!.share_candidate).toBeUndefined();
      expect(mockPool.captured.metadata!.share_rejected_sync).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  // ── DATABASE ERROR ──

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
        name: "append_session_event",
        arguments: {
          session_key: "test",
          event_type: "fact",
          content: "DB will crash",
        },
      });

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("connection refused");
      expect((result.content as any)[0].text).toContain("Database error");
    } finally {
      await cleanup();
    }
  });
});

// ── LIVE POSTGRES (real ON CONFLICT / race / scope-isolation coverage) ──
// Mock pools cannot execute ON CONFLICT, real UNIQUE constraints, or genuine
// concurrent inserts, so the create_if_missing race + scope-isolation guarantee
// the contract depends on (consumed by rtech-hermes#276) is proven here against
// a real pool. Gated on OPENBRAIN_TEST_DATABASE_URL; CI sets it (ci.yml), the
// default infra-free suite skips. Run locally with:
//   OPENBRAIN_TEST_DATABASE_URL=postgres://... bun test src/tools/__tests__/append-session-event.test.ts
const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

dbDescribe("append_session_event create_if_missing (live Postgres)", () => {
  const pool = new Pool({ connectionString: DB_URL });
  const ns = "test-append-live";

  async function callAppend(
    args: Record<string, unknown>,
    auth: AuthInfo = { role: "agent", clientId: ns },
  ) {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: pool as any,
      embedFn: createMockEmbed(null),
    };
    registerAppendSessionEvent(server, deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const original = ct.send.bind(ct);
    ct.send = (m: any, o?: any) => original(m, { ...o, authInfo: auth });
    const client = new Client({ name: "tc", version: "1.0.0" });
    await server.connect(st);
    await client.connect(ct);
    const res = await client.callTool({
      name: "append_session_event",
      arguments: args,
    });
    await client.close();
    await server.close();
    return res;
  }

  async function cleanupNs() {
    // Events cascade from lanes; delete by namespace-scoped lane ids.
    await pool.query(
      `DELETE FROM ob_session_events WHERE lane_id IN
         (SELECT id FROM ob_session_lanes WHERE namespace = $1)`,
      [ns],
    );
    await pool.query("DELETE FROM ob_session_lanes WHERE namespace = $1", [ns]);
  }

  afterAll(async () => {
    await pool.end();
  });

  it("creates the lane on first write and reuses it idempotently on the second", async () => {
    await cleanupNs();
    try {
      const first = await callAppend({
        session_key: "live-first",
        create_if_missing: true,
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-1",
        event_type: "fact",
        content: "first scoped event",
      });
      expect(first.isError).toBeFalsy();
      const p1 = JSON.parse((first.content as any)[0].text);
      expect(p1.lane_created).toBe(true);

      const second = await callAppend({
        session_key: "live-first",
        create_if_missing: true,
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-1",
        event_type: "fact",
        content: "second scoped event",
      });
      expect(second.isError).toBeFalsy();
      const p2 = JSON.parse((second.content as any)[0].text);
      expect(p2.lane_created).toBe(false);
      expect(p2.lane_id).toBe(p1.lane_id);

      const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS n FROM ob_session_lanes WHERE namespace=$1 AND session_key=$2",
        [ns, "live-first"],
      );
      expect(rows[0].n).toBe(1);
    } finally {
      await cleanupNs();
    }
  });

  it("creates exactly one lane under a genuine concurrent first-write race", async () => {
    await cleanupNs();
    try {
      const mk = (content: string) =>
        callAppend({
          session_key: "live-race",
          create_if_missing: true,
          agent: "nagatha",
          platform: "discord",
          server_id: "guild-1",
          channel_id: "channel-1",
          event_type: "fact",
          content,
        });
      const [a, b] = await Promise.all([mk("racer A"), mk("racer B")]);
      expect(a.isError).toBeFalsy();
      expect(b.isError).toBeFalsy();
      const pa = JSON.parse((a.content as any)[0].text);
      const pb = JSON.parse((b.content as any)[0].text);
      // Exactly one call reports it created the lane; both resolve to the same lane.
      expect(Number(pa.lane_created) + Number(pb.lane_created)).toBe(1);
      expect(pa.lane_id).toBe(pb.lane_id);

      const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS n FROM ob_session_lanes WHERE namespace=$1 AND session_key=$2",
        [ns, "live-race"],
      );
      expect(rows[0].n).toBe(1);
    } finally {
      await cleanupNs();
    }
  });

  it("denies a scoped append that conflicts with the real stored lane scope", async () => {
    await cleanupNs();
    try {
      await callAppend({
        session_key: "live-conflict",
        create_if_missing: true,
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-1",
        event_type: "fact",
        content: "owns channel-1",
      });
      const conflict = await callAppend({
        session_key: "live-conflict",
        create_if_missing: true,
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-2",
        event_type: "fact",
        content: "must not spill into channel-2",
      });
      expect(conflict.isError).toBe(true);
      const parsed = JSON.parse((conflict.content as any)[0].text);
      expect(parsed.error).toBe("scope_validation");
      expect(parsed.conflicts).toEqual(["channel_id"]);
    } finally {
      await cleanupNs();
    }
  });

  it("denies cross-namespace create_if_missing for a non-global token", async () => {
    await cleanupNs();
    try {
      const res = await callAppend(
        {
          session_key: "live-cross-ns",
          namespace: "some-other-namespace",
          create_if_missing: true,
          agent: "nagatha",
          platform: "discord",
          server_id: "guild-1",
          channel_id: "channel-1",
          event_type: "fact",
          content: "should never be written",
        },
        { role: "agent", clientId: ns },
      );
      expect(res.isError).toBe(true);
      const parsed = JSON.parse((res.content as any)[0].text);
      expect(parsed.error).toBe("auth_denied");
      // No lane may have been created in the foreign namespace.
      const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS n FROM ob_session_lanes WHERE namespace=$1",
        ["some-other-namespace"],
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await cleanupNs();
    }
  });
});
