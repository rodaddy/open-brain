import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrainServer } from "../../server.ts";
import { installMcpAudit } from "../../audit-log.ts";
import { registerAllTools } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function auditPool(options: {
  failAudit?: boolean;
  deferAuditInsert?: Promise<{ rows: unknown[] }>;
} = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    pool: {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        const statement = sql.trimStart();
        if (statement.startsWith("INSERT INTO mcp_tool_audit_log")) {
          if (options.failAudit) throw new Error("audit table unavailable");
          if (options.deferAuditInsert) return options.deferAuditInsert;
          return { rows: [] };
        }
        if (statement.startsWith("DELETE FROM mcp_tool_audit_log")) {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO thoughts")) {
          return { rows: [{ id: "audit-test-id", is_new: true, source_refs: [] }] };
        }
        return { rows: [] };
      },
    },
  };
}

async function setupClient(input: {
  auth: AuthInfo;
  pool: ReturnType<typeof auditPool>["pool"];
  auditEnabled?: boolean;
  preinstallAuditTimes?: number;
  writeTimeoutMs?: number;
}) {
  const writeTimeoutMs = input.writeTimeoutMs ?? 1000;
  const server = createBrainServer();
  for (let i = 0; i < (input.preinstallAuditTimes ?? 0); i += 1) {
    installMcpAudit(server, {
      pool: input.pool as any,
      config: {
        enabled: true,
        retentionDays: 30,
        cleanupIntervalMs: 60_000,
        writeTimeoutMs,
      },
    });
  }
  registerAllTools(server, {
    pool: input.pool as any,
    embedFn: async () => null,
    mcpAuditConfig: {
      enabled: input.auditEnabled ?? true,
      retentionDays: 30,
      cleanupIntervalMs: 60_000,
      writeTimeoutMs,
    },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message: any, options?: any) =>
    originalSend(message, { ...options, authInfo: input.auth });

  const client = new Client({ name: "audit-test", version: "1.0.0" });
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

describe("MCP tool audit logging", () => {
  test("records safe metadata for a successful tool call", async () => {
    const store = auditPool();
    const { client, cleanup } = await setupClient({
      pool: store.pool,
      auth: {
        role: "admin",
        clientId: "delegated",
        tokenClientId: "rico",
        agentId: "worker-269",
        namespaceSource: "header",
      },
    });

    try {
      const result = await client.callTool({
        name: "log_thought",
        arguments: {
          content: "raw prompt text must not be audited",
          tags: ["token-shaped-secret"],
          namespace: "delegated",
        },
      });
      expect(result.isError).toBeFalsy();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      await cleanup();
    }

    const insert = store.calls.find((call) =>
      call.sql.includes("INSERT INTO mcp_tool_audit_log"),
    );
    expect(insert).toBeDefined();
    expect(insert?.params).toEqual([
      "log_thought",
      "success",
      expect.any(Number),
      "admin",
      "delegated",
      "rico",
      "worker-269",
      "header",
      JSON.stringify(["content", "namespace", "source_refs", "tags"]),
      // All argument keys are declared, so the RAW-args unknown count is 0.
      0,
      // Bucket of the RAW request arguments (~100 bytes of JSON).
      "le_128b",
    ]);
    expect(JSON.stringify(insert?.params)).not.toContain("raw prompt text");
    expect(JSON.stringify(insert?.params)).not.toContain("token-shaped-secret");
  });

  test("counts undeclared keys and buckets raw payload size before Zod stripping", async () => {
    const store = auditPool();
    const { client, cleanup } = await setupClient({
      pool: store.pool,
      auth: { role: "agent", clientId: "rico" },
    });

    try {
      const result = await client.callTool({
        name: "log_thought",
        arguments: {
          content: "small declared value",
          // Undeclared key with a large value: Zod strips it before the tool
          // handler runs, so only the raw-args capture can see it.
          undeclared_probe_key: "x".repeat(5000),
        },
      });
      expect(result.isError).toBeFalsy();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      await cleanup();
    }

    const insert = store.calls.find((call) =>
      call.sql.includes("INSERT INTO mcp_tool_audit_log"),
    );
    expect(insert).toBeDefined();
    // unknown_parameter_count reflects the RAW request arguments.
    expect(insert?.params[9]).toBe(1);
    // payload_size_bucket reflects the RAW ~5KB payload, not the post-strip
    // ~50-byte parsed args (which would bucket as le_128b).
    expect(insert?.params[10]).toBe("le_16kb");
    expect(JSON.stringify(insert?.params)).not.toContain(
      "undeclared_probe_key",
    );
  });

  test("audit write failures fail open for user-facing tool calls", async () => {
    const store = auditPool({ failAudit: true });
    const { client, cleanup } = await setupClient({
      pool: store.pool,
      auth: { role: "admin", clientId: "rico" },
    });

    try {
      const result = await client.callTool({
        name: "log_thought",
        arguments: { content: "still succeeds" },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  test("installing the audit wrapper twice records one audit row per call", async () => {
    const store = auditPool();
    const { client, cleanup } = await setupClient({
      pool: store.pool,
      preinstallAuditTimes: 2,
      auth: { role: "admin", clientId: "rico" },
    });

    try {
      const result = await client.callTool({
        name: "log_thought",
        arguments: { content: "logged once" },
      });
      expect(result.isError).toBeFalsy();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      await cleanup();
    }

    const inserts = store.calls.filter((call) =>
      call.sql.includes("INSERT INTO mcp_tool_audit_log"),
    );
    expect(inserts).toHaveLength(1);
  });

  test("shares the retention cleanup clock across sessions on one pool", async () => {
    const store = auditPool();
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    // Two installMcpAudit calls on two separate server instances (fresh
    // server per MCP session, as in src/index.ts serverFactory) sharing one
    // pool must share one cleanup interval clock.
    const sessionOne = await setupClient({ pool: store.pool, auth });
    const sessionTwo = await setupClient({ pool: store.pool, auth });

    const countDeletes = () =>
      store.calls.filter((call) =>
        call.sql.trimStart().startsWith("DELETE FROM mcp_tool_audit_log"),
      ).length;

    try {
      const first = await sessionOne.client.callTool({
        name: "log_thought",
        arguments: { content: "session one call" },
      });
      expect(first.isError).toBeFalsy();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(countDeletes()).toBe(1);

      const second = await sessionTwo.client.callTool({
        name: "log_thought",
        arguments: { content: "session two call" },
      });
      expect(second.isError).toBeFalsy();
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Second session's first call must NOT re-trigger the retention DELETE
      // within the cleanup interval.
      expect(countDeletes()).toBe(1);
    } finally {
      await sessionOne.cleanup();
      await sessionTwo.cleanup();
    }
  });

  test("skips audit writes above the in-flight cap instead of queueing", async () => {
    const insert = deferred<{ rows: unknown[] }>();
    const store = auditPool({ deferAuditInsert: insert.promise });
    const { client, cleanup } = await setupClient({
      pool: store.pool,
      writeTimeoutMs: 50,
      auth: { role: "admin", clientId: "rico" },
    });

    try {
      // Audit INSERTs never resolve, so in-flight writes accumulate until the
      // cap (16); the remaining calls must skip their audit write entirely
      // while still succeeding for the caller.
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          client.callTool({
            name: "log_thought",
            arguments: { content: `call ${index}` },
          }),
        ),
      );
      for (const result of results) expect(result.isError).toBeFalsy();
    } finally {
      insert.resolve({ rows: [] });
      await cleanup();
    }

    const inserts = store.calls.filter((call) =>
      call.sql.includes("INSERT INTO mcp_tool_audit_log"),
    );
    expect(inserts).toHaveLength(16);
  });

  test("slow audit writes are bounded by the write timeout", async () => {
    const insert = deferred<{ rows: unknown[] }>();
    const store = auditPool({ deferAuditInsert: insert.promise });
    const { client, cleanup } = await setupClient({
      pool: store.pool,
      writeTimeoutMs: 50,
      auth: { role: "admin", clientId: "rico" },
    });

    try {
      // Without the bounded write timeout this call would never resolve,
      // because the audit insert promise stays pending.
      const result = await client.callTool({
        name: "log_thought",
        arguments: { content: "audit insert hangs" },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      insert.resolve({ rows: [] });
      await cleanup();
    }
  });

  test("disable control suppresses audit writes", async () => {
    const store = auditPool();
    const { client, cleanup } = await setupClient({
      pool: store.pool,
      auditEnabled: false,
      auth: { role: "admin", clientId: "rico" },
    });

    try {
      const result = await client.callTool({
        name: "log_thought",
        arguments: { content: "not audited" },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }

    expect(
      store.calls.some((call) => call.sql.includes("mcp_tool_audit_log")),
    ).toBe(false);
  });
});
