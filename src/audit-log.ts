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
// Bound for per-key unknown-parameter comparison on adversarially wide
// payloads. Above this, every raw key is counted as unknown without any
// per-key set membership work.
const MAX_UNKNOWN_KEY_SCAN = 256;
// Cap on detached audit INSERTs still running against the pool. Kept well
// below the default pool size (10) so hung audit writes can never occupy the
// whole shared pool; beyond it audit writes are skipped (fail open) so a slow
// database cannot let audit writes starve real tool queries.
const MAX_IN_FLIGHT_AUDIT_WRITES = 4;
// Early-exit boundary for the payload size estimator: once the running
// estimate passes the top bucket boundary there is nothing left to learn.
const SIZE_ESTIMATE_EARLY_EXIT_BYTES = 1024 * 1024;
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
  status: "success" | "error" | "exception" | "validation_error";
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
  cleanupInFlight?: boolean;
}

interface SharedMcpAuditState extends McpAuditState {
  inFlightWrites: number;
}

// Facts about the RAW (pre-Zod-validation) request arguments, captured before
// the SDK strips undeclared keys. Held only in process memory (never
// persisted); rawKeys is null when the request exceeds MAX_UNKNOWN_KEY_SCAN.
export interface RawArgsAuditCapture {
  rawKeyCount: number;
  rawKeys: string[] | null;
  payloadSizeBucket: string;
}

// Cleanup/backpressure state is process-scoped and keyed by pool so per-session
// server construction (serverFactory in src/index.ts) shares one retention
// clock and one in-flight budget, while tests with separate pools stay
// isolated.
const sharedStateByPool = new WeakMap<object, SharedMcpAuditState>();

function sharedAuditState(pool: pg.Pool): SharedMcpAuditState {
  let state = sharedStateByPool.get(pool);
  if (!state) {
    state = { lastCleanupAt: 0, inFlightWrites: 0 };
    sharedStateByPool.set(pool, state);
  }
  return state;
}

// Raw-args metrics ride from the repo-owned validation hook
// (validateToolInputWithSummary) to the audit wrapper keyed by the identity of
// the parsed-data object: the SDK dispatch passes validateToolInput's return
// value to the tool handler unchanged (node_modules/@modelcontextprotocol/sdk
// dist mcp.js: `const args = await this.validateToolInput(...)` then
// `executeToolHandler(tool, args, extra)` -> `handler(args, extra)`).
const rawArgsCaptureByParsed = new WeakMap<object, RawArgsAuditCapture>();

// The validation hook is installed unconditionally (createBrainServer), but
// raw-args measurement should only cost anything once auditing is actually
// installed for this process.
let rawArgsCaptureEnabled = false;

export function captureArgsFacts(args: unknown): RawArgsAuditCapture {
  const keys = ownKeys(args);
  return {
    rawKeyCount: keys.length,
    rawKeys: keys.length > MAX_UNKNOWN_KEY_SCAN ? null : keys,
    payloadSizeBucket: payloadSizeBucket(args),
  };
}

export function captureRawArgsForAudit(
  rawArgs: unknown,
  parsedData: unknown,
): void {
  if (!rawArgsCaptureEnabled) return;
  if (!parsedData || typeof parsedData !== "object") return;
  rawArgsCaptureByParsed.set(parsedData as object, captureArgsFacts(rawArgs));
}

function takeRawArgsAuditCapture(
  parsedArgs: unknown,
): RawArgsAuditCapture | undefined {
  if (!parsedArgs || typeof parsedArgs !== "object") return undefined;
  const capture = rawArgsCaptureByParsed.get(parsedArgs as object);
  if (capture) rawArgsCaptureByParsed.delete(parsedArgs as object);
  return capture;
}

type RegisterTool = McpServer["registerTool"];

type ToolInputValidator = (
  tool: unknown,
  args: unknown,
  toolName: string,
) => Promise<unknown>;

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
  // Strict base-10 digits only: parseInt would silently accept "1.5" (-> 1)
  // and "1000ms" (-> 1000), contradicting the documented fallback behavior.
  if (!/^[0-9]+$/.test(raw)) return fallback;
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
  const bytes = estimateJsonBytes(input);
  // Un-measurable payloads get a distinct sentinel so "couldn't measure"
  // is never conflated with "empty".
  if (bytes === null) return "unknown";
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

// Approximates the JSON-serialized byte size of a value WITHOUT materializing
// the JSON string, so the request path never builds a full copy of an
// unbounded content string just to bucket it. String cost is code-unit length
// plus quotes plus a ~6% escaping/multi-byte fudge; containers add structural
// overhead. Traversal exits early once the running total passes the top
// bucket boundary. Returns null for values JSON.stringify could not serialize
// (a cycle, a BigInt anywhere, or a lone non-JSON value), which buckets as
// "unknown". Buckets are coarse by design; the estimate only needs to land in
// the right order of magnitude.
function estimateJsonBytes(input: unknown): number | null {
  const top = input ?? null;
  if (typeof top === "function" || typeof top === "symbol") return null;
  // Raw MCP arguments are transport-parsed JSON (always trees), so an object
  // seen twice can only mean a cycle in practice.
  const seen = new Set<object>();
  const stack: unknown[] = [top];
  let total = 0;
  while (stack.length > 0) {
    if (total > SIZE_ESTIMATE_EARLY_EXIT_BYTES) return total;
    const value = stack.pop();
    if (value === null || value === undefined) {
      total += 4;
      continue;
    }
    switch (typeof value) {
      case "string":
        total += value.length + 2 + (value.length >> 4);
        break;
      case "number":
        total += Number.isFinite(value) ? String(value).length : 4;
        break;
      case "boolean":
        total += value ? 4 : 5;
        break;
      case "bigint":
        // JSON.stringify throws on BigInt anywhere in the value.
        return null;
      case "object": {
        if (seen.has(value as object)) return null;
        seen.add(value as object);
        if (Array.isArray(value)) {
          // Brackets plus one comma per element; element bytes are counted
          // up front so an adversarially long array trips the early exit
          // before its members are pushed.
          total += 2 + value.length;
          if (total > SIZE_ESTIMATE_EARLY_EXIT_BYTES) return total;
          for (const item of value) stack.push(item);
        } else {
          const entries = Object.entries(value as Record<string, unknown>);
          total += 2 + entries.length;
          if (total > SIZE_ESTIMATE_EARLY_EXIT_BYTES) return total;
          for (const [key, item] of entries) {
            total += key.length + 3;
            stack.push(item);
          }
        }
        break;
      }
      default:
        // Nested function/symbol: JSON omits the member (object) or emits
        // null (array); either way the contribution is negligible.
        break;
    }
  }
  return total;
}

export function summarizeMcpAudit(input: {
  operation: string;
  status: McpAuditSummary["status"];
  durationMs: number;
  auth?: AuthInfo;
  declaredKeys: string[];
  args: unknown;
  // Raw pre-validation facts from the validation hook; when absent (paths
  // that bypass validateToolInputWithSummary) the parsed args are measured.
  rawArgs?: RawArgsAuditCapture;
}): McpAuditSummary {
  const declared = [...new Set(input.declaredKeys)].sort();
  const declaredSet = new Set(declared);
  const facts = input.rawArgs ?? captureArgsFacts(input.args);
  // Over the scan cap, per-key comparison is skipped and every raw key counts
  // as unknown (rawKeys is null); such requests are adversarial by shape.
  const unknownParameterCount =
    facts.rawKeys === null
      ? facts.rawKeyCount
      : facts.rawKeys.filter((key) => !declaredSet.has(key)).length;

  return {
    operation: input.operation,
    status: input.status,
    durationMs: Number.isFinite(input.durationMs)
      ? Math.max(0, Math.round(input.durationMs))
      : 0,
    callerRole: input.auth?.role ?? null,
    callerClientId: input.auth?.clientId ?? null,
    callerTokenClientId: input.auth?.tokenClientId ?? null,
    callerAgentId: input.auth?.agentId ?? null,
    namespaceSource: input.auth?.namespaceSource ?? null,
    declaredParameterKeys: declared,
    unknownParameterCount,
    payloadSizeBucket: facts.payloadSizeBucket,
  };
}

export function installMcpAudit(server: McpServer, deps: McpAuditDeps): void {
  const config = deps.config ?? readMcpAuditConfig();
  if (!config.enabled) return;
  if (auditInstalledServers.has(server)) return;
  auditInstalledServers.add(server);
  rawArgsCaptureEnabled = true;

  const state = sharedAuditState(deps.pool);
  // Declared keys per tool name, populated by the registerTool wrapper below
  // and reused by the validation-failure audit path (which only has the tool
  // name and the SDK's compiled schema object).
  const declaredKeysByTool = new Map<string, string[]>();

  // Validation failures never reach the tool handler, so the most
  // security-relevant probes (undeclared keys plus an invalid payload) would
  // otherwise leave no audit row. Wrap the server's validateToolInput hook to
  // record them with status "validation_error". The SDK invokes this hook as
  // validateToolInput(tool, request.params.arguments, toolName) with no
  // request extra, so no auth context exists at this layer: caller fields
  // stay null by construction. Unknown-tool-name calls are rejected above any
  // repo-owned hook and remain unaudited (documented limitation).
  const validatorHost = server as unknown as {
    validateToolInput?: ToolInputValidator;
  };
  if (typeof validatorHost.validateToolInput === "function") {
    const originalValidate = validatorHost.validateToolInput.bind(
      server,
    ) as ToolInputValidator;
    validatorHost.validateToolInput = async (tool, args, toolName) => {
      const started = Date.now();
      try {
        return await originalValidate(tool, args, toolName);
      } catch (err) {
        await writeMcpAuditWithTimeout(deps, config, state, summarizeMcpAudit({
          operation: toolName,
          status: "validation_error",
          durationMs: Date.now() - started,
          declaredKeys: declaredKeysByTool.get(toolName) ?? [],
          args,
          rawArgs: captureArgsFacts(args),
        }));
        throw err;
      }
    };
  }

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
    declaredKeysByTool.set(name, declaredKeys);
    const callback = cb as (args: unknown, extra: unknown) => unknown;
    const wrapped = async (args: unknown, extra: unknown) => {
      const started = Date.now();
      const auth = (extra as { authInfo?: AuthInfo } | undefined)?.authInfo;
      const rawArgs = takeRawArgsAuditCapture(args);
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
          rawArgs,
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
          rawArgs,
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
  state: SharedMcpAuditState,
  summary: McpAuditSummary,
): Promise<void> {
  // Never compete with real tool queries for connections: skip when the pool
  // already has waiters, or when too many audit writes are still in flight.
  const waitingCount =
    (deps.pool as { waitingCount?: number }).waitingCount ?? 0;
  if (
    state.inFlightWrites >= MAX_IN_FLIGHT_AUDIT_WRITES ||
    waitingCount > 0
  ) {
    logger.warn("mcp_tool_audit_write_skipped", {
      operation: summary.operation,
      status: summary.status,
      inFlightWrites: state.inFlightWrites,
      waitingCount,
    });
    return;
  }
  state.inFlightWrites += 1;
  // insertMcpAudit never rejects (it catches and logs), so finally/then are
  // safe to chain without another catch.
  const write = insertMcpAudit(deps, summary).finally(() => {
    state.inFlightWrites -= 1;
  });
  // Retention cleanup fires detached after the INSERT settles; it never
  // participates in the response-latency race and catches its own errors.
  void write.then((inserted) => {
    if (inserted) return maybeCleanupAuditLog(deps, config, state);
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
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
  const inserted = await insertMcpAudit(deps, summary);
  if (inserted) await maybeCleanupAuditLog(deps, config, state);
}

async function insertMcpAudit(
  deps: McpAuditDeps,
  summary: McpAuditSummary,
): Promise<boolean> {
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
    return true;
  } catch (err) {
    logger.warn("mcp_tool_audit_write_failed", {
      operation: summary.operation,
      status: summary.status,
      error: auditErrorLabel(err),
    });
    return false;
  }
}

// Audit warn lines log the error code/name only, never the raw message, so a
// driver/db error string can never smuggle payload or credential text into
// logs.
function auditErrorLabel(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "unknown_error";
}

function maybeCleanupAuditLog(
  deps: McpAuditDeps,
  config: McpAuditConfig,
  state: McpAuditState,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))().getTime();
  if (now - state.lastCleanupAt < config.cleanupIntervalMs) return Promise.resolve();
  // Single-flight: detached triggers can race within the interval before
  // lastCleanupAt advances; only one DELETE may run at a time. A failed
  // cleanup does not advance the clock, so it is retried on a later write.
  if (state.cleanupInFlight) return Promise.resolve();
  state.cleanupInFlight = true;
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
        error: auditErrorLabel(err),
      });
    })
    .finally(() => {
      state.cleanupInFlight = false;
    });
}
