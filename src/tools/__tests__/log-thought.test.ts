import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerLogThought } from "../log-thought.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockPool(
  rows: Record<string, unknown>[] = [{ id: "test-uuid" }],
) {
  return {
    query: async () => ({ rows }),
  };
}

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
  registerLogThought(server, deps);

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

describe("log_thought", () => {
  describe("success with embedding", () => {
    it("returns { id, embedded: true } for valid input with tags", async () => {
      const mockPool = createMockPool([{ id: "test-uuid" }]);
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "A test thought", tags: ["test", "unit"] },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        const parsed = JSON.parse(text);
        expect(parsed.id).toBe("test-uuid");
        expect(parsed.embedded).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describe("embedding failure (graceful degradation)", () => {
    it("returns { id, embedded: false } when embedding fails", async () => {
      const mockPool = createMockPool([{ id: "degraded-uuid" }]);
      const mockEmbed = createMockEmbed(null); // Embedding fails
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "Thought without embedding" },
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
    it("returns merged: true when upsert merges tags on conflict", async () => {
      const mockPool = createMockPool([{ id: "existing-uuid", is_new: false }]);
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "Duplicate content" },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        const parsed = JSON.parse(text);
        expect(parsed.merged).toBe(true);
        expect(parsed.id).toBe("existing-uuid");
      } finally {
        await cleanup();
      }
    });
  });

  describe("namespace support", () => {
    it("defaults namespace to clientId when omitted", async () => {
      let capturedParams: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          capturedParams = args;
          return { rows: [{ id: "ns-uuid", is_new: true }] };
        },
      };
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "agent", clientId: "bilby" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "Bilby's thought" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.namespace).toBe("bilby");
        expect(capturedParams[1]).toContain("bilby");
      } finally {
        await cleanup();
      }
    });

    it("uses explicit namespace when provided", async () => {
      let capturedParams: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          capturedParams = args;
          return { rows: [{ id: "collab-uuid", is_new: true }] };
        },
      };
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "agent", clientId: "bilby" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "Shared thought", namespace: "collab" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.namespace).toBe("collab");
        expect(capturedParams[1]).toContain("collab");
      } finally {
        await cleanup();
      }
    });

    it("denies agent writing to another agent's namespace", async () => {
      const mockPool = createMockPool();
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "agent", clientId: "bilby" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "Cross-write", namespace: "nagatha" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });

    it("allows admin to write to any namespace", async () => {
      const mockPool = createMockPool([{ id: "admin-uuid", is_new: true }]);
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "rico" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "Admin write", namespace: "bilby" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.namespace).toBe("bilby");
      } finally {
        await cleanup();
      }
    });
  });

  describe("permission denied", () => {
    it("returns isError: true when role cannot write thoughts", async () => {
      const mockPool = createMockPool();
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "readonly", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "Should be denied" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });

    it("returns isError: true when auth is missing", async () => {
      const server = new McpServer({ name: "test", version: "1.0.0" });
      const mockPool = createMockPool();
      const deps: ToolDeps = {
        pool: mockPool as any,
        embedFn: createMockEmbed(),
      };
      registerLogThought(server, deps);

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      // Do NOT inject authInfo
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "No auth" },
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
});
