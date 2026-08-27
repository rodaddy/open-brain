/**
 * CONTENT-FUL Langfuse tracing for every MCP tool call served by this server.
 *
 * Design authority: issue #530, which explicitly supersedes #372's content-free
 * spec for the local dogfood deployment, plus #561's masking-before-widening
 * ruling. The operator still receives every field and its surrounding content,
 * but credential-shaped spans are replaced at this final emitter boundary before
 * any payload reaches Langfuse. Masking is replacement, never field removal.
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
 * wrapper is installed last is outermost. In `createServerFactory` the audit
 * lane installs first and tracing second (`server/main.ts:158` then `:162`), so
 * TRACING is the outer wrapper and audit the inner one. Either way both see the
 * same args, result, and thrown error, which is why the order is not
 * load-bearing for correctness.
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
 *
 * HEALTH BELONGS TO THE SINK, NOT TO AN INSTALL, and that distinction is the
 * whole of whether any of the above actually happens. The composition root
 * builds ONE sink and passes it to every per-session install, so a tracker
 * created per install is a tracker the production path never has: the first
 * version of this lane created one only when the install OWNED the sink, which
 * made the shared path — the only path `server/main.ts` takes — count every
 * failure into `undefined` and log nothing. Measured: zero suspend and zero
 * recovery lines across a 500-call outage. The tracker now hangs off
 * `TracingSink.health`, so both paths report identically by construction.
 *
 * AN OUTAGE IS DETECTED WHERE IT ACTUALLY SURFACES, which is not `emit`. An
 * enqueue onto the batch queue succeeds whether or not anything is listening;
 * only the background EXPORT fails. OTel reports that failure through the
 * global error handler and reports success nowhere, so the down edge is a
 * `setGlobalErrorHandler` hook and the up edge is a probe that re-flushes only
 * while already known-unhealthy. Before both, an outage was invisible until
 * shutdown flush — the SDK's own error line is silenced here on purpose (see
 * `defaultSinkFactory`), so nothing else was left to say it.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { maskTraceValue } from "./trace-masking.ts";
import { buildToolTraceBody, errorOutput } from "./trace-body.ts";
export { readMcpTracingConfig, resolveSessionId } from "./trace-config.ts";
import { resolveSessionId } from "./trace-config.ts";
import { tracingErrorLabel } from "./trace-error-label.ts";
import {
  DEFAULT_FLAP_COOLDOWN_MS,
  reportSinkFailure,
  reportSinkSuccess,
  SinkHealthTracker,
} from "./trace-sink-health.ts";
import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  defaultSinkFactory,
  shutdownSink,
  SINK_EXPORT_TIMEOUT_SECONDS,
  SINK_HEALTH_PROBE_MS,
} from "./trace-sink.ts";
import type {
  McpTracingConfig,
  McpTracingDeps,
  McpTracingHandle,
  TraceBody,
  TraceSpanBody,
  TracingLogger,
  TracingSink,
} from "./trace-types.ts";
export type { McpTraceStatus, TracingLogger } from "./trace-types.ts";
export {
  buildToolTraceBody,
  errorOutput,
  type ToolTraceBodyInput,
} from "./trace-body.ts";
export { emitTraceBodyWithObservations } from "./trace-sink.ts";
import type {
  BackgroundObservation,
  BackgroundTraceBody,
  BackgroundTraceEmitter,
} from "../../src/background-tracing.ts";
import type { AuthInfo } from "../types.ts";

/**
 * Re-exported so this module stays the single import surface for the tracing
 * lane. The extractions below are about file size and testability, not about
 * asking every caller and test to learn four new paths.
 */
export {
  reportSinkFailure,
  reportSinkSuccess,
  SinkHealthTracker,
} from "./trace-sink-health.ts";
export {
  readRuntimeDeployStamp,
  repoRelease,
  resolveRepoRelease,
} from "./trace-release.ts";
export type {
  McpTracingConfig,
  McpTracingDeps,
  McpTracingHandle,
  TraceBody,
  TraceSpanBody,
  TracingSink,
} from "./trace-types.ts";

const tracingInstalledServers = new WeakSet<McpServer>();

/**
 * Emergency circuit breaker for pathological payloads such as the issue #604
 * transcript-dump class. Per the operator ruling, a healthy corpus must never
 * reach this branch; ordinary retrieval evidence flows in full.
 */
export const MAX_ACTIVE_SPAN_BYTES = 256 * 1024;

/** A no-op handle, returned whenever tracing is off or already installed. */
const INACTIVE_HANDLE: McpTracingHandle = {
  active: false,
  shutdown: () => Promise.resolve(),
};

interface ActiveMcpTrace {
  readonly spans: TraceSpanBody[];
  readonly metadata: Record<string, unknown>;
  spanBytes: number;
  payloadDegraded: boolean;
  /**
   * The logger `installMcpTracing` received, carried on the call's own context.
   *
   * `traceRetrievalSpan` and its sync twin are called from deep inside tool
   * handlers that hold no tracing deps, so there is no parameter to thread one
   * through. They already read this store to decide whether a trace is active
   * at all, which makes it the seam that reaches them: the root's logger is
   * placed here once per traced call, by the install that owns the deps.
   */
  readonly logger: TracingLogger;
}

const activeMcpTrace = new AsyncLocalStorage<ActiveMcpTrace>();

/** Add trace-level metadata from inside the currently executing tool handler. */
export function setActiveMcpTraceMetadata(
  metadata: Record<string, unknown>,
): void {
  const active = activeMcpTrace.getStore();
  if (!active) return;
  Object.assign(active.metadata, metadata);
}

function traceValueCounts(value: unknown): Record<string, number> {
  const counts = {
    values: 0,
    arrays: 0,
    objects: 0,
    strings: 0,
    string_bytes: 0,
  };
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    counts.values += 1;
    if (typeof current === "string") {
      counts.strings += 1;
      counts.string_bytes += Buffer.byteLength(current, "utf8");
      continue;
    }
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) counts.arrays += 1;
    else counts.objects += 1;
    pending.push(...Object.values(current));
  }
  return counts;
}

function degradedTraceSpan(
  span: TraceSpanBody,
  reason: "active_span_bytes_limit" | "serialization_error",
): TraceSpanBody {
  return {
    name: span.name,
    input: { counts: traceValueCounts(span.input) },
    output: { counts: traceValueCounts(span.output) },
    metadata: {
      ...span.metadata,
      payload_degraded: true,
      payload_degradation_reason: reason,
      payload_limit_bytes: MAX_ACTIVE_SPAN_BYTES,
    },
  };
}

function appendDegradedSpan(
  active: ActiveMcpTrace,
  span: TraceSpanBody,
  reason: "active_span_bytes_limit" | "serialization_error",
): void {
  const degraded = degradedTraceSpan(span, reason);
  const bytes = Buffer.byteLength(JSON.stringify(degraded), "utf8");
  if (active.spanBytes + bytes <= MAX_ACTIVE_SPAN_BYTES) {
    active.spans.push(degraded);
    active.spanBytes += bytes;
    return;
  }
  const last = active.spans.at(-1);
  if (!last) return;
  const omitted = Number(last.metadata.additional_spans_omitted ?? 0);
  last.metadata.additional_spans_omitted = omitted + 1;
}

function recordTraceSpanUnsafe(
  name: string,
  input: unknown,
  output: unknown,
  metadata: Record<string, unknown>,
): void {
  const active = activeMcpTrace.getStore();
  if (!active) return;
  const span = { name, input, output, metadata };
  if (active.payloadDegraded) {
    appendDegradedSpan(active, span, "active_span_bytes_limit");
    return;
  }
  try {
    const spanBytes = Buffer.byteLength(JSON.stringify(span), "utf8");
    if (active.spanBytes + spanBytes <= MAX_ACTIVE_SPAN_BYTES) {
      active.spans.push(span);
      active.spanBytes += spanBytes;
      return;
    }
    const degraded = active.spans.map((recorded) =>
      degradedTraceSpan(recorded, "active_span_bytes_limit"),
    );
    degraded.push(degradedTraceSpan(span, "active_span_bytes_limit"));
    active.spans.splice(0, active.spans.length, ...degraded);
    active.spanBytes = Buffer.byteLength(JSON.stringify(degraded), "utf8");
    active.payloadDegraded = true;
  } catch (err: unknown) {
    active.logger.warn(
      { error: tracingErrorLabel(err), reason: "serialization_error" },
      "mcp_tool_trace_span_payload_degraded",
    );
    appendDegradedSpan(active, span, "serialization_error");
    active.payloadDegraded = true;
  }
}

function recordTraceSpan(
  name: string,
  input: unknown,
  output: unknown,
  metadata: Record<string, unknown>,
): void {
  try {
    recordTraceSpanUnsafe(name, input, output, metadata);
  } catch (err: unknown) {
    // Re-read rather than take a parameter: the callers of this function are
    // tool handlers with no tracing deps in scope, and the store is what
    // already tells them a trace is active.
    activeMcpTrace
      .getStore()
      ?.logger.warn(
        { error: tracingErrorLabel(err) },
        "mcp_tool_trace_span_collection_failed",
      );
  }
}

function traceSpanOutput<T>(
  summarize: ((result: T) => unknown) | undefined,
  result: T,
): unknown {
  if (!summarize) return result;
  try {
    return summarize(result);
  } catch (err: unknown) {
    return { instrumentation_error: tracingErrorLabel(err) };
  }
}

interface RetrievalSpanInput<T, R> {
  name: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  run: () => R;
  output?: (result: T) => unknown;
}

/**
 * Record one finished retrieval stage, success or throw.
 *
 * Shared by the async and sync entries below, which differed only in an
 * `await`: the span shape, the status values, and the duration arithmetic are
 * one behaviour and belong in one place.
 */
function recordRetrievalOutcome<T, R>(
  input: RetrievalSpanInput<T, R>,
  started: number,
  outcome:
    { status: "success"; result: T } | { status: "exception"; err: unknown },
): void {
  const output =
    outcome.status === "success"
      ? traceSpanOutput(input.output, outcome.result)
      : errorOutput(outcome.err);
  recordTraceSpan(input.name, input.input ?? null, output, {
    ...input.metadata,
    status: outcome.status,
    duration_ms: Math.max(0, Date.now() - started),
  });
}

/**
 * Run an asynchronous retrieval stage as a child of the active MCP tool trace.
 *
 * With tracing disabled there is no async-local trace context, so this calls the
 * operation directly and performs no masking, collection, or exporter work.
 */
export async function traceRetrievalSpan<T>(
  input: RetrievalSpanInput<T, Promise<T>>,
): Promise<T> {
  if (!activeMcpTrace.getStore()) return input.run();
  const started = Date.now();
  try {
    const result = await input.run();
    recordRetrievalOutcome(input, started, { status: "success", result });
    return result;
  } catch (err: unknown) {
    recordRetrievalOutcome(input, started, { status: "exception", err });
    throw err;
  }
}

/** Synchronous counterpart for ranking, filtering, and deterministic transforms. */
export function traceRetrievalSpanSync<T>(input: RetrievalSpanInput<T, T>): T {
  if (!activeMcpTrace.getStore()) return input.run();
  const started = Date.now();
  try {
    const result = input.run();
    recordRetrievalOutcome(input, started, { status: "success", result });
    return result;
  } catch (err: unknown) {
    recordRetrievalOutcome(input, started, { status: "exception", err });
    throw err;
  }
}

type RegisterTool = McpServer["registerTool"];

/**
 * The ONE place tracing configuration is resolved for this module.
 *
 * `installMcpTracing` and `createTracingRuntime` both need it, and each having
 * its own `deps.config ?? …` expression is two composition paths that can
 * disagree. The composition root (`server/main.ts`) passes `config.tracing`
 * from the single validated parse, so `deps.config` is the normal path there.
 *
 * There is no environment fallback here (#825, L2b-2). This module reads no
 * environment at all; a caller without a `ServerConfig` — the legacy root
 * `src/index.ts` and `scripts/run-nats-worker.ts` — calls
 * `readMcpTracingConfig` on its own environment record and passes the result,
 * so the one place the environment is named is the root that owns it. A
 * missing `deps.config` is a wiring mistake, so it fails at the call site
 * rather than silently resolving to a different configuration than the root
 * parsed.
 */
function resolveTracingConfig(deps: McpTracingDeps): McpTracingConfig {
  if (!deps.config) {
    throw new Error(
      "createTracingRuntime requires config from the composition root: pass { config } (server/main.ts uses config.tracing; a root without a ServerConfig passes readMcpTracingConfig on its own environment record)",
    );
  }
  return deps.config;
}

/**
 * The ONE place this lane's logger is resolved, and it is never defaulted.
 *
 * A fallback here would be a second logger for the process — its own transport,
 * its own destination, its own view of the correlation context — which is the
 * exact state #860 removes. #612 is the receipt for how quietly that fails: the
 * service logged into a void for as long as the server path existed, with no
 * error and no dropped-line counter. So a missing logger is a wiring mistake
 * and says so at the call site, rather than resolving to somewhere nobody
 * reads.
 */
function resolveTracingLogger(deps: McpTracingDeps): TracingLogger {
  if (!deps.logger) {
    throw new Error(
      "createTracingRuntime requires a logger from the composition root: pass { logger } (server/main.ts passes the logger it created; a root without one passes its own)",
    );
  }
  return deps.logger;
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
  const config = resolveTracingConfig(deps);
  if (!config.enabled) return INACTIVE_HANDLE;
  if (tracingInstalledServers.has(server)) return INACTIVE_HANDLE;

  const logger = resolveTracingLogger(deps);
  const shared = deps.sink !== undefined;
  const sink = deps.sink ?? createSinkSafely(config, logger, deps.createSink);
  if (!sink) return INACTIVE_HANDLE;
  tracingInstalledServers.add(server);

  // Health comes OFF THE SINK, so the shared and owned paths report identically
  // — one tracker per sink, whoever built it. The previous shape created one
  // here only when the install owned the sink, which meant the production path
  // (`server/main.ts` always passes a shared sink) had none at all and silently
  // discarded every failure.
  const tracker = sink.health;

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
      const active: ActiveMcpTrace = {
        spans: [],
        metadata: {},
        spanBytes: 0,
        payloadDegraded: false,
        logger,
      };
      return activeMcpTrace.run(active, async () => {
        try {
          const result = await callback(args, extra);
          emitTrace(sink, tracker, logger, {
            toolName: name,
            status: isToolError(result) ? "error" : "success",
            durationMs: Date.now() - started,
            maskingEnabled: config.maskingEnabled,
            args,
            output: result,
            metadata: active.metadata,
            spans: active.spans,
            ...authAndSession(args, extra),
          });
          return result;
        } catch (err: unknown) {
          emitTrace(sink, tracker, logger, {
            toolName: name,
            status: "exception",
            durationMs: Date.now() - started,
            maskingEnabled: config.maskingEnabled,
            args,
            output: errorOutput(err),
            metadata: active.metadata,
            spans: active.spans,
            ...authAndSession(args, extra),
          });
          // The caller's error is the one that matters; tracing never changes it.
          throw err;
        }
      });
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
      shared
        ? Promise.resolve()
        : shutdownSink(sink, logger, deps.shutdownTimeoutMs),
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
  readonly background?: BackgroundTraceEmitter;
  shutdown(): Promise<void>;
} {
  const config = resolveTracingConfig(deps);
  if (!config.enabled) return { config, shutdown: () => Promise.resolve() };
  const logger = resolveTracingLogger(deps);
  const built = deps.sink ?? createSinkSafely(config, logger, deps.createSink);
  if (!built) return { config, shutdown: () => Promise.resolve() };
  // THE RUNTIME OWNS THE SHARED SINK, SO IT OWNS THAT SINK'S HEALTH. The real
  // factory attaches its own tracker; an injected sink (a test fake, or one
  // built elsewhere) generally has none, and without this it would travel to
  // every install with no way to report an outage — reintroducing the exact
  // silent-discard bug by a different route. Attaching here means the health
  // wiring is a property of the composition root, which is where the tests can
  // then prove it without reaching into the SDK.
  // Delegating rather than spreading: a sink's methods may be `this`-dependent
  // (the outage-simulating fake reads its own `down` flag), and a spread copy
  // would rebind `this` to the copy and silently change the fake's behaviour.
  const sink: TracingSink =
    built.health === undefined
      ? {
          health: new SinkHealthTracker(deps.healthOptions),
          emit: (body) => built.emit(body),
          forceFlush: () => built.forceFlush(),
          shutdown: () => built.shutdown(),
        }
      : built;
  return {
    config,
    sink,
    background: createBackgroundTraceEmitter(
      sink,
      sink.health,
      logger,
      config.maskingEnabled,
    ),
    shutdown: () => shutdownSink(sink, logger, deps.shutdownTimeoutMs),
  };
}

function createBackgroundTraceEmitter(
  sink: TracingSink,
  tracker: SinkHealthTracker | undefined,
  logger: TracingLogger,
  maskingEnabled: boolean,
): BackgroundTraceEmitter {
  return {
    emitBackground(body: BackgroundTraceBody): void {
      const traceBody: TraceBody = {
        name: body.name,
        input: maskingEnabled ? maskTraceValue(body.input) : body.input,
        output: maskingEnabled ? maskTraceValue(body.output) : body.output,
        tags: body.tags,
        metadata: (maskingEnabled
          ? maskTraceValue(body.metadata)
          : body.metadata) as Record<string, unknown>,
        observations: body.observations.map((observation) =>
          maskBackgroundObservation(observation, maskingEnabled),
        ),
        startedAt: body.startedAt,
        endedAt: body.endedAt,
        ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
        ...(body.userId === undefined ? {} : { userId: body.userId }),
      };
      emitBuiltTrace(sink, tracker, logger, traceBody);
    },
  };
}

function maskBackgroundObservation(
  observation: BackgroundObservation,
  maskingEnabled: boolean,
): BackgroundObservation {
  if (!maskingEnabled) return observation;
  return {
    ...observation,
    input: maskTraceValue(observation.input),
    output: maskTraceValue(observation.output),
    metadata: maskTraceValue(observation.metadata) as Record<string, unknown>,
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
  logger: TracingLogger,
  input: Parameters<typeof buildToolTraceBody>[0],
): void {
  emitBuiltTrace(sink, tracker, logger, buildToolTraceBody(input));
}

function emitBuiltTrace(
  sink: TracingSink,
  tracker: SinkHealthTracker | undefined,
  logger: TracingLogger,
  body: TraceBody,
): void {
  try {
    sink.emit(body);
    // A successful enqueue is the recovery signal for a FAKE sink (one that
    // throws while down). Against the REAL SDK an enqueue always succeeds even
    // with the endpoint dead, so nothing here fires during a real outage and
    // recovery is driven by the health probe in `defaultSinkFactory` instead.
    if (tracker) reportSinkSuccess(logger, tracker);
  } catch (err: unknown) {
    if (tracker) reportSinkFailure(logger, tracker, err);
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
  logger: TracingLogger,
  factory: McpTracingDeps["createSink"],
): TracingSink | undefined {
  try {
    return factory ? factory(config) : defaultSinkFactory(config, logger);
  } catch (err: unknown) {
    logger.warn(
      { error: tracingErrorLabel(err) },
      "mcp_tool_tracing_sink_init_failed",
    );
    return undefined;
  }
}

function isToolError(result: unknown): boolean {
  return Boolean(
    result &&
    typeof result === "object" &&
    (result as { isError?: unknown }).isError === true,
  );
}

/** Test-visible constants, so a test asserts the real value and not a copy. */
export const TRACING_INTERNALS = {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  SINK_EXPORT_TIMEOUT_SECONDS,
  DEFAULT_FLAP_COOLDOWN_MS,
  SINK_HEALTH_PROBE_MS,
} as const;
