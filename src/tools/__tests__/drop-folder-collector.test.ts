import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDropFolderCollector } from "../drop-folder-collector.ts";
import { logger } from "../../logger.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

// A raw driver-message sentinel that a Postgres error could splice a file body
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

// An approved+active drop source row for a given root, mirroring the gate SELECT.
function approvedSourceRow(root: string) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    namespace: "admin-client",
    source_kind: "drop",
    external_id: "drop-a",
    title: "Drop A",
    scope: {},
    approval_state: "approved",
    approved_by: "admin-client",
    approved_at: "2026-01-01T00:00:00.000Z",
    lifecycle_state: "active",
    sync_state: "never_synced",
    language: null,
    config: { root },
    content_hash: null,
    last_synced_at: null,
    revision: 1,
    created_by: "admin-client",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "drop-tool-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("collect_drop_folder MCP boundary", () => {
  let restoreLogger: (() => void) | undefined;
  afterEach(() => {
    restoreLogger?.();
    restoreLogger = undefined;
  });

  it("maps an unexpected DB throw to a stable content-free envelope; response and logs omit the sentinel", async () => {
    await writeFile(join(root, "a.txt"), `${SENTINEL} body`);
    const rawDbError = Object.assign(
      new Error(`COPY failed detail: ${SENTINEL} in content`),
      { code: "XX000", name: "DatabaseError" },
    );
    // Gate SELECT succeeds (approved source), but the durable INSERT throws with
    // a driver message that embeds the file body sentinel.
    const mockPool = {
      query: async (...args: unknown[]) => {
        const sql = args[0];
        if (
          typeof sql === "string" &&
          sql.includes("FROM ob_sources") &&
          sql.includes("WHERE namespace = $1")
        ) {
          return { rows: [approvedSourceRow(root)] };
        }
        throw rawDbError;
      },
    };

    const capture = captureLogger();
    restoreLogger = capture.restore;

    const { client, cleanup } = await setupToolClient(mockPool, adminAuth);
    try {
      const result = await client.callTool({
        name: "collect_drop_folder",
        arguments: { external_id: "drop-a" },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      const parsed = JSON.parse(text);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe("internal_error");
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain("COPY failed");
      expect(text).not.toContain(root);

      const allLogs = capture.lines.join("\n");
      expect(allLogs).not.toContain(SENTINEL);
      expect(allLogs).not.toContain("COPY failed");
      expect(allLogs).not.toContain(root);
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

  it("returns a content-free eligible=false envelope for an unregistered source", async () => {
    // The gate SELECT returns no rows: the source is unregistered.
    const mockPool = { query: async () => ({ rows: [] }) };
    const { client, cleanup } = await setupToolClient(mockPool, adminAuth);
    try {
      const result = await client.callTool({
        name: "collect_drop_folder",
        arguments: { external_id: "drop-UNKNOWN" },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      const parsed = JSON.parse(text);
      expect(parsed.ok).toBe(false);
      expect(parsed.eligible).toBe(false);
      expect(parsed.code).toBe("not_found");
      expect(parsed.files).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("does not accept caller-supplied file bodies (strict schema rejects 'items')", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const { client, cleanup } = await setupToolClient(mockPool, adminAuth);
    try {
      const result = await client.callTool({
        name: "collect_drop_folder",
        arguments: {
          external_id: "drop-a",
          // The removed caller-body field. A strict schema must reject it.
          items: [{ external_id: "drop-a", content: `${SENTINEL} body` }],
        },
      });
      // Whether surfaced as a validation error or ignored, the sentinel body
      // must never be echoed and no collection with a body may occur.
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(text).not.toContain(SENTINEL);
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
        arguments: { external_id: "drop-a" },
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
