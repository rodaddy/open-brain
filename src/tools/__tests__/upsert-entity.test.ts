import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerUpsertEntity } from "../upsert-entity.ts";
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
  registerUpsertEntity(server, deps);

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

function createUpsertPool(
  id = "entity-uuid-1",
  isNew = true,
  entityType = "host",
  name = "ct235",
  namespace = "skippy",
  createdAt = "2026-06-08T10:00:00Z",
  updatedAt = "2026-06-08T10:00:00Z",
) {
  return {
    query: async (_sql: string, _params?: any[]) => {
      return {
        rows: [
          {
            id,
            is_new: isNew,
            entity_type: entityType,
            name,
            namespace,
            created_at: createdAt,
            updated_at: updatedAt,
          },
        ],
      };
    },
  };
}

describe("upsert_entity", () => {
  // ── AUTH PATHS ──

  it("denies write when auth is missing entirely", async () => {
    const mockPool = createUpsertPool();
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: mockPool as any,
      embedFn: createMockEmbed(),
    };
    registerUpsertEntity(server, deps);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "upsert_entity",
        arguments: {
          entity_type: "host",
          name: "ct235",
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
    const mockPool = createUpsertPool();
    const auth: AuthInfo = { role: "discord", clientId: "random-user" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "upsert_entity",
        arguments: {
          entity_type: "host",
          name: "ct235",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("denies write for readonly role", async () => {
    const mockPool = createUpsertPool();
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "upsert_entity",
        arguments: {
          entity_type: "host",
          name: "ct235",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  // ── HAPPY PATH ──

  it("admin can upsert entity (new entity, is_new: true)", async () => {
    const mockPool = createUpsertPool(
      "entity-uuid-1",
      true,
      "host",
      "ct235",
      "collab",
    );
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "upsert_entity",
        arguments: {
          entity_type: "host",
          name: "ct235",
          namespace: "collab",
          canonical_id: "host:ct235",
          metadata: { ip: "10.71.20.35" },
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.id).toBe("entity-uuid-1");
      expect(parsed.entity_type).toBe("host");
      expect(parsed.name).toBe("ct235");
      expect(parsed.namespace).toBe("collab");
      expect(parsed.is_new).toBe(true);
      expect(parsed.created_at).toBe("2026-06-08T10:00:00Z");
    } finally {
      await cleanup();
    }
  });

  it("upsert existing entity updates metadata (is_new: false)", async () => {
    const mockPool = createUpsertPool(
      "entity-uuid-1",
      false,
      "service",
      "open-brain",
      "collab",
      "2026-06-01T10:00:00Z",
      "2026-06-08T12:00:00Z",
    );
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "upsert_entity",
        arguments: {
          entity_type: "service",
          name: "open-brain",
          namespace: "collab",
          metadata: { version: "2.0" },
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.is_new).toBe(false);
      expect(parsed.updated_at).toBe("2026-06-08T12:00:00Z");
    } finally {
      await cleanup();
    }
  });

  // ── NAMESPACE DEFAULTING ──

  it("defaults namespace to auth.clientId when not provided", async () => {
    const mockPool = createUpsertPool(
      "entity-uuid-1",
      true,
      "workflow",
      "deploy-pipeline",
      "bilby-agent",
    );
    const auth: AuthInfo = { role: "admin", clientId: "bilby-agent" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "upsert_entity",
        arguments: {
          entity_type: "workflow",
          name: "deploy-pipeline",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.namespace).toBe("bilby-agent");
    } finally {
      await cleanup();
    }
  });

  // ── EMBEDDING PATHS ──

  it("embedding failure is non-fatal — entity still inserted", async () => {
    const mockPool = createUpsertPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(
      mockPool,
      auth,
      createThrowingEmbed(new Error("embedding provider timeout")),
    );

    try {
      const result = await client.callTool({
        name: "upsert_entity",
        arguments: {
          entity_type: "host",
          name: "ct235",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.id).toBe("entity-uuid-1");
    } finally {
      await cleanup();
    }
  });

  it("succeeds when embed returns null", async () => {
    const mockPool = createUpsertPool(
      "entity-uuid-1",
      true,
      "agent",
      "skippy",
      "skippy",
    );
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(
      mockPool,
      auth,
      createMockEmbed(null),
    );

    try {
      const result = await client.callTool({
        name: "upsert_entity",
        arguments: {
          entity_type: "agent",
          name: "skippy",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.id).toBe("entity-uuid-1");
      expect(parsed.name).toBe("skippy");
    } finally {
      await cleanup();
    }
  });

  // ── AGENT / OB_ADMIN ROLES ──

  it("allows agent role", async () => {
    const mockPool = createUpsertPool();
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "upsert_entity",
        arguments: {
          entity_type: "project",
          name: "test-project",
        },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  it("allows ob-admin role", async () => {
    const mockPool = createUpsertPool();
    const auth: AuthInfo = { role: "ob-admin", clientId: "ob-admin-worker" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "upsert_entity",
        arguments: {
          entity_type: "workflow",
          name: "daily-backup",
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
        name: "upsert_entity",
        arguments: {
          entity_type: "host",
          name: "ct999",
        },
      });

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("connection refused");
      expect((result.content as any)[0].text).toContain("Database error");
    } finally {
      await cleanup();
    }
  });

  // ── OPTIONAL FIELDS ──

  it("succeeds with only required fields (canonical_id, metadata omitted)", async () => {
    const mockPool = createUpsertPool();
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "upsert_entity",
        arguments: {
          entity_type: "host",
          name: "ct235",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.id).toBe("entity-uuid-1");
      expect(parsed.entity_type).toBe("host");
      expect(parsed.name).toBe("ct235");
    } finally {
      await cleanup();
    }
  });
});
