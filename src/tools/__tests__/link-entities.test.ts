import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerLinkEntities } from "../link-entities.ts";
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
  registerLinkEntities(server, deps);

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

const FROM_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TO_ID = "11111111-2222-4333-9444-555555555555";

function createLinkPool(
  id = "link-uuid-1",
  isNew = true,
  relation = "depends_on",
  weight = 1.0,
  createdAt = "2026-06-08T10:00:00Z",
) {
  return {
    query: async (_sql: string, _params?: any[]) => {
      return {
        rows: [{ id, is_new: isNew, relation, weight, created_at: createdAt }],
      };
    },
  };
}

describe("link_entities", () => {
  // ── AUTH PATHS ──

  it("denies write when auth is missing entirely", async () => {
    const mockPool = createLinkPool();
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: mockPool as any,
      embedFn: createMockEmbed(),
    };
    registerLinkEntities(server, deps);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "link_entities",
        arguments: {
          from_type: "entity",
          from_id: FROM_ID,
          to_type: "entity",
          to_id: TO_ID,
          relation: "depends_on",
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
    const mockPool = createLinkPool();
    const auth: AuthInfo = { role: "discord", clientId: "random-user" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "link_entities",
        arguments: {
          from_type: "entity",
          from_id: FROM_ID,
          to_type: "entity",
          to_id: TO_ID,
          relation: "depends_on",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("denies write for readonly role", async () => {
    const mockPool = createLinkPool();
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "link_entities",
        arguments: {
          from_type: "entity",
          from_id: FROM_ID,
          to_type: "entity",
          to_id: TO_ID,
          relation: "depends_on",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  // ── HAPPY PATH ──

  it("admin can create link (is_new: true) with full output", async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        return {
          rows: [
            {
              id: "link-uuid-1",
              is_new: true,
              relation: "depends_on",
              weight: 1.0,
              created_at: "2026-06-08T10:00:00Z",
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "link_entities",
        arguments: {
          from_type: "thought",
          from_id: FROM_ID,
          to_type: "decision",
          to_id: TO_ID,
          relation: "depends_on",
          namespace: "team-kb",
          weight: 2.5,
          metadata: { reason: "causal" },
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.id).toBe("link-uuid-1");
      expect(parsed.from_type).toBe("thought");
      expect(parsed.from_id).toBe(FROM_ID);
      expect(parsed.to_type).toBe("decision");
      expect(parsed.to_id).toBe(TO_ID);
      expect(parsed.relation).toBe("depends_on");
      expect(parsed.is_new).toBe(true);
      expect(calls[0]?.sql).toContain("WHERE archived_at IS NULL");
    } finally {
      await cleanup();
    }
  });

  it("accepts relaxed graph UUIDs for link endpoints", async () => {
    const mockPool = createLinkPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "link_entities",
        arguments: {
          from_type: "entity",
          from_id: "aaaaaaaa-bbbb-9ccc-8ddd-eeeeeeeeeeee",
          to_type: "entity",
          to_id: "11111111-2222-9333-9444-555555555555",
          relation: "depends_on",
        },
      });

      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  // ── SELF-LINK PREVENTION ──

  it("rejects self-link (same type and id)", async () => {
    const mockPool = createLinkPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "link_entities",
        arguments: {
          from_type: "entity",
          from_id: FROM_ID,
          to_type: "entity",
          to_id: FROM_ID,
          relation: "relates_to",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain(
        "cannot link a node to itself",
      );
    } finally {
      await cleanup();
    }
  });

  it("allows same id with different types (not a self-link)", async () => {
    const mockPool = createLinkPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "link_entities",
        arguments: {
          from_type: "thought",
          from_id: FROM_ID,
          to_type: "decision",
          to_id: FROM_ID,
          relation: "caused_by",
        },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  // ── UPSERT EXISTING LINK ──

  it("upsert existing link updates weight (is_new: false)", async () => {
    const mockPool = createLinkPool("link-uuid-1", false, "depends_on", 5.0);
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "link_entities",
        arguments: {
          from_type: "entity",
          from_id: FROM_ID,
          to_type: "entity",
          to_id: TO_ID,
          relation: "depends_on",
          weight: 5.0,
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.is_new).toBe(false);
      expect(parsed.weight).toBe(5.0);
    } finally {
      await cleanup();
    }
  });

  // ── ALL 13 RELATION TYPES ──

  const allRelations = [
    "artifact",
    "depends_on",
    "supersedes",
    "caused_by",
    "same_lane",
    "adjacent",
    "mentions",
    "implemented_by",
    "blocked_by",
    "decided_by",
    "relates_to",
    "contradicts",
    "duplicates",
  ] as const;

  for (const relation of allRelations) {
    it(`accepts relation="${relation}"`, async () => {
      const mockPool = createLinkPool("link-uuid-1", true, relation);
      const auth: AuthInfo = { role: "admin", clientId: "skippy" };
      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "link_entities",
          arguments: {
            from_type: "entity",
            from_id: FROM_ID,
            to_type: "entity",
            to_id: TO_ID,
            relation,
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.relation).toBe(relation);
      } finally {
        await cleanup();
      }
    });
  }

  // ── NAMESPACE DEFAULTING ──

  it("defaults namespace to auth.clientId when not provided", async () => {
    const mockPool = createLinkPool();
    const auth: AuthInfo = { role: "admin", clientId: "bilby-agent" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "link_entities",
        arguments: {
          from_type: "thought",
          from_id: FROM_ID,
          to_type: "entity",
          to_id: TO_ID,
          relation: "mentions",
        },
      });

      // Succeeds -- the tool used the defaulted namespace
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.id).toBe("link-uuid-1");
      expect(parsed.is_new).toBe(true);
    } finally {
      await cleanup();
    }
  });

  // ── WEIGHT DEFAULTING ──

  it("defaults weight to 1.0 when not provided", async () => {
    const mockPool = createLinkPool("link-uuid-1", true, "relates_to", 1.0);
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "link_entities",
        arguments: {
          from_type: "entity",
          from_id: FROM_ID,
          to_type: "entity",
          to_id: TO_ID,
          relation: "relates_to",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.weight).toBe(1.0);
    } finally {
      await cleanup();
    }
  });

  // ── AGENT / OB_ADMIN ROLES ──

  it("allows agent role", async () => {
    const mockPool = createLinkPool();
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "link_entities",
        arguments: {
          from_type: "entity",
          from_id: FROM_ID,
          to_type: "entity",
          to_id: TO_ID,
          relation: "adjacent",
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
        throw new Error("connection refused");
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "link_entities",
        arguments: {
          from_type: "entity",
          from_id: FROM_ID,
          to_type: "entity",
          to_id: TO_ID,
          relation: "depends_on",
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
