import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSessionSave } from "../session-save.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

async function setupToolClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  mockEmbed: ReturnType<typeof createMockEmbed>,
  auth?: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: mockEmbed };
  registerSessionSave(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  if (auth) {
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message: any, options?: any) => {
      return originalSend(message, { ...options, authInfo: auth });
    };
  }

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

describe("session_save", () => {
  describe("success with embedding", () => {
    it("returns id and embedded=true when embedding succeeds", async () => {
      const mockPool = {
        query: async () => ({ rows: [{ id: "session-uuid" }] }),
      };
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: {
            summary: "Completed auth implementation",
            project: "open-brain",
            tags: ["auth", "phase-1"],
            blockers: ["Need API key"],
            next_steps: ["Write tests", "Deploy"],
            key_decisions: ["Use JWT", "30min TTL"],
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("session-uuid");
        expect(parsed.embedded).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describe("embedding failure (graceful degradation)", () => {
    it("returns id and embedded=false when embedding returns null", async () => {
      const mockPool = {
        query: async () => ({ rows: [{ id: "degraded-uuid" }] }),
      };
      const mockEmbed = createMockEmbed(null);
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: { summary: "Session without embedding" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("degraded-uuid");
        expect(parsed.embedded).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });

  describe("duplicate content (content_hash conflict)", () => {
    it("returns Duplicate message without isError", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }), // Empty rows = ON CONFLICT DO NOTHING
      };
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: { summary: "Duplicate session content" },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        expect(text).toContain("Duplicate");
      } finally {
        await cleanup();
      }
    });
  });

  describe("permission denied", () => {
    it("returns isError for readonly role", async () => {
      const mockPool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "readonly", clientId: "test-readonly" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: { summary: "Should be denied" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });

    it("returns isError for discord role", async () => {
      const mockPool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "discord", clientId: "test-discord" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: { summary: "Discord denied" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });

    it("returns isError when auth is missing", async () => {
      const server = new McpServer({ name: "test", version: "1.0.0" });
      const mockPool = { query: async () => ({ rows: [] }) };
      const deps: ToolDeps = {
        pool: mockPool as any,
        embedFn: createMockEmbed(),
      };
      registerSessionSave(server, deps);

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: { summary: "No auth" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  describe("optional fields default handling", () => {
    it("succeeds with only summary provided (minimal input)", async () => {
      const mockPool = {
        query: async () => ({ rows: [{ id: "defaults-uuid" }] }),
      };
      const auth: AuthInfo = { role: "n8n", clientId: "test-n8n" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: { summary: "Minimal session" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("defaults-uuid");
        expect(parsed.embedded).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describe("session_id upsert path", () => {
    it("returns merged=false for new session_id insert", async () => {
      const mockPool = {
        query: async () => ({ rows: [{ id: "upsert-uuid", is_new: true }] }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: {
            summary: "New session with ID",
            session_id: "ext-session-001",
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("upsert-uuid");
        expect(parsed.session_id).toBe("ext-session-001");
        expect(parsed.merged).toBe(false);
        expect(parsed.embedded).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("returns merged=true for existing session_id update", async () => {
      const mockPool = {
        query: async () => ({ rows: [{ id: "upsert-uuid", is_new: false }] }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: {
            summary: "Updated session",
            session_id: "ext-session-001",
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.merged).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });
});
