import { describe, expect, test } from "bun:test";
import {
  declaredParameterKeys,
  payloadSizeBucket,
  readMcpAuditConfig,
  recordMcpAudit,
  summarizeMcpAudit,
} from "./audit-log.ts";

describe("MCP audit log privacy helpers", () => {
  test("summarizes declared keys and counts unknown keys without storing unknown names", () => {
    const summary = summarizeMcpAudit({
      operation: "log_thought",
      status: "success",
      durationMs: 12.4,
      auth: {
        role: "admin",
        clientId: "delegated",
        tokenClientId: "rico",
        agentId: "worker-269",
        namespaceSource: "header",
      },
      declaredKeys: ["content", "tags", "namespace"],
      args: {
        content: "do not persist this prompt body",
        tags: ["secret-token-shaped-value"],
        namespace: "delegated",
        "/Users/rico/private.txt": "do not persist attacker key",
        api_key: "sk-live-secret-shaped-value",
      },
    });

    expect(summary).toMatchObject({
      operation: "log_thought",
      status: "success",
      durationMs: 12,
      callerRole: "admin",
      callerClientId: "delegated",
      callerTokenClientId: "rico",
      callerAgentId: "worker-269",
      namespaceSource: "header",
      declaredParameterKeys: ["content", "namespace", "tags"],
      unknownParameterCount: 2,
    });
    expect(JSON.stringify(summary)).not.toContain("do not persist");
    expect(JSON.stringify(summary)).not.toContain("/Users/rico");
    expect(JSON.stringify(summary)).not.toContain("api_key");
    expect(JSON.stringify(summary)).not.toContain("sk-live");
  });

  test("extracts declared keys from the repo's registerTool inputSchema shape", () => {
    expect(
      declaredParameterKeys({
        zeta: {},
        alpha: {},
        namespace: {},
      }),
    ).toEqual(["alpha", "namespace", "zeta"]);
  });

  test("buckets payload size instead of returning exact bytes", () => {
    expect(payloadSizeBucket({ q: "x" })).toBe("le_128b");
    expect(payloadSizeBucket({ q: "x".repeat(900) })).toBe("le_1kb");
    expect(payloadSizeBucket({ q: "x".repeat(5000) })).toBe("le_16kb");
  });

  test("supports disable and retention env controls", () => {
    expect(
      readMcpAuditConfig({
        OPENBRAIN_MCP_AUDIT_ENABLED: "0",
        OPENBRAIN_MCP_AUDIT_RETENTION_DAYS: "14",
        OPENBRAIN_MCP_AUDIT_CLEANUP_INTERVAL_MS: "60000",
      }),
    ).toEqual({
      enabled: false,
      retentionDays: 14,
      cleanupIntervalMs: 60000,
      writeTimeoutMs: 1000,
    });
  });

  test("retries retention cleanup after a failed cleanup attempt", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    let deleteAttempts = 0;
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.trimStart().startsWith("DELETE FROM mcp_tool_audit_log")) {
          deleteAttempts += 1;
          if (deleteAttempts === 1) {
            throw new Error("temporary cleanup outage");
          }
        }
        return { rows: [] };
      },
    };
    const config = {
      enabled: true,
      retentionDays: 30,
      cleanupIntervalMs: 0,
      writeTimeoutMs: 1000,
    };
    const state = { lastCleanupAt: 0 };
    const summary = summarizeMcpAudit({
      operation: "log_thought",
      status: "success",
      durationMs: 1,
      declaredKeys: ["content"],
      args: { content: "private text" },
    });

    await recordMcpAudit(
      { pool: pool as never, now: () => new Date(1000) },
      config,
      state,
      summary,
    );
    expect(deleteAttempts).toBe(1);
    expect(state.lastCleanupAt).toBe(0);

    await recordMcpAudit(
      { pool: pool as never, now: () => new Date(2000) },
      config,
      state,
      summary,
    );
    expect(deleteAttempts).toBe(2);
    expect(state.lastCleanupAt).toBe(2000);
    expect(
      calls.filter((call) =>
        call.sql.trimStart().startsWith("INSERT INTO mcp_tool_audit_log"),
      ),
    ).toHaveLength(2);
  });
});
