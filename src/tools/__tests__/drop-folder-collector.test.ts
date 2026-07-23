import { afterEach, describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDropFolderCollector } from "../drop-folder-collector.ts";
import { logger } from "../../logger.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

// A raw driver-message sentinel that a Postgres error could splice a drop body
// or path into. It must never reach the tool response OR the process logs.
const SENTINEL = "SECRET_DROP_BODY_9f2b_should_never_leak";

async function setupToolClient(
  mockPool: { query: (...args: unknown[]) => Promise<{ rows: unknown[] }> },
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool: mockPool as never,
    embedFn: async () => null,
  };
  registerDropFolderCollector(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalSend = clientTransport.send.bind(clientTransport);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

function captureLogger() {
  const lines: string[] = [];
  const methods = ["info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => logger[m]);
  for (const m of methods) {
    logger[m] = ((message: string, extra?: Record<string, unknown>) => {
      lines.push(extra ? `${message} ${JSON.stringify(extra)}` : message);
    }) as (typeof logger)[typeof m];
  }
  return {
    lines,
    restore: () => {
      methods.forEach((m, i) => {
        logger[m] = originals[i]!;
      });
    },
  };
}

const adminAuth: AuthInfo = {
  role: "admin",
  clientId: "admin-client",
  namespaceSource: "token",
};

describe("collect_drop_folder MCP boundary", () => {
  let restoreLogger: (() => void) | undefined;
  afterEach(() => {
    restoreLogger?.();
    restoreLogger = undefined;
  });

  it("maps an unexpected DB throw to a stable content-free envelope; response and logs omit the drop body sentinel", async () => {
    const rawDbError = Object.assign(
      new Error(`COPY failed detail: ${SENTINEL} in content`),
      { code: "XX000", name: "DatabaseError" },
    );
    const mockPool = {
      query: async () => {
        throw rawDbError;
      },
    };

    const capture = captureLogger();
    restoreLogger = capture.restore;

    const { client, cleanup } = await setupToolClient(mockPool, adminAuth);
    try {
      const result = await client.callTool({
        name: "collect_drop_folder",
        arguments: {
          external_id: "drop-a",
          items: [{ external_id: "drop-a", content: `${SENTINEL} body` }],
        },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      const parsed = JSON.parse(text);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe("internal_error");
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain("COPY failed");

      const allLogs = capture.lines.join("\n");
      expect(allLogs).not.toContain(SENTINEL);
      expect(allLogs).not.toContain("COPY failed");
      // The allowlisted error code is fine; it carries no content.
      const errLine = capture.lines.find((l) =>
        l.includes("collect_drop_folder_internal_error"),
      );
      expect(errLine).toBeDefined();
      expect(errLine).toContain("XX000");
    } finally {
      await cleanup();
    }
  });

  it("returns a content-free eligible=false envelope for an unregistered source; no body echoed", async () => {
    // The gate SELECT returns no rows: the source is unregistered.
    const mockPool = { query: async () => ({ rows: [] }) };
    const { client, cleanup } = await setupToolClient(mockPool, adminAuth);
    try {
      const result = await client.callTool({
        name: "collect_drop_folder",
        arguments: {
          external_id: "drop-UNKNOWN",
          items: [{ external_id: "drop-UNKNOWN", content: `${SENTINEL} body` }],
        },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      const parsed = JSON.parse(text);
      expect(parsed.ok).toBe(false);
      expect(parsed.eligible).toBe(false);
      expect(parsed.code).toBe("not_found");
      // No item was inspected or collected; the body never leaves.
      expect(text).not.toContain(SENTINEL);
      expect(parsed.items).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("rejects an unauthenticated caller", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerDropFolderCollector(server, {
      pool: mockPool as never,
      embedFn: async () => null,
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "collect_drop_folder",
        arguments: {
          external_id: "drop-a",
          items: [{ external_id: "drop-a", content: "x" }],
        },
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(
        (result.content as Array<{ text: string }>)[0]!.text,
      );
      expect(parsed.code).toBe("unauthenticated");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
