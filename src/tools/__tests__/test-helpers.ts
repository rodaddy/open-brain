/**
 * Shared test helpers for MCP tool tests.
 * Reduces boilerplate across test files.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

export type MockPool = {
  query: (...args: any[]) => Promise<{ rows: any[] }>;
};

export function createMockEmbed(
  result: number[] | null = Array(768).fill(0.1),
) {
  return async (_text: string) => result;
}

export function makeMockRows(count: number = 3) {
  return Array.from({ length: count }, (_, i) => ({
    source_type: "thought",
    id: `uuid-${i}`,
    content_preview: `Content preview ${i}`,
    distance: 0.1 + i * 0.05,
    tags: ["tag-a"],
    created_at: "2026-01-01T00:00:00Z",
  }));
}

/** Build a connected MCP client/server pair with a tool registered. */
export async function setupMcpClient(
  registerFn: (server: McpServer, deps: ToolDeps) => void,
  mockPool: MockPool,
  mockEmbed: ReturnType<typeof createMockEmbed>,
  auth: AuthInfo | null,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: mockEmbed };
  registerFn(server, deps);

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

/** Parse tool result JSON from MCP response. */
export function parseToolResult(result: any): any {
  return JSON.parse((result.content as any)[0].text);
}

/** Get raw text from MCP error response. */
export function getErrorText(result: any): string {
  return (result.content as any)[0].text;
}
