import type pg from "pg";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "./types.ts";
import { logger } from "./logger.ts";

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_WRITE_TIMEOUT_MS = 1000;
const MAX_RETENTION_DAYS = 366;
const MIN_WRITE_TIMEOUT_MS = 50;
const MAX_WRITE_TIMEOUT_MS = 5000;
const auditInstalledServers = new WeakSet<McpServer>();

export interface McpAuditConfig {
  enabled: boolean;
  retentionDays: number;
  cleanupIntervalMs: number;
  writeTimeoutMs: number;
}

export interface McpAuditDeps {
  pool: pg.Pool;
  config?: McpAuditConfig;
  now?: () => Date;
}

export interface McpAuditSummary {
  operation: string;
  status: "success" | "error" | "exception";
  durationMs: number;
  callerRole: string | null;
  callerClientId: string | null;
  callerTokenClientId: string | null;
  callerAgentId: string | null;
  namespaceSource: string | null;
  declaredParameterKeys: string[];
  unknownParameterCount: number;
  payloadSizeBucket: string;
}

export interface McpAuditState {
  lastCleanupAt: number;
}

type RegisterTool = McpServer["registerTool"];

export function readMcpAuditConfig(
  env: Record<string, string | undefined> = process.env,
): McpAuditConfig {
  return {
    enabled: env.OPENBRAIN_MCP_AUDIT_ENABLED !== "0",
    retentionDays: readBoundedInt(
      env.OPENBRAIN_MCP_AUDIT_RETENTION_DAYS,
      1,
      MAX_RETENTION_DAYS,
      DEFAULT_RETENTION_DAYS,
    ),
    cleanupIntervalMs: readBoundedInt(
      env.OPENBRAIN_MCP_AUDIT_CLEANUP_INTERVAL_MS,
      60_000,
      24 * 60 * 60 * 1000,
      DEFAULT_CLEANUP_INTERVAL_MS,
    ),
    writeTimeoutMs: readBoundedInt(
      env.OPENBRAIN_MCP_AUDIT_WRITE_TIMEOUT_MS,
      MIN_WRITE_TIMEOUT_MS,
      MAX_WRITE_TIMEOUT_MS,
      DEFAULT_WRITE_TIMEOUT_MS,
    ),
  };
}

function readBoundedInt(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

export function declaredParameterKeys(inputSchema: unknown): string[] {
  if (!inputSchema || typeof inputSchema !== "object") return [];
  return Object.keys(inputSchema as Record<string, unknown>).sort();
}

function ownKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>);
}

export function payloadSizeBucket(input: unknown): string {
  const json = safeStringify(input);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes === 0) return "0b";
  if (bytes <= 128) return "le_128b";
  if (bytes <= 512) return "le_512b";
  if (bytes <= 1024) return "le_1kb";
  if (bytes <= 4096) return "le_4kb";
  if (bytes <= 16 * 1024) return "le_16kb";
  if (bytes <= 64 * 1024) return "le_64kb";
  if (bytes <= 256 * 1024) return "le_256kb";
  if (bytes <= 1024 * 1024) return "le_1mb";
  return "gt_1mb";
}

function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input ?? null);
  } catch {
    return "";
  }
}

export function summarizeMcpAudit(input: {
  operation: string;
  status: McpAuditSummary["status"];
  durationMs: number;
  auth?: AuthInfo;
  declaredKeys: string[];
  args: unknown;
}): McpAuditSummary {
  const declared = [...new Set(input.declaredKeys)].sort();
  const declaredSet = new Set(declared);
  const unknownParameterCount = ownKeys(input.args).filter(
    (key) => !declaredSet.has(key),
  ).length;

  return {
    operation: input.operation,
    status: input.status,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    callerRole: input.auth?.role ?? null,
    callerClientId: input.auth?.clientId ?? null,
    callerTokenClientId: input.auth?.tokenClientId ?? null,
    callerAgentId: input.auth?.agentId ?? null,
    namespaceSource: input.auth?.namespaceSource ?? null,
    declaredParameterKeys: declared,
    unknownParameterCount,
    payloadSizeBucket: payloadSizeBucket(input.args),
  };
}

export function installMcpAudit(server: McpServer, deps: McpAuditDeps): void {
  const config = deps.config ?? readMcpAuditConfig();
  if (!config.enabled) return;
  if (auditInstalledServers.has(server)) return;
  auditInstalledServers.add(server);

  const state: McpAuditState = { lastCleanupAt: 0 };
  const original = server.registerTool.bind(server) as RegisterTool;
  server.registerTool = ((name: string, configOrDescription: unknown, cb?: unknown) => {
    if (typeof cb !== "function") {
      return (original as unknown as (...args: unknown[]) => unknown)(
        name,
        configOrDescription,
        cb,
      );
    }

    const declaredKeys = declaredParameterKeys(
      (configOrDescription as { inputSchema?: unknown } | undefined)
        ?.inputSchema,
    );
    const callback = cb as (args: unknown, extra: unknown) => unknown;
    const wrapped = async (args: unknown, extra: unknown) => {
      const started = Date.now();
      const auth = (extra as { authInfo?: AuthInfo } | undefined)?.authInfo;
      try {
        const result = await callback(args, extra);
        const status = isToolError(result) ? "error" : "success";
        await writeMcpAuditWithTimeout(deps, config, state, summarizeMcpAudit({
          operation: name,
          status,
          durationMs: Date.now() - started,
          auth,
          declaredKeys,
          args,
        }));
        return result;
      } catch (err) {
        await writeMcpAuditWithTimeout(deps, config, state, summarizeMcpAudit({
          operation: name,
          status: "exception",
          durationMs: Date.now() - started,
          auth,
          declaredKeys,
          args,
        }));
        throw err;
      }
    };

    return (original as unknown as (...args: unknown[]) => unknown)(
      name,
      configOrDescription,
      wrapped,
    );
  }) as RegisterTool;
}

function isToolError(result: unknown): boolean {
  return Boolean(
    result &&
      typeof result === "object" &&
      (result as { isError?: unknown }).isError === true,
  );
}

async function writeMcpAuditWithTimeout(
  deps: McpAuditDeps,
  config: McpAuditConfig,
  state: McpAuditState,
  summary: McpAuditSummary,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const write = recordMcpAudit(deps, config, state, summary);
  const timed = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), config.writeTimeoutMs);
  });
  const outcome = await Promise.race([
    write.then(() => "written" as const),
    timed,
  ]);
  if (timeout) clearTimeout(timeout);
  if (outcome === "timeout") {
    logger.warn("mcp_tool_audit_write_timeout", {
      operation: summary.operation,
      status: summary.status,
      timeoutMs: config.writeTimeoutMs,
    });
  }
}

export async function recordMcpAudit(
  deps: McpAuditDeps,
  config: McpAuditConfig,
  state: McpAuditState,
  summary: McpAuditSummary,
): Promise<void> {
  try {
    await deps.pool.query(
      `INSERT INTO mcp_tool_audit_log (
        operation,
        status,
        duration_ms,
        caller_role,
        caller_client_id,
        caller_token_client_id,
        caller_agent_id,
        namespace_source,
        declared_parameter_keys,
        unknown_parameter_count,
        payload_size_bucket
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
      [
        summary.operation,
        summary.status,
        summary.durationMs,
        summary.callerRole,
        summary.callerClientId,
        summary.callerTokenClientId,
        summary.callerAgentId,
        summary.namespaceSource,
        JSON.stringify(summary.declaredParameterKeys),
        summary.unknownParameterCount,
        summary.payloadSizeBucket,
      ],
    );
    await maybeCleanupAuditLog(deps, config, state);
  } catch (err) {
    logger.warn("mcp_tool_audit_write_failed", {
      operation: summary.operation,
      status: summary.status,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function maybeCleanupAuditLog(
  deps: McpAuditDeps,
  config: McpAuditConfig,
  state: McpAuditState,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))().getTime();
  if (now - state.lastCleanupAt < config.cleanupIntervalMs) return Promise.resolve();
  return deps.pool
    .query(
      `DELETE FROM mcp_tool_audit_log
       WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [config.retentionDays],
    )
    .then(() => {
      state.lastCleanupAt = now;
    })
    .catch((err: unknown) => {
      logger.warn("mcp_tool_audit_cleanup_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
