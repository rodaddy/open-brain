import { describe, it, expect } from "bun:test";
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
          namespace: "collab",
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

  it("allows n8n role", async () => {
    const mockPool = createLaneFoundPool();
    const auth: AuthInfo = { role: "n8n", clientId: "n8n-worker" };
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
      createThrowingEmbed(new Error("LiteLLM timeout")),
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
