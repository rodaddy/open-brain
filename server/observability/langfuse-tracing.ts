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
 * SDK v4 (OTel-based), per the operator decision recorded on #530 on
 * 2026-08-03. This lane previously shipped on the `langfuse` v3 package, which
 * is a bespoke queue plus HTTP client; both failures review measured — an
 * unbounded shutdown drain and unbounded memory growth while the endpoint was
 * down — are properties of that queue. v4 is an OpenTelemetry `SpanProcessor`
 * instead: the queue is `BatchSpanProcessor`'s, which drops rather than growing
 * once it is full, and the drain is `forceFlush()`/`shutdown()` with a real
 * timeout knob. The Python capture sink
 * (`python/openbrain/src/openbrain/apps/capture/langfuse_emitter.py`) already
 * runs on Python SDK v4, so both lanes now speak one API family —
 * `startObservation` and trace attributes, rather than v3's `trace()` body.
 *
 * SERVER COMPATIBILITY IS AT THE INGESTION LAYER, and it is verified rather
 * than assumed. The v4 processor POSTs OTLP-HTTP to
 * `${baseUrl}/api/public/otel/v1/traces`. Against the self-hosted server,
 * `/api/public/health` reports `{"status":"OK","version":"3.173.0"}`; that OTLP
 * path answers 401 unauthenticated while a sibling bogus path answers 404, so
 * the route exists and is auth-gated; and an authenticated probe span sent
 * through this exact SDK came back from `/api/public/traces` with its name,
 * `userId`, `sessionId`, tags, and one observation intact. Langfuse server v3
 * and JS SDK v4 are separate version lines, not a mismatch: the server has
 * carried the OTel ingestion route since v3.
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
 *
 * OUTAGE BEHAVIOUR IS STATE-CHANGE-ONLY, in the operator's words on #530:
 * Langfuse is "an extremely super important, nice to have. It shouldn't stop
 * things from running, but it should continue loudly." Losing an outage
 * window's traces is ACCEPTED — there is no disk spool and no replay lane, and
 * Postgres audit plus capture remain the system of record. What an outage must
 * not be is silent. So exactly two lines are emitted per outage: one when the
 * sink transitions to unreachable, one when it recovers, carrying the count
 * dropped during that window. Never per call — "if you do that every time,
 * you're going to spend most of your time saying hey hey this isn't working."
 */
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  setLangfuseTracerProvider,
  startObservation,
} from "@langfuse/tracing";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "../../src/types.ts";
import { logger } from "../../src/logger.ts";

/** Tags on every trace this lane writes, so server traffic is filterable. */
const TRACE_TAGS = ["open-brain-server", "mcp-tool"] as const;

const tracingInstalledServers = new WeakSet<McpServer>();

export type McpTraceStatus = "success" | "error" | "exception";

/**
 * Deadline for the whole drain on the way down.
 *
 * Belt AND braces, because each alone has been observed to fail. The processor
 * is handed an export timeout so the SDK bounds its own HTTP attempt, and the
 * awaited drain is ALSO raced against this deadline — a promise that never
 * settles ignores every config knob, which is exactly what the v3 lane did
 * (measured 28.0 s against an unreachable endpoint with one queued event).
 * launchd's default `ExitTimeOut` is 20 s, so an unbounded await turns a clean
 * drain into SIGKILL and takes `database.close()` with it. 2.5 s sits well
 * inside that and far above a reachable server's millisecond flush.
 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2500;

/**
 * Export timeout handed to the processor, in SECONDS — the SDK's unit for
 * `LangfuseSpanProcessorParams.timeout`, which it documents as seconds with a
 * default of 5. Kept below the shutdown deadline above so the SDK's own attempt
 * gives up first and the race stays a backstop rather than the normal path.
 */
const SINK_EXPORT_TIMEOUT_SECONDS = 2;

export interface McpTracingConfig {
  enabled: boolean;
  endpoint: string;
  publicKey: string;
  secretKey: string;
}

/** The content-ful trace payload for one tool call. */
export interface TraceBody {
  name: string;
  input: unknown;
  output: unknown;
  tags: string[];
  metadata: Record<string, unknown>;
  sessionId?: string;
  userId?: string;
}

/**
 * The minimum of the tracing surface this module uses.
 *
 * Declared structurally rather than importing the SDK's classes so a test can
 * inject a fake sink without a provider, a socket, or OTel global state (and so
 * a future SDK-major swap stays a one-file change). `emit` is the whole
 * request-path contract: hand it a built trace body, it returns nothing, and it
 * must not block.
 */
export interface TracingSink {
  emit(body: TraceBody): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface McpTracingDeps {
  config?: McpTracingConfig;
  /**
   * An already-built sink to share.
   *
   * The composition root builds ONE sink for the process and passes it to
   * every per-session install: the sink owns a background flush timer and a
   * bounded queue, so one per MCP session would multiply both by the session
   * count and leave each with its own unflushed tail at shutdown. When this is
   * set the install never constructs anything, and `shutdown()` is a no-op
   * because the OWNER of a shared sink drains it (see `startServer`).
   */
  sink?: TracingSink;
  /**
   * Sink factory, used only when `sink` is absent. Injectable for the same
   * reason `McpAuditDeps.now` is: the tests need a deterministic seam that
   * never opens a socket.
   */
  createSink?: (config: McpTracingConfig) => TracingSink;
  /**
   * Deadline for the shutdown drain, in milliseconds.
   *
   * Injectable so a test can prove the bound holds against a sink that never
   * resolves without waiting the real deadline for it.
   */
  shutdownTimeoutMs?: number;
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
}): TraceBody {
  return {
    name: input.toolName,
    input: input.args,
    output: input.output,
    tags: [...TRACE_TAGS],
    metadata: {
      caller_role: input.auth?.role ?? null,
      caller_client_id: input.auth?.clientId ?? null,
      // The audit lane records BOTH ids (`src/audit-log.ts:299-301`), and the
      // pair is the whole answer to "who actually did this" when a delegated
      // call's `clientId` differs from its token-derived identity. The
      // content-ful lane is the one an operator reads for that question, so
      // dropping the token id here would make the two lanes disagree in
      // exactly the case a security review cares about.
      caller_token_client_id: input.auth?.tokenClientId ?? null,
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
 * Outage state for one sink, and the only thing that decides whether a line
 * is logged.
 *
 * The #530 rule is state-change-only, so this tracker's whole job is to turn a
 * stream of per-call outcomes into at most two lines per outage. `healthy` is
 * the edge detector; `dropped` counts the window and resets on recovery, so
 * each recovery line reports ITS window rather than a running total.
 *
 * Exported because the tests assert the counting rule directly, without
 * needing a real outage to produce it.
 */
export class SinkHealthTracker {
  private healthy = true;
  private dropped = 0;

  /**
   * Record a failed emit or export. Returns true ONLY on the transition into
   * an outage, so the caller logs the suspend line exactly once per window.
   */
  recordFailure(): boolean {
    this.dropped += 1;
    if (!this.healthy) return false;
    this.healthy = false;
    return true;
  }

  /**
   * Record a success. Returns the number of traces dropped during the window
   * that just ended, or undefined when nothing changed — so a healthy sink
   * emits nothing at all on the happy path.
   */
  recordSuccess(): number | undefined {
    if (this.healthy) return undefined;
    const dropped = this.dropped;
    this.healthy = true;
    this.dropped = 0;
    return dropped;
  }

  /** Traces dropped in the current window; 0 while healthy. */
  get droppedInWindow(): number {
    return this.dropped;
  }

  get isHealthy(): boolean {
    return this.healthy;
  }
}

/**
 * Emit the suspend line, and only on the transition.
 *
 * Content-free on purpose: this is a local log line about transport health,
 * not a trace, so it carries an error LABEL (code/name) and nothing else.
 */
export function reportSinkFailure(
  tracker: SinkHealthTracker,
  err: unknown,
): void {
  if (!tracker.recordFailure()) return;
  logger.warn("mcp_tool_tracing_suspended", { error: tracingErrorLabel(err) });
}

/** Emit the recovery line with the window's drop count, and only on the edge. */
export function reportSinkSuccess(tracker: SinkHealthTracker): void {
  const dropped = tracker.recordSuccess();
  if (dropped === undefined) return;
  logger.info("mcp_tool_tracing_resumed", { droppedTraces: dropped });
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

  // A tracker of its own ONLY when this install owns the sink. A shared sink's
  // health belongs to the runtime that built it, and two trackers over one sink
  // would report the same outage twice.
  const tracker = shared ? undefined : new SinkHealthTracker();

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
        emitTrace(sink, tracker, {
          toolName: name,
          status: isToolError(result) ? "error" : "success",
          durationMs: Date.now() - started,
          args,
          output: result,
          ...authAndSession(args, extra),
        });
        return result;
      } catch (err: unknown) {
        emitTrace(sink, tracker, {
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
    shutdown: () =>
      shared ? Promise.resolve() : shutdownSink(sink, deps.shutdownTimeoutMs),
  };
}

/**
 * Build the process's single shared tracing sink, or nothing.
 *
 * The composition root's entry point: it decides ONCE whether this process
 * traces, and hands the resulting sink to every per-session install. Returns
 * `undefined` when tracing is off or the sink could not be constructed, which
 * makes every downstream install a no-op without any caller branching on
 * config.
 *
 * ONE runtime per PROCESS, not per MCP session: `createServerFactory` runs per
 * session (`server/session-manager.ts:273`), so a provider plus batch queue per
 * session would multiply the background timers and the memory bound by the
 * session count.
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
  return {
    config,
    sink,
    shutdown: () => shutdownSink(sink, deps.shutdownTimeoutMs),
  };
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
 * NOTHING is awaited: `emit` starts and ends an OTel span, which the batch
 * processor queues in memory and exports on its own background interval, so the
 * request path pays a synchronous enqueue and nothing more. The try/catch is
 * the best-effort contract in one statement — a sink that throws on every
 * method leaves the tool result untouched.
 *
 * The health tracker is UPDATED here but the decision to log lives in
 * `reportSink*`, which fires only on a state change. A per-call warn is exactly
 * what #530 forbids.
 */
function emitTrace(
  sink: TracingSink,
  tracker: SinkHealthTracker | undefined,
  input: Parameters<typeof buildToolTraceBody>[0],
): void {
  try {
    sink.emit(buildToolTraceBody(input));
    if (tracker) reportSinkSuccess(tracker);
  } catch (err: unknown) {
    if (tracker) reportSinkFailure(tracker, err);
  }
}

/**
 * Build the sink, or degrade to no tracing.
 *
 * A constructor that throws (bad URL, missing runtime dependency) must not take
 * the server down with it: the lane is diagnostic, and a diagnostic that can
 * fail a boot is worse than no diagnostic.
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
 * The real sink: a Langfuse span processor on an ISOLATED tracer provider.
 *
 * `setLangfuseTracerProvider` is the SDK's own isolation seam, and it is not
 * the OTel global: the SDK documents `getLangfuseTracerProvider` as returning
 * the isolated provider when one has been set and falling back to the global
 * otherwise. Registering here therefore routes THIS lane's spans to THIS
 * processor without touching, or being touched by, any other instrumentation
 * in the process. `startObservation` accepts no per-call provider argument
 * (verified against `StartObservationOpts`, which carries only `startTime`,
 * `parentSpanContext`, and `asType`), so this registration is the supported
 * way to bind the two.
 *
 * The OTel batch processor's existing queue is the holding area, per the #530
 * decision to use it as-is and accept its drop behaviour. The export timeout is
 * short (`SINK_EXPORT_TIMEOUT_SECONDS`) so the lane never waits on a dead
 * socket. Together they are the outage contract: during an outage the brain
 * neither slows nor grows, and the window's traces are simply lost.
 */
function defaultSinkFactory(config: McpTracingConfig): TracingSink {
  const processor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.endpoint,
    timeout: SINK_EXPORT_TIMEOUT_SECONDS,
    exportMode: "batched",
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  setLangfuseTracerProvider(provider);
  const tracker = new SinkHealthTracker();
  return {
    emit(body: TraceBody): void {
      // The span ends immediately: the tool call already happened, so this is a
      // record of it rather than a live scope.
      const span = startObservation(body.name, {
        input: body.input,
        output: body.output,
        metadata: body.metadata,
      });
      span.updateTrace({
        name: body.name,
        tags: body.tags,
        ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
        ...(body.userId === undefined ? {} : { userId: body.userId }),
      });
      span.end();
    },
    async forceFlush(): Promise<void> {
      // The export is where an outage becomes observable — an enqueue cannot
      // fail against a dead endpoint, only a flush can. That is why the health
      // lines live on the drain path and not only on `emit`.
      try {
        await processor.forceFlush();
        reportSinkSuccess(tracker);
      } catch (err: unknown) {
        reportSinkFailure(tracker, err);
      }
    },
    shutdown(): Promise<void> {
      return processor.shutdown();
    },
  };
}

/**
 * Flush on the way down.
 *
 * This is the ONE place tracing awaits anything, and it is off the request path
 * by construction: without it the in-memory batch from the last seconds of the
 * process is dropped, which is exactly the window an operator debugging a crash
 * cares about. A flush failure is logged, never rethrown — a tracing problem
 * must not make a clean shutdown read as a dirty one.
 *
 * The whole drain runs against a deadline, because a hung socket produces a
 * promise that never settles and no SDK timeout setting can be trusted to cover
 * every path (the v3 lane was MEASURED at 28.0 s, past launchd's 20 s
 * `ExitTimeOut`; the process was SIGKILLed and everything after this call —
 * including `database.close()` — never ran). Waiting is what has to stop, not
 * the diagnostics: a reachable Langfuse drains in milliseconds and never
 * touches the deadline.
 */
async function shutdownSink(
  sink: TracingSink,
  timeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const outcome = await withDeadline(drainSink(sink), timeoutMs);
  if (outcome === "timeout") {
    // Content-free: the deadline itself, never a payload, a key, or a
    // transport error message.
    logger.warn("mcp_tool_tracing_shutdown_timeout", { timeoutMs });
  }
}

/** The drain pair, each failure logged content-free and never rethrown. */
async function drainSink(sink: TracingSink): Promise<void> {
  try {
    await sink.forceFlush();
  } catch (err: unknown) {
    logger.warn("mcp_tool_tracing_flush_failed", {
      error: tracingErrorLabel(err),
    });
  }
  try {
    await sink.shutdown();
  } catch (err: unknown) {
    logger.warn("mcp_tool_tracing_shutdown_failed", {
      error: tracingErrorLabel(err),
    });
  }
}

/**
 * Resolve when `work` settles or the deadline passes, whichever is first.
 *
 * Same shape as the audit lane's bounded write (`src/audit-log.ts:453-455`).
 * The timer is cleared on the fast path so a bounded drain never holds the
 * event loop open past its own completion, and `work` is left running: it is
 * fire-and-forget by contract, and abandoning the wait is the entire point.
 */
async function withDeadline(
  work: Promise<void>,
  timeoutMs: number,
): Promise<"settled" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([
    work.then(() => "settled" as const),
    timed,
  ]);
  if (timer) clearTimeout(timer);
  return outcome;
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

/** Test-visible constants, so a test asserts the real value and not a copy. */
export const TRACING_INTERNALS = {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  SINK_EXPORT_TIMEOUT_SECONDS,
} as const;
