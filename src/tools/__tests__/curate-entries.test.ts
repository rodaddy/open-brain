import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerCurateEntries } from "../curate-entries.ts";
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
  registerCurateEntries(server, deps);

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

describe("curate_entries", () => {
  it("finds stale entries in dry_run mode", async () => {
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("access_count") && sql.includes("INTERVAL")) {
          return {
            rows: [
              { id: "stale-uuid-1", content_preview: "Old unused thought" },
              { id: "stale-uuid-2", content_preview: "Another stale entry" },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "curate_entries",
        arguments: { mode: "stale", dry_run: true },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.dry_run).toBe(true);
      expect(parsed.summary.stale_found).toBeGreaterThan(0);
      expect(parsed.stale[0].action).toBe("would_flag");
    } finally {
      await cleanup();
    }
  });

  it("denies agent role for dry_run=false", async () => {
    const mockPool = {
      query: async () => ({ rows: [] }),
    };
    const auth: AuthInfo = { role: "agent", clientId: "agent-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "curate_entries",
        arguments: { mode: "all", dry_run: false },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as any)[0].text;
      expect(text).toContain("delete permission required");
    } finally {
      await cleanup();
    }
  });

  it("allows agent role for dry_run=true", async () => {
    const mockPool = {
      query: async () => ({ rows: [] }),
    };
    const auth: AuthInfo = { role: "agent", clientId: "agent-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "curate_entries",
        arguments: { mode: "vague", dry_run: true },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.dry_run).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("finds duplicates", async () => {
    const mockPool = {
      query: async (sql: string) => {
        if (sql.includes("embedding <=> b.embedding")) {
          return {
            rows: [{ id_a: "dup-a", id_b: "dup-b", distance: 0.04 }],
          };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "curate_entries",
        arguments: { mode: "duplicates", table: "thoughts" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.summary.duplicates_found).toBe(1);
    } finally {
      await cleanup();
    }
  });
});
