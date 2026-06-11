import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerLaneLoad } from "../lane-load.ts";
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
  registerLaneLoad(server, deps);

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
  id: "uuid-lane-1",
  session_key: "ob-v2-dev",
  namespace: "skippy",
  status: "active",
  agent: "skippy",
  source: "discord",
  channel_id: "123456",
  thread_id: null,
  project: "open-brain",
  topic: "OB v2 development",
  current_context_md: "## Active work\nSession lanes migration.",
  metadata: {},
  created_by: "skippy",
  created_at: "2026-06-07T15:30:00Z",
  updated_at: "2026-06-07T16:00:00Z",
  ended_at: null,
};

describe("lane_load", () => {
  // ── AUTH PATHS ──

  it("denies read when auth is missing entirely", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: mockPool as any,
      embedFn: createMockEmbed(),
    };
    registerLaneLoad(server, deps);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "lane_load",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("denies read for discord role", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = { role: "discord", clientId: "random-user" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_load",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("allows admin role", async () => {
    const mockPool = { query: async () => ({ rows: [MOCK_LANE] }) };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_load",
        arguments: { session_key: "ob-v2-dev" },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  it("allows agent role", async () => {
    const mockPool = { query: async () => ({ rows: [MOCK_LANE] }) };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_load",
        arguments: { session_key: "ob-v2-dev" },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  it("allows readonly role", async () => {
    const mockPool = { query: async () => ({ rows: [MOCK_LANE] }) };
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_load",
        arguments: { session_key: "ob-v2-dev" },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  // ── KEY LOOKUP (most common path) ──

  it("loads a lane by session_key — returns full fields", async () => {
    const mockPool = { query: async () => ({ rows: [MOCK_LANE] }) };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_load",
        arguments: { session_key: "ob-v2-dev" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.lanes[0].session_key).toBe("ob-v2-dev");
      expect(parsed.lanes[0].project).toBe("open-brain");
      expect(parsed.lanes[0].agent).toBe("skippy");
      expect(parsed.lanes[0].current_context_md).toContain("Session lanes");
    } finally {
      await cleanup();
    }
  });

  // ── EMPTY RESULTS ──

  it("returns empty lanes array with message for key miss", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_load",
        arguments: { session_key: "nonexistent" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.lanes).toEqual([]);
      expect(parsed.message).toContain("No lane found");
      expect(parsed.message).toContain("nonexistent");
    } finally {
      await cleanup();
    }
  });

  it("returns generic message when no key specified and no matches", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_load",
        arguments: { project: "nonexistent-project" },
      });

      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.lanes).toEqual([]);
      expect(parsed.message).toContain("No active lanes found");
    } finally {
      await cleanup();
    }
  });

  // ── FILTER COMBINATIONS ──

  it("returns matching lanes when all filters provided", async () => {
    const filteredLane = {
      ...MOCK_LANE,
      id: "uuid-filtered",
      session_key: "my-lane",
      namespace: "collab",
      agent: "bilby",
      channel_id: "999",
      status: "wrapped",
    };
    const mockPool = { query: async () => ({ rows: [filteredLane] }) };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_load",
        arguments: {
          session_key: "my-lane",
          namespace: "collab",
          project: "open-brain",
          agent: "bilby",
          channel_id: "999",
          status: "wrapped",
          limit: 5,
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.lanes[0].session_key).toBe("my-lane");
      expect(parsed.lanes[0].namespace).toBe("collab");
      expect(parsed.lanes[0].agent).toBe("bilby");
      expect(parsed.lanes[0].status).toBe("wrapped");
    } finally {
      await cleanup();
    }
  });

  // ── NAMESPACE DEFAULTING ──

  it("defaults namespace to auth.clientId when not provided", async () => {
    // Mock returns lane with namespace matching auth.clientId, proving
    // the tool queried with the right namespace
    const nagathLane = { ...MOCK_LANE, namespace: "nagatha" };
    const mockPool = { query: async () => ({ rows: [nagathLane] }) };
    const auth: AuthInfo = { role: "admin", clientId: "nagatha" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_load",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.lanes[0].namespace).toBe("nagatha");
    } finally {
      await cleanup();
    }
  });

  it("denies explicit unreadable namespace for agent role", async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        return { rows: [MOCK_LANE] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_load",
        arguments: { namespace: "skippy" },
      });

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  // ── STATUS DEFAULTING ──

  it("defaults status to 'active' when not specified", async () => {
    // Mock returns active lane, proving the tool used active as default
    const mockPool = { query: async () => ({ rows: [MOCK_LANE] }) };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_load",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.lanes[0].status).toBe("active");
    } finally {
      await cleanup();
    }
  });

  // ── LIMIT DEFAULTING ──

  it("defaults limit to 10 when not specified", async () => {
    // Return exactly 10 lanes to show limit is working
    const lanes = Array.from({ length: 10 }, (_, i) => ({
      ...MOCK_LANE,
      id: `uuid-${i}`,
      session_key: `lane-${i}`,
    }));
    const mockPool = { query: async () => ({ rows: lanes }) };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_load",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.count).toBe(10);
    } finally {
      await cleanup();
    }
  });

  // ── MULTIPLE RESULTS ──

  it("returns multiple lanes ordered by updated_at DESC", async () => {
    const lanes = [
      {
        ...MOCK_LANE,
        id: "uuid-1",
        session_key: "lane-a",
        updated_at: "2026-06-07T18:00:00Z",
      },
      {
        ...MOCK_LANE,
        id: "uuid-2",
        session_key: "lane-b",
        updated_at: "2026-06-07T17:00:00Z",
      },
      {
        ...MOCK_LANE,
        id: "uuid-3",
        session_key: "lane-c",
        updated_at: "2026-06-07T16:00:00Z",
      },
    ];
    const mockPool = { query: async () => ({ rows: lanes }) };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_load",
        arguments: { project: "open-brain" },
      });

      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.count).toBe(3);
      expect(parsed.lanes[0].session_key).toBe("lane-a");
      expect(parsed.lanes[2].session_key).toBe("lane-c");
    } finally {
      await cleanup();
    }
  });

  // ── DATABASE ERROR PATH ──

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
        name: "lane_load",
        arguments: { session_key: "crash-lane" },
      });

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("connection timeout");
      expect((result.content as any)[0].text).toContain("Database error");
    } finally {
      await cleanup();
    }
  });
});
