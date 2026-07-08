import { describe, expect, test } from "bun:test";
import {
  captureArgsFacts,
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

  test("un-serializable payloads bucket as unknown, not 0b", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(payloadSizeBucket(circular)).toBe("unknown");
    expect(payloadSizeBucket({ big: 1n })).toBe("unknown");
    expect(payloadSizeBucket(() => "not json")).toBe("unknown");
  });

  test("clamps non-finite durations to zero instead of violating the CHECK", () => {
    for (const durationMs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const summary = summarizeMcpAudit({
        operation: "log_thought",
        status: "success",
        durationMs,
        declaredKeys: ["content"],
        args: { content: "x" },
      });
      expect(summary.durationMs).toBe(0);
    }
  });

  test("prefers raw-args capture over parsed (stripped) args", () => {
    const summary = summarizeMcpAudit({
      operation: "log_thought",
      status: "success",
      durationMs: 1,
      declaredKeys: ["content"],
      // Parsed view after Zod stripped the undeclared key.
      args: { content: "short" },
      // Raw view captured by the validation hook before stripping.
      rawArgs: captureArgsFacts({
        content: "short",
        undeclared_probe: "x".repeat(5000),
      }),
    });
    expect(summary.unknownParameterCount).toBe(1);
    expect(summary.payloadSizeBucket).toBe("le_16kb");
  });

  test("caps per-key unknown scanning on adversarially wide payloads", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 300; i += 1) wide[`k${i}`] = "v";
    const facts = captureArgsFacts(wide);
    expect(facts.rawKeys).toBeNull();
    expect(facts.rawKeyCount).toBe(300);

    const summary = summarizeMcpAudit({
      operation: "log_thought",
      status: "success",
      durationMs: 1,
      declaredKeys: ["k0"],
      args: wide,
      rawArgs: facts,
    });
    // Over the cap every raw key counts as unknown; no per-key comparison.
    expect(summary.unknownParameterCount).toBe(300);
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

  test("non-integer env values fall back instead of being coerced", () => {
    // parseInt would accept "1.5" (-> 1) and "60000ms" (-> 60000); the strict
    // digits-only rule must reject both and use the defaults.
    expect(
      readMcpAuditConfig({
        OPENBRAIN_MCP_AUDIT_RETENTION_DAYS: "1.5",
        OPENBRAIN_MCP_AUDIT_CLEANUP_INTERVAL_MS: "60000ms",
        OPENBRAIN_MCP_AUDIT_WRITE_TIMEOUT_MS: " 500 ",
      }),
    ).toEqual({
      enabled: true,
      retentionDays: 30,
      cleanupIntervalMs: 3600000,
      writeTimeoutMs: 1000,
    });
  });

  test("large payloads hit the top bucket via early exit, without full serialization", () => {
    expect(
      payloadSizeBucket({ content: "x".repeat(2 * 1024 * 1024) }),
    ).toBe("gt_1mb");
    expect(
      payloadSizeBucket({ items: Array.from({ length: 3_000_000 }, () => 1) }),
    ).toBe("gt_1mb");
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
