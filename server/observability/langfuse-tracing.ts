/**
 * CONTENT-FUL Langfuse tracing for every MCP tool call served by this server.
 *
 * Design authority: issue #530, which explicitly supersedes #372's content-free
 * spec for the local dogfood deployment. The operator's requirement is to see
 * "what agents are literally trying to do, what the calls are, what they're
 * getting back" — so arguments and results travel VERBATIM. There is no
 * redaction here, and adding some would defeat the only reason the lane exists.
 *
 * THIS IS A SECOND, SEPARATE LANE. `src/audit-log.ts` stays exactly as it is:
 * it is the content-FREE durable audit record (declared key names, unknown-key
 * counts, size buckets — never a payload), and it writes to Postgres. This
 * module writes payloads to an operator-run Langfuse server, off by default,
 * and persists nothing locally. Neither replaces the other; both wrappers are
 * installed on the same `McpServer` in `server/main.ts`.
 *
 * THE SEAM IS DELIBERATELY THE SAME SHAPE AS `installMcpAudit`
 * (`src/audit-log.ts:309-408`): wrap `server.registerTool`, so every tool
 * handler is instrumented by construction rather than by 65 call sites
 * remembering to. Same WeakSet install-once guard, same `isToolError` result
 * check, same `(extra).authInfo` auth source. Wrapping composes: whichever
 * wrapper is installed last is outermost, and both see the same args, result,
 * and thrown error.
 *
 * BEST-EFFORT IS THE HARD REQUIREMENT. A tracing failure must never fail,
 * slow, or alter a tool call. Every SDK interaction is fire-and-forget — no
 * `await` in the request path, ever — and every tracing statement is wrapped so
 * a throw is caught and logged CONTENT-FREE (error code/name only, never the
 * message, so a transport error string can never smuggle payload or key text
 * into the local logs). The tool's own result object is returned by identity,
 * untouched.
 */
import { Langfuse } from "langfuse";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "../../src/types.ts";
import { logger } from "../../src/logger.ts";

/** Tags on every trace this lane writes, so server traffic is filterable. */
const TRACE_TAGS = ["open-brain-server", "mcp-tool"] as const;

const tracingInstalledServers = new WeakSet<McpServer>();

export type McpTraceStatus = "success" | "error" | "exception";

export interface McpTracingConfig {
  enabled: boolean;
  endpoint: string;
  publicKey: string;
  secretKey: string;
}

/**
 * The minimum of the Langfuse client surface this module uses.
 *
 * Declared structurally rather than importing the SDK's class type so a test
 * can inject a fake sink without constructing a real client (and so a future
 * SDK-major swap is a one-file change). The real `langfuse` v3 `Langfuse`
 * class satisfies it.
 */
export interface TracingSink {
  trace(body: Record<string, unknown>): unknown;
  flushAsync(): Promise<void>;
  shutdownAsync(): Promise<void>;
}

export interface McpTracingDeps {
  config?: McpTracingConfig;
  /**
   * An already-built client to share.
   *
   * The composition root builds ONE client for the process and passes it to
   * every per-session install: the SDK client owns a background flush timer and
   * an in-memory queue, so one per MCP session would multiply both by the
   * session count and leave each with its own unflushed tail at shutdown. When
   * this is set the install never constructs anything, and `shutdown()` is a
   * no-op because the OWNER of a shared sink drains it (see `startServer`).
   */
  sink?: TracingSink;
  /**
   * Client factory, used only when `sink` is absent. Injectable for the same
   * reason `McpAuditDeps.now` is: the tests need a deterministic seam that
   * never opens a socket.
   */
  createSink?: (config: McpTracingConfig) => TracingSink;
}

/** Shutdown handle returned by `installMcpTracing`, wired into the stop path. */
export interface McpTracingHandle {
  /** True when a sink was actually built and tool calls are being traced. */
  readonly active: boolean;
  /** Flush pending events and stop the SDK's background machinery. */
  shutdown(): Promise<void>;
}

/** A no-op handle, returned whenever tracing is off or already installed. */
const INACTIVE_HANDLE: McpTracingHandle = {
  active: false,
  shutdown: () => Promise.resolve(),
};

type RegisterTool = McpServer["registerTool"];

/**
 * Resolve tracing configuration from the environment.
 *
 * Mirrors `readMcpAuditConfig` (`src/audit-log.ts:134-158`), with the opposite
 * default: audit is on unless disabled, tracing is OFF unless every coordinate
 * is present. A payload-carrying export to an external server is opt-in per
 * deployment, never something a missing variable turns on by accident.
 *
 * The incomplete-flag case warns exactly once at install, content-free: the
 * operator who set the flag and mistyped one variable would otherwise get a
 * silent zero, which is the failure mode this whole file exists to remove.
 * Key VALUES are never logged — only whether each one was present.
 */
export function readMcpTracingConfig(
  env: Record<string, string | undefined> = process.env,
): McpTracingConfig {
  const endpoint = env.OPENBRAIN_TRACING_ENDPOINT?.trim() ?? "";
  const publicKey = env.OPENBRAIN_TRACING_PUBLIC_KEY?.trim() ?? "";
  const secretKey = env.OPENBRAIN_TRACING_SECRET_KEY?.trim() ?? "";
  const flagged = env.OPENBRAIN_TRACING_ENABLED === "1";
  const complete =
    endpoint.length > 0 && publicKey.length > 0 && secretKey.length > 0;
  if (flagged && !complete) {
    // Field names deliberately avoid every substring in
    // `SENSITIVE_KEY_PARTS` (`src/secret-patterns.ts:160-173` — `secret`,
    // `apikey`, `credential`, `privatekey`, ...). A field named `hasSecretKey`
    // is rewritten to "[REDACTED]" by the shared logger, which turns the one
    // line telling an operator WHICH variable they mistyped into noise. The
    // values are booleans by construction, so no key material can travel here
    // regardless of the name.
    logger.warn("mcp_tool_tracing_config_incomplete", {
      endpointSet: endpoint.length > 0,
      publicIdSet: publicKey.length > 0,
      privateIdSet: secretKey.length > 0,
    });
  }
  return { enabled: flagged && complete, endpoint, publicKey, secretKey };
}

/**
 * The Langfuse session this call belongs to, or undefined.
 *
 * Preference order is deliberate: a `session_key` in the arguments is the
 * BRAIN's own session identity, which is what makes an agent's whole
 * conversation with the brain read as one Langfuse timeline next to the
 * client-side traces the #523 sink already ships. The MCP transport's
 * `sessionId` is a per-connection fallback — real, but a different grain.
 */
export function resolveSessionId(
  args: unknown,
  extra: unknown,
): string | undefined {
  const fromArgs =
    readStringField(args, "session_key") ??
    readStringField(readField(args, "scope"), "session_key");
  if (fromArgs !== undefined) return fromArgs;
  return readStringField(extra, "sessionId");
}

function readField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function readStringField(value: unknown, key: string): string | undefined {
  const field = readField(value, key);
  if (typeof field !== "string" || field.length === 0) return undefined;
  return field;
}

/**
 * The trace body for one tool call, content-ful by design (see file header).
 *
 * Exported so the shape is assertable without an SDK, a server, or a socket.
 */
export function buildToolTraceBody(input: {
  toolName: string;
  status: McpTraceStatus;
  durationMs: number;
  args: unknown;
  output: unknown;
  auth?: AuthInfo;
  sessionId?: string;
}): Record<string, unknown> {
  return {
    name: input.toolName,
    input: input.args,
    output: input.output,
    tags: [...TRACE_TAGS],
    metadata: {
      caller_role: input.auth?.role ?? null,
      caller_client_id: input.auth?.clientId ?? null,
      caller_agent_id: input.auth?.agentId ?? null,
      namespace_source: input.auth?.namespaceSource ?? null,
      duration_ms: Number.isFinite(input.durationMs)
        ? Math.max(0, Math.round(input.durationMs))
        : 0,
      status: input.status,
    },
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.auth?.clientId === undefined
      ? {}
      : { userId: input.auth.clientId }),
  };
}

/**
 * The output field for a call that threw: class and message, nothing else.
 *
 * Content-FUL like the rest of this lane — the operator's stated requirement is
 * to see WHY a call failed — so the message travels in full. That is the whole
 * difference from `tracingErrorLabel`, which labels tracing's OWN failures for
 * the local log and is deliberately content-free.
 */
export function errorOutput(err: unknown): Record<string, string> {
  if (err instanceof Error) {
    return { error_class: err.name, error_message: err.message };
  }
  return { error_class: errorClassOf(err), error_message: String(err) };
}

/** The best available class name for a non-`Error` throw. */
function errorClassOf(err: unknown): string {
  if (typeof err !== "object" || err === null) return typeof err;
  return err.constructor?.name ?? "Object";
}

/**
 * Install content-ful tracing on every tool registered after this call.
 *
 * ORDER MATTERS, exactly as it does for `installMcpAudit`: this works by
 * wrapping `registerTool`, so a tool registered BEFORE the wrapper is a tool
 * whose calls are never traced. Call it in the server factory before
 * `registerMemoryTools`.
 *
 * Returns a handle whose `shutdown()` flushes the batch — EXCEPT when the sink
 * was passed in via `deps.sink`, in which case draining belongs to whoever owns
 * it and `shutdown()` is a no-op. Disabled config returns the inactive handle
 * and leaves `registerTool` byte-untouched — no wrapper, no cost, no behaviour
 * change.
 */
export function installMcpTracing(
  server: McpServer,
  deps: McpTracingDeps = {},
): McpTracingHandle {
  const config = deps.config ?? readMcpTracingConfig();
  if (!config.enabled) return INACTIVE_HANDLE;
  if (tracingInstalledServers.has(server)) return INACTIVE_HANDLE;

  const shared = deps.sink !== undefined;
  const sink = deps.sink ?? createSinkSafely(config, deps.createSink);
  if (!sink) return INACTIVE_HANDLE;
  tracingInstalledServers.add(server);

  const original = server.registerTool.bind(server) as RegisterTool;
  server.registerTool = ((
    name: string,
    configOrDescription: unknown,
    cb?: unknown,
  ) => {
    if (typeof cb !== "function") {
      return (original as unknown as (...a: unknown[]) => unknown)(
        name,
        configOrDescription,
        cb,
      );
    }
    const callback = cb as (args: unknown, extra: unknown) => unknown;
    const wrapped = async (args: unknown, extra: unknown) => {
      const started = Date.now();
      try {
        const result = await callback(args, extra);
        emitTrace(sink, {
          toolName: name,
          status: isToolError(result) ? "error" : "success",
          durationMs: Date.now() - started,
          args,
          output: result,
          ...authAndSession(args, extra),
        });
        return result;
      } catch (err: unknown) {
        emitTrace(sink, {
          toolName: name,
          status: "exception",
          durationMs: Date.now() - started,
          args,
          output: errorOutput(err),
          ...authAndSession(args, extra),
        });
        // The caller's error is the one that matters; tracing never changes it.
        throw err;
      }
    };
    return (original as unknown as (...a: unknown[]) => unknown)(
      name,
      configOrDescription,
      wrapped,
    );
  }) as RegisterTool;

  return {
    active: true,
    shutdown: () => (shared ? Promise.resolve() : shutdownSink(sink)),
  };
}

/**
 * Build the process's single shared tracing sink, or nothing.
 *
 * The composition root's entry point: it decides ONCE whether this process
 * traces, and hands the resulting sink to every per-session install. Returns
 * `undefined` when tracing is off or the client could not be constructed, which
 * makes every downstream install a no-op without any caller branching on
 * config.
 */
export function createTracingRuntime(deps: McpTracingDeps = {}): {
  readonly config: McpTracingConfig;
  readonly sink?: TracingSink;
  shutdown(): Promise<void>;
} {
  const config = deps.config ?? readMcpTracingConfig();
  if (!config.enabled) return { config, shutdown: () => Promise.resolve() };
  const sink = deps.sink ?? createSinkSafely(config, deps.createSink);
  if (!sink) return { config, shutdown: () => Promise.resolve() };
  return { config, sink, shutdown: () => shutdownSink(sink) };
}

function authAndSession(
  args: unknown,
  extra: unknown,
): { auth?: AuthInfo; sessionId?: string } {
  const auth = (extra as { authInfo?: AuthInfo } | undefined)?.authInfo;
  const sessionId = resolveSessionId(args, extra);
  return {
    ...(auth === undefined ? {} : { auth }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

/**
 * Send one trace, fire-and-forget.
 *
 * NOTHING is awaited: the SDK queues in memory and flushes on its own
 * background interval, so the request path pays a synchronous enqueue and
 * nothing more. The try/catch is the best-effort contract in one statement —
 * a sink that throws on every method leaves the tool result untouched.
 */
function emitTrace(
  sink: TracingSink,
  input: Parameters<typeof buildToolTraceBody>[0],
): void {
  try {
    sink.trace(buildToolTraceBody(input));
  } catch (err: unknown) {
    logger.warn("mcp_tool_trace_emit_failed", {
      operation: input.toolName,
      status: input.status,
      error: tracingErrorLabel(err),
    });
  }
}

/**
 * Build the client, or degrade to no tracing.
 *
 * A constructor that throws (bad URL, missing runtime dependency) must not
 * take the server down with it: the lane is diagnostic, and a diagnostic that
 * can fail a boot is worse than no diagnostic.
 */
function createSinkSafely(
  config: McpTracingConfig,
  factory: McpTracingDeps["createSink"],
): TracingSink | undefined {
  try {
    return (factory ?? defaultSinkFactory)(config);
  } catch (err: unknown) {
    logger.warn("mcp_tool_tracing_sink_init_failed", {
      error: tracingErrorLabel(err),
    });
    return undefined;
  }
}

/**
 * The real client.
 *
 * The SDK's `Langfuse` class satisfies `TracingSink` structurally: `trace()`
 * takes an optional body and returns a trace client, and `flushAsync` /
 * `shutdownAsync` are the v3 drain pair. Reached only when config is complete;
 * the tests inject a fake and never construct one.
 *
 * `flushAt`/`flushInterval` are left at SDK defaults deliberately — batching is
 * what keeps the request path free of network work, and tuning it is an
 * operator concern, not a code one.
 */
function defaultSinkFactory(config: McpTracingConfig): TracingSink {
  return new Langfuse({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.endpoint,
  });
}

/**
 * Flush on the way down.
 *
 * This is the ONE place tracing awaits anything, and it is off the request
 * path by construction: without it the in-memory batch from the last seconds
 * of the process is dropped, which is exactly the window an operator debugging
 * a crash cares about. A flush failure is logged, never rethrown — a tracing
 * problem must not make a clean shutdown read as a dirty one.
 */
async function shutdownSink(sink: TracingSink): Promise<void> {
  try {
    await sink.flushAsync();
  } catch (err: unknown) {
    logger.warn("mcp_tool_tracing_flush_failed", {
      error: tracingErrorLabel(err),
    });
  }
  try {
    await sink.shutdownAsync();
  } catch (err: unknown) {
    logger.warn("mcp_tool_tracing_shutdown_failed", {
      error: tracingErrorLabel(err),
    });
  }
}

function isToolError(result: unknown): boolean {
  return Boolean(
    result &&
      typeof result === "object" &&
      (result as { isError?: unknown }).isError === true,
  );
}

/**
 * Content-free error label for tracing warn lines.
 *
 * Copied in spirit from `auditErrorLabel` (`src/audit-log.ts:526-534`) and for
 * the same reason: an SDK/transport error message can contain the endpoint, a
 * request body, or an auth header, and these warns go to the local log. Only
 * the code/name is ever emitted.
 */
function tracingErrorLabel(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "unknown_error";
}
