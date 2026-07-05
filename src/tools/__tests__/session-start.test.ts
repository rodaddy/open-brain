import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSessionStart } from "../session-start.ts";
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
  registerSessionStart(server, deps);

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
  current_context_md: "## Active work\nSession lifecycle tools.",
  metadata: {},
  created_at: "2026-06-08T08:00:00Z",
  updated_at: "2026-06-08T10:00:00Z",
  ended_at: null,
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
];

describe("session_start", () => {
  // ── AUTH PATHS ──

  it("denies when auth is missing entirely", async () => {
    const mockPool = {
      query: async () => ({ rows: [] }),
    };
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: mockPool as any,
      embedFn: createMockEmbed(),
    };
    registerSessionStart(server, deps);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "session_start",
        arguments: { session_key: "test" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("denies for discord role", async () => {
    const mockPool = {
      query: async () => ({ rows: [] }),
    };
    const auth: AuthInfo = { role: "discord", clientId: "random-user" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_start",
        arguments: { session_key: "test" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("denies for readonly role", async () => {
    const mockPool = {
      query: async () => ({ rows: [] }),
    };
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_start",
        arguments: { session_key: "test" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  // ── NEW SESSION ──

  it("admin creates new session when no lane found", async () => {
    const newLane = {
      ...MOCK_LANE,
      id: "new-lane-uuid",
      status: "active",
    };
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO ob_session_lanes")) {
          return { rows: [newLane] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_start",
        arguments: { session_key: "ob-v2-dev" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.is_new).toBe(true);
      expect(parsed.events).toEqual([]);
      expect(parsed.events_returned).toBe(0);
      expect(parsed.lane.id).toBe("new-lane-uuid");
      expect(parsed.lane.status).toBe("active");
    } finally {
      await cleanup();
    }
  });

  // ── RESUME ACTIVE LANE ──

  it("admin resumes active lane (no reactivation needed)", async () => {
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return { rows: [{ ...MOCK_LANE, status: "active" }] };
        }
        if (sql.includes("FROM ob_session_events")) {
          return { rows: MOCK_EVENTS };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_start",
        arguments: { session_key: "ob-v2-dev" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.is_new).toBe(false);
      expect(parsed.events).toHaveLength(2);
      expect(parsed.events_returned).toBe(2);
      expect(parsed.lane.status).toBe("active");
    } finally {
      await cleanup();
    }
  });

  // ── WRAPPED LANE RETURNED AS-IS ──

  it("returns wrapped lane as-is with events (agent decides next step)", async () => {
    const wrappedLane = {
      ...MOCK_LANE,
      status: "wrapped",
      ended_at: "2026-06-08T12:00:00Z",
    };
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return { rows: [wrappedLane] };
        }
        if (sql.includes("FROM ob_session_events")) {
          return { rows: MOCK_EVENTS };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_start",
        arguments: { session_key: "ob-v2-dev" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.is_new).toBe(false);
      expect(parsed.lane.status).toBe("wrapped");
      expect(parsed.lane.ended_at).toBe("2026-06-08T12:00:00Z");
      expect(parsed.events).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  // ── ARCHIVED LANE RETURNED AS-IS ──

  it("returns archived lane as-is (agent decides whether to reactivate)", async () => {
    const archivedLane = {
      ...MOCK_LANE,
      status: "archived",
      ended_at: "2026-06-01T00:00:00Z",
    };
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return { rows: [archivedLane] };
        }
        if (sql.includes("FROM ob_session_events")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_start",
        arguments: { session_key: "ob-v2-dev" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.is_new).toBe(false);
      expect(parsed.lane.status).toBe("archived");
    } finally {
      await cleanup();
    }
  });

  // ── OPTIONAL FIELDS PROPAGATED ON CREATE ──

  it("propagates optional fields (agent, project, topic) on create", async () => {
    const createdLane = {
      ...MOCK_LANE,
      id: "new-uuid",
      session_key: "deploy-session",
      namespace: "infra",
      agent: "bilby",
      project: "pai-infra",
      topic: "Deploy setup",
    };
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO ob_session_lanes")) {
          return { rows: [createdLane] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_start",
        arguments: {
          session_key: "deploy-session",
          namespace: "infra",
          agent: "bilby",
          project: "pai-infra",
          channel_id: "ch-999",
          thread_id: "th-111",
          topic: "Deploy setup",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.is_new).toBe(true);
      expect(parsed.lane.agent).toBe("bilby");
      expect(parsed.lane.project).toBe("pai-infra");
      expect(parsed.lane.topic).toBe("Deploy setup");
      expect(parsed.lane.namespace).toBe("infra");
    } finally {
      await cleanup();
    }
  });

  // ── EVENTS LOADED FOR EXISTING LANE ──

  it("loads events for existing lane with event-shaped rows", async () => {
    const events = [
      {
        id: "ev-a",
        event_type: "action",
        content: "Deployed service",
        source: "bilby",
        artifact_path: null,
        importance: "hot",
        metadata: { step: 3 },
        created_at: "2026-06-08T11:00:00Z",
        created_by: "bilby",
      },
      {
        id: "ev-b",
        event_type: "receipt",
        content: "PR merged",
        source: "github",
        artifact_path: "https://github.com/org/repo/pull/42",
        importance: "warm",
        metadata: {},
        created_at: "2026-06-08T10:30:00Z",
        created_by: "skippy",
      },
    ];
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return { rows: [MOCK_LANE] };
        }
        if (sql.includes("FROM ob_session_events")) {
          return { rows: events };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_start",
        arguments: { session_key: "ob-v2-dev" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.events).toHaveLength(2);
      expect(parsed.events[0].id).toBe("ev-a");
      expect(parsed.events[0].event_type).toBe("action");
      expect(parsed.events[0].source).toBe("bilby");
      expect(parsed.events[1].id).toBe("ev-b");
      expect(parsed.events[1].artifact_path).toBe(
        "https://github.com/org/repo/pull/42",
      );
      expect(parsed.events_returned).toBe(2);
    } finally {
      await cleanup();
    }
  });

  // ── NAMESPACE DEFAULTING ──

  it("defaults namespace to auth.clientId when not provided", async () => {
    // When namespace is not provided, the tool uses auth.clientId as the namespace.
    // We simulate a lane lookup that returns a lane whose namespace matches clientId.
    const laneForNagatha = {
      ...MOCK_LANE,
      namespace: "nagatha",
      session_key: "test",
    };
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return { rows: [laneForNagatha] };
        }
        if (sql.includes("FROM ob_session_events")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "nagatha" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_start",
        arguments: { session_key: "test" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      // The returned lane namespace should match the clientId used as default
      expect(parsed.lane.namespace).toBe("nagatha");
    } finally {
      await cleanup();
    }
  });

  // ── AGENT AND OB_ADMIN ROLES ALLOWED ──

  it("allows agent role", async () => {
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO ob_session_lanes")) {
          return { rows: [MOCK_LANE] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_start",
        arguments: { session_key: "agent-session" },
      });
      expect(result.isError).toBeFalsy();
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
        name: "session_start",
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
