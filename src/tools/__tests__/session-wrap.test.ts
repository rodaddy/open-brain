import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSessionWrap } from "../session-wrap.ts";
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
  registerSessionWrap(server, deps);

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
  status: "active",
  project: "open-brain",
  agent: "skippy",
  topic: "OB v2 development",
};

/** Full mock pool for the happy-path wrap flow. */
function createWrapPool(
  lane = MOCK_LANE,
  eventCount = 5,
  sessionId = "session-uuid-1",
  createdAt = "2026-06-08T12:00:00Z",
) {
  return {
    query: async (sql: string, _params?: any[]) => {
      if (sql.includes("FROM ob_session_lanes")) {
        return { rows: [lane] };
      }
      if (sql.includes("count(*)")) {
        return { rows: [{ cnt: eventCount }] };
      }
      if (sql.includes("INSERT INTO sessions")) {
        return { rows: [{ id: sessionId, created_at: createdAt }] };
      }
      if (sql.includes("UPDATE ob_session_lanes SET status")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe("session_wrap", () => {
  // ── AUTH PATHS ──

  it("denies when auth is missing entirely", async () => {
    const mockPool = createWrapPool();
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: mockPool as any,
      embedFn: createMockEmbed(),
    };
    registerSessionWrap(server, deps);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "session_wrap",
        arguments: {
          session_key: "test",
          summary: "Test summary",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("denies for discord role", async () => {
    const mockPool = createWrapPool();
    const auth: AuthInfo = { role: "discord", clientId: "random-user" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_wrap",
        arguments: {
          session_key: "test",
          summary: "Test summary",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("denies for readonly role", async () => {
    const mockPool = createWrapPool();
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_wrap",
        arguments: {
          session_key: "test",
          summary: "Test summary",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  // ── HAPPY PATH: WRAP ACTIVE LANE ──

  it("admin checkpoints active lane — session saved, lane stays active", async () => {
    const mockPool = createWrapPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_wrap",
        arguments: {
          session_key: "ob-v2-dev",
          summary: "Completed session lifecycle tools implementation.",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.session_id).toBe("session-uuid-1");
      expect(parsed.lane_id).toBe("lane-uuid-1");
      expect(parsed.lane_status).toBe("active");
      expect(parsed.event_count).toBe(5);
      expect(parsed.created_at).toBe("2026-06-08T12:00:00Z");
    } finally {
      await cleanup();
    }
  });

  // ── KEEP_ACTIVE ──

  it("checkpoint never changes lane status — lane stays active", async () => {
    const mockPool = createWrapPool(
      MOCK_LANE,
      3,
      "session-uuid-2",
      "2026-06-08T13:00:00Z",
    );
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_wrap",
        arguments: {
          session_key: "ob-v2-dev",
          summary: "Intermediate checkpoint — work continues.",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.lane_status).toBe("active");
    } finally {
      await cleanup();
    }
  });

  // ── LANE NOT FOUND ──

  it("returns error when lane not found", async () => {
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_wrap",
        arguments: {
          session_key: "nonexistent",
          summary: "Should fail",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Lane not found");
      expect((result.content as any)[0].text).toContain("nonexistent");
    } finally {
      await cleanup();
    }
  });

  // ── ARCHIVED LANE CAN STILL BE CHECKPOINTED ──

  it("allows checkpointing an archived lane (flexible, not strict)", async () => {
    const archivedLane = { ...MOCK_LANE, status: "archived" };
    const mockPool = createWrapPool(
      archivedLane,
      0,
      "session-archived",
      "2026-06-08T12:00:00Z",
    );
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_wrap",
        arguments: {
          session_key: "old-lane",
          summary: "Final checkpoint of archived work",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.lane_status).toBe("archived");
      expect(parsed.session_id).toBe("session-archived");
    } finally {
      await cleanup();
    }
  });

  // ── KEY_DECISIONS AND NEXT_STEPS ──

  it("stores key_decisions and next_steps — returns success with session id", async () => {
    const mockPool = createWrapPool(
      MOCK_LANE,
      2,
      "session-uuid-3",
      "2026-06-08T14:00:00Z",
    );
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_wrap",
        arguments: {
          session_key: "ob-v2-dev",
          summary: "Session with structured data.",
          key_decisions: ["Use pgvector", "Split tools by domain"],
          next_steps: ["Add tests", "Deploy to staging"],
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.session_id).toBe("session-uuid-3");
      expect(parsed.lane_id).toBe("lane-uuid-1");
      expect(parsed.event_count).toBe(2);
    } finally {
      await cleanup();
    }
  });

  // ── EMBEDDING GENERATED ──

  it("generates embedding for summary", async () => {
    let embedCalled = false;
    let embedInput = "";
    const mockEmbed = async (text: string) => {
      embedCalled = true;
      embedInput = text;
      return Array(768).fill(0.5);
    };

    const mockPool = createWrapPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(
      mockPool,
      auth,
      mockEmbed,
    );

    try {
      await client.callTool({
        name: "session_wrap",
        arguments: {
          session_key: "ob-v2-dev",
          summary: "A detailed session summary for embedding.",
        },
      });

      expect(embedCalled).toBe(true);
      expect(embedInput).toBe("A detailed session summary for embedding.");
    } finally {
      await cleanup();
    }
  });

  // ── EMBEDDING FAILURE NON-FATAL ──

  it("embedding failure is non-fatal — session still saved", async () => {
    const mockPool = createWrapPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(
      mockPool,
      auth,
      createThrowingEmbed(new Error("LiteLLM down")),
    );

    try {
      const result = await client.callTool({
        name: "session_wrap",
        arguments: {
          session_key: "ob-v2-dev",
          summary: "Summary despite embed failure.",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.session_id).toBe("session-uuid-1");
    } finally {
      await cleanup();
    }
  });

  // ── EVENT COUNT RETURNED ──

  it("returns event count from lane", async () => {
    const mockPool = createWrapPool(MOCK_LANE, 42);
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_wrap",
        arguments: {
          session_key: "ob-v2-dev",
          summary: "Session with many events.",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.event_count).toBe(42);
    } finally {
      await cleanup();
    }
  });

  // ── PROJECT FALLBACK ──

  it("falls back to lane project when project not provided", async () => {
    const laneWithProject = { ...MOCK_LANE, project: "lane-project" };
    const mockPool = createWrapPool(
      laneWithProject,
      0,
      "session-uuid-4",
      "2026-06-08T15:00:00Z",
    );
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_wrap",
        arguments: {
          session_key: "ob-v2-dev",
          summary: "No explicit project.",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.session_id).toBe("session-uuid-4");
      expect(parsed.lane_id).toBe("lane-uuid-1");
    } finally {
      await cleanup();
    }
  });

  it("uses explicit project over lane project", async () => {
    const laneWithProject = { ...MOCK_LANE, project: "lane-project" };
    const mockPool = createWrapPool(
      laneWithProject,
      0,
      "session-uuid-5",
      "2026-06-08T15:30:00Z",
    );
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_wrap",
        arguments: {
          session_key: "ob-v2-dev",
          summary: "Explicit project override.",
          project: "explicit-project",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.session_id).toBe("session-uuid-5");
    } finally {
      await cleanup();
    }
  });

  // ── NAMESPACE DEFAULTING ──

  it("defaults namespace to auth.clientId when not provided", async () => {
    // Lane not found because the namespace won't match — returns error with the namespace info
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return { rows: [] }; // lane not found
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "nagatha" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_wrap",
        arguments: {
          session_key: "test",
          summary: "Namespace check.",
        },
      });

      // Lane not found error should contain the namespace (defaulted to clientId)
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("nagatha");
      expect((result.content as any)[0].text).toContain("Lane not found");
    } finally {
      await cleanup();
    }
  });

  // ── DUPLICATE CONTENT_HASH ──

  it("returns duplicate response when content_hash collides (already-wrapped lane)", async () => {
    const wrappedLane = { ...MOCK_LANE, status: "wrapped" };
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return { rows: [wrappedLane] };
        }
        if (sql.includes("count(*)")) {
          return { rows: [{ cnt: 5 }] };
        }
        if (sql.includes("INSERT INTO sessions")) {
          // ON CONFLICT DO NOTHING returns zero rows
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_wrap",
        arguments: {
          session_key: "ob-v2-dev",
          summary: "Already wrapped this.",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.duplicate).toBe(true);
      expect(parsed.lane_id).toBe("lane-uuid-1");
      expect(parsed.lane_status).toBe("wrapped");
      expect(parsed.message).toContain("identical content");
    } finally {
      await cleanup();
    }
  });

  it("duplicate checkpoint is a no-op — lane status unchanged", async () => {
    const activeLane = { ...MOCK_LANE, status: "active" };
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("FROM ob_session_lanes")) {
          return { rows: [activeLane] };
        }
        if (sql.includes("count(*)")) {
          return { rows: [{ cnt: 3 }] };
        }
        if (sql.includes("INSERT INTO sessions")) {
          return { rows: [] }; // duplicate
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "session_wrap",
        arguments: {
          session_key: "ob-v2-dev",
          summary: "Duplicate checkpoint.",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.duplicate).toBe(true);
      expect(parsed.lane_status).toBe("active");
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
        name: "session_wrap",
        arguments: {
          session_key: "crash",
          summary: "Will fail.",
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
