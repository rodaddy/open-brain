import { afterEach, describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSourceRegistry } from "../source-registry.ts";
import { logger } from "../../logger.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

// A sentinel that stands in for the kind of raw row/source value a Postgres
// driver can splice into err.message (e.g. a failed COPY echoing row bytes).
// It must never reach the tool response OR the process logs.
const SENTINEL = "SECRET_ROW_VALUE_9f2b_should_never_leak";

async function setupToolClient(
  mockPool: { query: (...args: unknown[]) => Promise<{ rows: unknown[] }> },
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool: mockPool as never,
    embedFn: async () => null,
  };
  registerSourceRegistry(server, deps);

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

// Capture everything the logger emits, so a test can prove the sentinel never
// lands in a log line. We wrap the shared logger's own methods (not console.*):
// the logger is a singleton other suites also spy on/replace, and the tool code
// logs THROUGH it, so intercepting at the logger seam is both the exact surface
// under test and immune to any leaked console/logger indirection from a
// concurrently-loaded test file. Both the message and the structured `extra`
// are serialized into `lines` so an assertion sees everything that would be
// emitted (a raw driver message could hide in either).
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

describe("source registry MCP error boundary (issue #337 content-free catch)", () => {
  let restoreLogger: (() => void) | undefined;
  afterEach(() => {
    restoreLogger?.();
    restoreLogger = undefined;
  });

  it("maps an unexpected non-23505 DB failure to a stable content-free envelope; response and logs omit the sentinel", async () => {
    // A raw driver error whose message carries a row/source value. This is NOT
    // an expected typed result (not a unique-violation, not namespace_denied);
    // it must be intercepted and never surfaced verbatim.
    const rawDbError = Object.assign(
      new Error(`duplicate key detail: ${SENTINEL} in tags[]`),
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
        name: "register_source",
        arguments: {
          source_kind: "git",
          external_id: "https://example.test/repo.git",
        },
      });

      // The response is the ONE stable content-free envelope.
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      const parsed = JSON.parse(text);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe("internal_error");
      expect(parsed.error).toBe("source registry operation failed");
      // The raw message / sentinel never reaches the caller.
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain("duplicate key detail");

      // And nothing the logger emitted carries the sentinel or raw message.
      const allLogs = capture.lines.join("\n");
      expect(allLogs).not.toContain(SENTINEL);
      expect(allLogs).not.toContain("duplicate key detail");
      // The operation name and an allowlisted error code/name ARE logged.
      const internalErrorLine = capture.lines.find((l) =>
        l.includes("source_registry_internal_error"),
      );
      expect(internalErrorLine).toBeDefined();
      expect(internalErrorLine).toContain("register_source");
      // Allowlisted code (XX000) is fine; it carries no content.
      expect(internalErrorLine).toContain("XX000");
    } finally {
      await cleanup();
    }
  });

  it("preserves a typed expected result (namespace_denied) instead of collapsing it to internal_error", async () => {
    // A header-scoped identity requesting a foreign namespace is a typed
    // expected denial, returned by the registry layer without a throw. It must
    // keep its own code, not be swallowed by the internal-error catch.
    const headerAuth: AuthInfo = {
      role: "admin",
      clientId: "alice",
      namespaceSource: "header",
    };
    const mockPool = {
      // Should never be reached: the denial happens before any query.
      query: async () => ({ rows: [] }),
    };
    const { client, cleanup } = await setupToolClient(mockPool, headerAuth);
    try {
      const result = await client.callTool({
        name: "register_source",
        arguments: {
          source_kind: "git",
          external_id: "https://example.test/repo.git",
          target_namespace: "beta",
        },
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(
        (result.content as Array<{ text: string }>)[0]!.text,
      );
      expect(parsed.code).toBe("namespace_denied");
    } finally {
      await cleanup();
    }
  });
});
