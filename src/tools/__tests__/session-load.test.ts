import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSessionLoad } from "../session-load.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

const MOCK_SESSION = {
  id: "session-uuid",
  project: "open-brain",
  summary: "Implemented auth system",
  tags: ["auth", "phase-1"],
  blockers: ["API key needed"],
  next_steps: ["Write tests"],
  key_decisions: ["Use JWT"],
  created_by: "test-client",
  created_at: "2026-01-01T00:00:00Z",
};

async function setupToolClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  auth?: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: createMockEmbed() };
  registerSessionLoad(server, deps);

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

describe("session_load", () => {
  describe("with project filter", () => {
    it("returns most recent session for the specified project", async () => {
      const mockPool = {
        query: async () => ({ rows: [MOCK_SESSION] }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "session_load",
          arguments: { project: "open-brain" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("session-uuid");
        expect(parsed.project).toBe("open-brain");
        expect(parsed.summary).toBe("Implemented auth system");
        expect(parsed.created_by).toBe("test-client");
        expect(parsed.created_at).toBe("2026-01-01T00:00:00Z");
      } finally {
        await cleanup();
      }
    });

    it("scopes project load to readable namespaces", async () => {
      const calls: Array<{ sql: string; params?: any[] }> = [];
      const mockPool = {
        query: async (sql: string, params?: any[]) => {
          calls.push({ sql, params });
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "agent", clientId: "bilby" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        await client.callTool({
          name: "session_load",
          arguments: { project: "open-brain" },
        });

        expect(calls[0]!.sql).toContain("namespace = ANY($2::text[])");
        expect(calls[0]!.params).toEqual(["open-brain", ["bilby", "collab"]]);
      } finally {
        await cleanup();
      }
    });
  });

  describe("without project filter (global)", () => {
    it("returns most recent session across all projects", async () => {
      const mockPool = {
        query: async () => ({ rows: [MOCK_SESSION] }),
      };
      const auth: AuthInfo = { role: "readonly", clientId: "test-readonly" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "session_load",
          arguments: {},
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("session-uuid");
        expect(parsed.summary).toBe("Implemented auth system");
      } finally {
        await cleanup();
      }
    });

    it("scopes global load to readable namespaces", async () => {
      const calls: Array<{ sql: string; params?: any[] }> = [];
      const mockPool = {
        query: async (sql: string, params?: any[]) => {
          calls.push({ sql, params });
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "agent", clientId: "bilby" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        await client.callTool({
          name: "session_load",
          arguments: {},
        });

        expect(calls[0]!.sql).toContain("namespace = ANY($1::text[])");
        expect(calls[0]!.params).toEqual([["bilby", "collab"]]);
      } finally {
        await cleanup();
      }
    });
  });

  describe("no sessions found", () => {
    it("returns informational message for project with no sessions", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "session_load",
          arguments: { project: "nonexistent" },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        expect(text).toContain("No sessions found for project: nonexistent");
      } finally {
        await cleanup();
      }
    });

    it("returns informational message when no sessions exist globally", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "test-client" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "session_load",
          arguments: {},
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        expect(text).toBe("No sessions found");
      } finally {
        await cleanup();
      }
    });
  });

  describe("structured fields as arrays", () => {
    it("returns tags, blockers, next_steps, key_decisions as arrays", async () => {
      const mockPool = {
        query: async () => ({ rows: [MOCK_SESSION] }),
      };
      const auth: AuthInfo = { role: "agent", clientId: "test-agent" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "session_load",
          arguments: { project: "open-brain" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(Array.isArray(parsed.tags)).toBe(true);
        expect(Array.isArray(parsed.blockers)).toBe(true);
        expect(Array.isArray(parsed.next_steps)).toBe(true);
        expect(Array.isArray(parsed.key_decisions)).toBe(true);
        expect(parsed.tags).toEqual(["auth", "phase-1"]);
        expect(parsed.blockers).toEqual(["API key needed"]);
        expect(parsed.next_steps).toEqual(["Write tests"]);
        expect(parsed.key_decisions).toEqual(["Use JWT"]);
      } finally {
        await cleanup();
      }
    });
  });

  describe("permission denied", () => {
    it("returns isError for discord role", async () => {
      const mockPool = {
        query: async () => ({ rows: [] }),
      };
      const auth: AuthInfo = { role: "discord", clientId: "test-discord" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "session_load",
          arguments: {},
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });
  });
});
