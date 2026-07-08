import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrainServer } from "../../server.ts";
import { registerAllTools } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function auditPool(options: { failAudit?: boolean } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    pool: {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("mcp_tool_audit_log")) {
          if (options.failAudit) throw new Error("audit table unavailable");
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
}) {
  const server = createBrainServer();
  registerAllTools(server, {
    pool: input.pool as any,
    embedFn: async () => null,
    mcpAuditConfig: {
      enabled: input.auditEnabled ?? true,
      retentionDays: 30,
      cleanupIntervalMs: 60_000,
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
      0,
      expect.stringMatching(/^le_|^gt_|^0b$/),
    ]);
    expect(JSON.stringify(insert?.params)).not.toContain("raw prompt text");
    expect(JSON.stringify(insert?.params)).not.toContain("token-shaped-secret");
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
