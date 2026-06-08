import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAdjacentContext } from "../adjacent-context.ts";
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
  registerAdjacentContext(server, deps);

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

const SOURCE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const LINKED_ID_1 = "11111111-2222-4333-9444-555555555555";
const LINKED_ID_2 = "66666666-7777-4888-9999-aaaaaaaaaaaa";

const MOCK_OUTGOING_LINKS = [
  {
    id: "link-1",
    from_type: "entity",
    from_id: SOURCE_ID,
    to_type: "thought",
    to_id: LINKED_ID_1,
    relation: "mentions",
    weight: 2.0,
    metadata: {},
    created_at: "2026-06-08T10:00:00Z",
  },
  {
    id: "link-2",
    from_type: "entity",
    from_id: SOURCE_ID,
    to_type: "decision",
    to_id: LINKED_ID_2,
    relation: "decided_by",
    weight: 1.0,
    metadata: { context: "review" },
    created_at: "2026-06-08T09:00:00Z",
  },
];

const MOCK_INCOMING_LINKS = [
  {
    id: "link-3",
    from_type: "session",
    from_id: LINKED_ID_1,
    to_type: "entity",
    to_id: SOURCE_ID,
    relation: "artifact",
    weight: 1.5,
    metadata: {},
    created_at: "2026-06-08T08:00:00Z",
  },
];

describe("adjacent_context", () => {
  // ── AUTH PATHS ──

  it("denies read when auth is missing entirely", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: mockPool as any,
      embedFn: createMockEmbed(),
    };
    registerAdjacentContext(server, deps);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "adjacent_context",
        arguments: {
          type: "entity",
          id: SOURCE_ID,
        },
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
        name: "adjacent_context",
        arguments: {
          type: "entity",
          id: SOURCE_ID,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("allows readonly role (read tool)", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "adjacent_context",
        arguments: {
          type: "entity",
          id: SOURCE_ID,
        },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  // ── OUTGOING LINKS ──

  it("returns outgoing links", async () => {
    let capturedSql = "";
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        capturedSql = sql;
        return { rows: MOCK_OUTGOING_LINKS };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "adjacent_context",
        arguments: {
          type: "entity",
          id: SOURCE_ID,
          direction: "outgoing",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.count).toBe(2);
      expect(parsed.links[0].direction).toBe("outgoing");
      expect(parsed.links[0].linked_type).toBe("thought");
      expect(parsed.links[0].linked_id).toBe(LINKED_ID_1);
      expect(parsed.links[0].relation).toBe("mentions");
      expect(parsed.links[1].linked_type).toBe("decision");

      // SQL should have from_type/from_id only
      expect(capturedSql).toContain("from_type = $1 AND from_id = $2");
      expect(capturedSql).not.toContain("to_type = $1");
    } finally {
      await cleanup();
    }
  });

  // ── INCOMING LINKS ──

  it("returns incoming links", async () => {
    let capturedSql = "";
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        capturedSql = sql;
        return { rows: MOCK_INCOMING_LINKS };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "adjacent_context",
        arguments: {
          type: "entity",
          id: SOURCE_ID,
          direction: "incoming",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.links[0].direction).toBe("incoming");
      expect(parsed.links[0].linked_type).toBe("session");
      expect(parsed.links[0].linked_id).toBe(LINKED_ID_1);
      expect(parsed.links[0].relation).toBe("artifact");

      // SQL should have to_type/to_id only
      expect(capturedSql).toContain("to_type = $1 AND to_id = $2");
      expect(capturedSql).not.toContain("from_type = $1 AND from_id = $2");
    } finally {
      await cleanup();
    }
  });

  // ── BOTH DIRECTIONS ──

  it("returns both directions (default)", async () => {
    let capturedSql = "";
    const allLinks = [...MOCK_OUTGOING_LINKS, ...MOCK_INCOMING_LINKS];
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        capturedSql = sql;
        return { rows: allLinks };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "adjacent_context",
        arguments: {
          type: "entity",
          id: SOURCE_ID,
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.count).toBe(3);

      // Should have both outgoing and incoming
      const directions = parsed.links.map((l: any) => l.direction);
      expect(directions).toContain("outgoing");
      expect(directions).toContain("incoming");

      // SQL should have OR clause
      expect(capturedSql).toContain("from_type = $1 AND from_id = $2");
      expect(capturedSql).toContain("OR");
      expect(capturedSql).toContain("to_type = $1 AND to_id = $2");
    } finally {
      await cleanup();
    }
  });

  // ── RELATION FILTER ──

  it("filters by relation type", async () => {
    let capturedSql = "";
    let capturedParams: any[] | undefined;
    const mockPool = {
      query: async (sql: string, params?: any[]) => {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [MOCK_OUTGOING_LINKS[0]] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "adjacent_context",
        arguments: {
          type: "entity",
          id: SOURCE_ID,
          relation: "mentions",
        },
      });

      expect(result.isError).toBeFalsy();
      expect(capturedSql).toContain("relation =");
      expect(capturedParams!).toContain("mentions");
    } finally {
      await cleanup();
    }
  });

  // ── NAMESPACE FILTER ──

  it("applies namespace filter", async () => {
    let capturedParams: any[] | undefined;
    const mockPool = {
      query: async (_sql: string, params?: any[]) => {
        capturedParams = params;
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "adjacent_context",
        arguments: {
          type: "entity",
          id: SOURCE_ID,
          namespace: "collab",
        },
      });

      expect(result.isError).toBeFalsy();
      expect(capturedParams!).toContain("collab");
    } finally {
      await cleanup();
    }
  });

  it("defaults namespace to auth.clientId", async () => {
    let capturedParams: any[] | undefined;
    const mockPool = {
      query: async (_sql: string, params?: any[]) => {
        capturedParams = params;
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "nagatha" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      await client.callTool({
        name: "adjacent_context",
        arguments: {
          type: "entity",
          id: SOURCE_ID,
        },
      });

      expect(capturedParams!).toContain("nagatha");
    } finally {
      await cleanup();
    }
  });

  // ── EMPTY RESULTS ──

  it("returns empty links array when no links found", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "adjacent_context",
        arguments: {
          type: "entity",
          id: SOURCE_ID,
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.links).toEqual([]);
      expect(parsed.count).toBe(0);
    } finally {
      await cleanup();
    }
  });

  // ── LIMIT ──

  it("respects limit parameter", async () => {
    let capturedSql = "";
    let capturedParams: any[] | undefined;
    const mockPool = {
      query: async (sql: string, params?: any[]) => {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [MOCK_OUTGOING_LINKS[0]] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      await client.callTool({
        name: "adjacent_context",
        arguments: {
          type: "entity",
          id: SOURCE_ID,
          limit: 5,
        },
      });

      // Limit should be the last param
      expect(capturedParams![capturedParams!.length - 1]).toBe(5);
      expect(capturedSql).toContain("LIMIT");
    } finally {
      await cleanup();
    }
  });

  it("defaults limit to 50", async () => {
    let capturedParams: any[] | undefined;
    const mockPool = {
      query: async (_sql: string, params?: any[]) => {
        capturedParams = params;
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      await client.callTool({
        name: "adjacent_context",
        arguments: {
          type: "entity",
          id: SOURCE_ID,
        },
      });

      expect(capturedParams![capturedParams!.length - 1]).toBe(50);
    } finally {
      await cleanup();
    }
  });

  // ── AGENT / N8N ROLES ──

  it("allows agent role", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "adjacent_context",
        arguments: {
          type: "entity",
          id: SOURCE_ID,
        },
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
        name: "adjacent_context",
        arguments: {
          type: "entity",
          id: SOURCE_ID,
        },
      });

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("connection timeout");
      expect((result.content as any)[0].text).toContain("Database error");
    } finally {
      await cleanup();
    }
  });
});
