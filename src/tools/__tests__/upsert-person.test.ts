import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerUpsertPerson } from "../upsert-person.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

async function setupToolClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  mockEmbed: ReturnType<typeof createMockEmbed>,
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: mockEmbed };
  registerUpsertPerson(server, deps);

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

describe("upsert_person", () => {
  it("creates a new person (insert path)", async () => {
    const mockPool = {
      query: async () => ({ rows: [{ id: "new-uuid", inserted: true }] }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "test-client" };
    const { client, cleanup } = await setupToolClient(
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "upsert_person",
        arguments: {
          name: "Jackie Rojas",
          context: "Partner",
          relationship_type: "family",
          warmth: 5,
          email: "jackie@example.com",
          tags: ["family"],
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.id).toBe("new-uuid");
      expect(parsed.person_name).toBe("Jackie Rojas");
      expect(parsed.action).toBe("created");
      expect(parsed.embedded).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("updates an existing person (conflict path)", async () => {
    const mockPool = {
      query: async () => ({
        rows: [{ id: "existing-uuid", inserted: false }],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "test-client" };
    const { client, cleanup } = await setupToolClient(
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "upsert_person",
        arguments: {
          name: "Jackie Rojas",
          warmth: 4,
          notes: "Updated notes",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.id).toBe("existing-uuid");
      expect(parsed.action).toBe("updated");
    } finally {
      await cleanup();
    }
  });

  it("works with minimal fields (name only)", async () => {
    const mockPool = {
      query: async () => ({ rows: [{ id: "min-uuid", inserted: true }] }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "test-client" };
    const { client, cleanup } = await setupToolClient(
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "upsert_person",
        arguments: { name: "Test Person" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.action).toBe("created");
      expect(parsed.person_name).toBe("Test Person");
    } finally {
      await cleanup();
    }
  });

  it("handles metadata field for extensible contact info", async () => {
    const mockPool = {
      query: async () => ({ rows: [{ id: "meta-uuid", inserted: true }] }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "test-client" };
    const { client, cleanup } = await setupToolClient(
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "upsert_person",
        arguments: {
          name: "Rico",
          metadata: { apple_id: "rico@icloud.com", imessage: true },
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.id).toBe("meta-uuid");
      expect(parsed.action).toBe("created");
    } finally {
      await cleanup();
    }
  });

  it("handles embedding failure gracefully (still inserts)", async () => {
    const mockPool = {
      query: async () => ({
        rows: [{ id: "no-embed-uuid", inserted: true }],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "test-client" };
    const { client, cleanup } = await setupToolClient(
      mockPool,
      createMockEmbed(null),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "upsert_person",
        arguments: { name: "No Embed Person" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.embedded).toBe(false);
      expect(parsed.action).toBe("created");
    } finally {
      await cleanup();
    }
  });

  describe("permissions", () => {
    it("denies readonly role", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      const auth: AuthInfo = { role: "readonly", clientId: "reader" };
      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "upsert_person",
          arguments: { name: "Test" },
        });

        expect(result.isError).toBe(true);
        expect((result.content as any)[0].text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });

    it("allows agent role (upgraded to RW)", async () => {
      const mockPool = {
        query: async () => ({
          rows: [{ id: "agent-uuid", inserted: true }],
        }),
      };
      const auth: AuthInfo = { role: "agent", clientId: "claude-code" };
      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "upsert_person",
          arguments: { name: "Agent Created Person" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.action).toBe("created");
      } finally {
        await cleanup();
      }
    });

    it("denies discord role", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      const auth: AuthInfo = { role: "discord", clientId: "discord-bot" };
      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "upsert_person",
          arguments: { name: "Test" },
        });

        expect(result.isError).toBe(true);
        expect((result.content as any)[0].text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });
  });
});
