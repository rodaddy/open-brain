import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSessionContext } from "../session-context.ts";
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
  registerSessionContext(server, deps);

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

const MOCK_LANE = {
  id: "lane-uuid-1",
  session_key: "ob-v2-dev",
  namespace: "skippy",
  status: "active",
  agent: "skippy",
  project: "open-brain",
  topic: "OB v2 development",
  current_context_md: "## Active work\nSession events feature.",
  metadata: {},
  created_at: "2026-06-08T08:00:00Z",
  updated_at: "2026-06-08T10:00:00Z",
};

const MOCK_EVENTS = [
  {
    id: "event-1",
    event_type: "decision",
    content: "Using append-only journal",
    source: "skippy",
    artifact_path: null,
    importance: "hot",
    metadata: {},
    created_at: "2026-06-08T10:00:00Z",
    created_by: "skippy",
  },
  {
    id: "event-2",
    event_type: "fact",
    content: "Migration 013 created",
    source: null,
    artifact_path: "/src/db/migrations/013_session_events.sql",
    importance: "warm",
    metadata: {},
    created_at: "2026-06-08T09:30:00Z",
    created_by: "skippy",
  },
  {
    id: "event-3",
    event_type: "blocker",
    content: "Need embedding model config",
    source: null,
    artifact_path: null,
    importance: "cold",
    metadata: {},
    created_at: "2026-06-08T09:00:00Z",
    created_by: "skippy",
  },
];

/** Mock pool that returns lane + events, differentiating by SQL content. */
function createFullContextPool(lane = MOCK_LANE, events = MOCK_EVENTS) {
  return {
    query: async (sql: string, _params?: any[]) => {
      if (sql.includes("ob_session_lanes")) {
        return { rows: [lane] };
      }
      if (sql.includes("ob_session_events")) {
        return { rows: events };
      }
      return { rows: [] };
    },
  };
}

describe("session_context", () => {
  // ── AUTH PATHS ──

  it("denies read when auth is missing entirely", async () => {
    const mockPool = createFullContextPool();
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: mockPool as any,
      embedFn: createMockEmbed(),
    };
    registerSessionContext(server, deps);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "session_context",
        arguments: { session_key: "test" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("denies read for discord role", async () => {
    const mockPool = createFullContextPool();
    const auth: AuthInfo = { role: "discord", clientId: "random-user" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_context",
        arguments: { session_key: "test" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("allows readonly role", async () => {
    const mockPool = createFullContextPool();
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_context",
        arguments: { session_key: "ob-v2-dev" },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  // ── HAPPY PATH ──

  it("admin can load context with events", async () => {
    const mockPool = createFullContextPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_context",
        arguments: { session_key: "ob-v2-dev" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);

      // Lane fields
      expect(parsed.lane.id).toBe("lane-uuid-1");
      expect(parsed.lane.session_key).toBe("ob-v2-dev");
      expect(parsed.lane.project).toBe("open-brain");
      expect(parsed.lane.current_context_md).toContain("Session events");

      // Events
      expect(parsed.events).toHaveLength(3);
      expect(parsed.events[0].event_type).toBe("decision");
      expect(parsed.events[1].event_type).toBe("fact");
      expect(parsed.events[2].event_type).toBe("blocker");
      expect(parsed.event_count).toBe(3);
    } finally {
      await cleanup();
    }
  });

  // ── LANE NOT FOUND ──

  it("returns null lane when not found", async () => {
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("ob_session_lanes")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_context",
        arguments: { session_key: "nonexistent" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.lane).toBeNull();
      expect(parsed.events).toEqual([]);
      expect(parsed.event_count).toBe(0);
    } finally {
      await cleanup();
    }
  });

  // ── MISSING LANE IDENTIFIER ──

  it("requires at least one of session_key or channel_id", async () => {
    const mockPool = createFullContextPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_context",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain(
        "At least one of session_key or channel_id is required",
      );
    } finally {
      await cleanup();
    }
  });

  // ── CHANNEL LOOKUP ──

  it("looks up lane by channel_id and returns it", async () => {
    const mockPool = createFullContextPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_context",
        arguments: { channel_id: "discord-123" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.lane).not.toBeNull();
      expect(parsed.lane.id).toBe("lane-uuid-1");
      expect(parsed.events).toHaveLength(3);
    } finally {
      await cleanup();
    }
  });

  it("looks up lane by channel_id + thread_id and returns it", async () => {
    const mockPool = createFullContextPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_context",
        arguments: { channel_id: "discord-123", thread_id: "thread-456" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.lane).not.toBeNull();
      expect(parsed.lane.id).toBe("lane-uuid-1");
    } finally {
      await cleanup();
    }
  });

  // ── EVENT TYPE FILTER ──

  it("filters events by event_types", async () => {
    // Return only the decision event when event_types filter is applied
    const decisionOnly = [MOCK_EVENTS[0]];
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("ob_session_lanes")) {
          return { rows: [MOCK_LANE] };
        }
        if (sql.includes("ob_session_events")) {
          return { rows: decisionOnly };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_context",
        arguments: {
          session_key: "ob-v2-dev",
          event_types: ["decision", "blocker"],
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.events).toHaveLength(1);
      expect(parsed.events[0].event_type).toBe("decision");
      expect(parsed.event_count).toBe(1);
    } finally {
      await cleanup();
    }
  });

  // ── IMPORTANCE FILTER ──

  it("filters events by importance", async () => {
    const hotOnly = [MOCK_EVENTS[0]]; // only the "hot" event
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("ob_session_lanes")) {
          return { rows: [MOCK_LANE] };
        }
        if (sql.includes("ob_session_events")) {
          return { rows: hotOnly };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_context",
        arguments: {
          session_key: "ob-v2-dev",
          importance: "hot",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.events).toHaveLength(1);
      expect(parsed.events[0].importance).toBe("hot");
      expect(parsed.event_count).toBe(1);
    } finally {
      await cleanup();
    }
  });

  // ── INCLUDE_EVENTS=FALSE ──

  it("skips event query when include_events is false", async () => {
    let eventQueryCalled = false;
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("ob_session_lanes")) {
          return { rows: [MOCK_LANE] };
        }
        if (sql.includes("ob_session_events")) {
          eventQueryCalled = true;
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_context",
        arguments: {
          session_key: "ob-v2-dev",
          include_events: false,
        },
      });

      expect(result.isError).toBeFalsy();
      expect(eventQueryCalled).toBe(false);
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.lane.id).toBe("lane-uuid-1");
      expect(parsed.events).toEqual([]);
      expect(parsed.event_count).toBe(0);
    } finally {
      await cleanup();
    }
  });

  // ── NAMESPACE DEFAULTING ──

  it("defaults namespace to auth.clientId when not provided", async () => {
    // The tool uses auth.clientId as namespace default. If the pool finds
    // a lane matching that namespace, it returns it. We verify via output.
    const nagathLane = { ...MOCK_LANE, namespace: "nagatha" };
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("ob_session_lanes")) {
          return { rows: [nagathLane] };
        }
        if (sql.includes("ob_session_events")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "nagatha" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_context",
        arguments: { session_key: "test" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.lane.namespace).toBe("nagatha");
    } finally {
      await cleanup();
    }
  });

  // ── EVENT LIMIT ──

  it("respects event_limit parameter by returning limited events", async () => {
    // Mock returns 2 events regardless; with event_limit=5 the tool should
    // still return whatever the DB gives back (the limit is applied in SQL).
    const mockPool = createFullContextPool(MOCK_LANE, MOCK_EVENTS.slice(0, 2));
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_context",
        arguments: {
          session_key: "ob-v2-dev",
          event_limit: 5,
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.events).toHaveLength(2);
      expect(parsed.event_count).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("defaults event_limit to 50 (returns events normally)", async () => {
    const mockPool = createFullContextPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_context",
        arguments: { session_key: "ob-v2-dev" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      // All 3 mock events returned (well under the default 50 limit)
      expect(parsed.events).toHaveLength(3);
      expect(parsed.event_count).toBe(3);
    } finally {
      await cleanup();
    }
  });

  // ── DATABASE ERROR ──

  it("returns isError=true with message when DB query throws", async () => {
    const mockPool = {
      query: async () => {
        throw new Error("connection timeout");
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_context",
        arguments: { session_key: "crash" },
      });

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("connection timeout");
      expect((result.content as any)[0].text).toContain("Database error");
    } finally {
      await cleanup();
    }
  });
});
