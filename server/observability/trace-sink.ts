/**
 * The Langfuse/OpenTelemetry sink: the one place this lane touches the SDK.
 *
 * SDK v4 (OTel-based), per the operator decision recorded on #530 on
 * 2026-08-03. The v4 processor is an OpenTelemetry `SpanProcessor`: the queue
 * is `BatchSpanProcessor`'s, which drops rather than growing once it is full,
 * and the drain is `forceFlush()`/`shutdown()` with a real timeout knob.
 *
 * Split out of `langfuse-tracing.ts` so the rest of the lane — the wrapper, the
 * trace body, the masking — is SDK-agnostic and a future SDK-major swap stays a
 * one-file change. `TracingSink` is declared structurally on the other side of
 * this boundary for exactly that reason.
 */
import { configureGlobalLogger, LogLevel } from "@langfuse/core";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  setLangfuseTracerProvider,
  startObservation,
  type LangfuseSpan,
} from "@langfuse/tracing";
import { setGlobalErrorHandler } from "@opentelemetry/core";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { BackgroundObservation } from "../application/background-tracing.ts";
import { tracingErrorLabel } from "./trace-error-label.ts";
import {
  reportSinkFailure,
  reportSinkSuccess,
  SinkHealthTracker,
} from "./trace-sink-health.ts";
import { repoRelease } from "./trace-release.ts";
import type {
  McpTracingConfig,
  TraceBody,
  TracingLogger,
  TracingSink,
} from "./trace-types.ts";

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
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2500;

/**
 * Export timeout handed to the processor, in SECONDS — the SDK's unit for
 * `LangfuseSpanProcessorParams.timeout`, which it documents as seconds with a
 * default of 5. Kept below the shutdown deadline above so the SDK's own attempt
 * gives up first and the race stays a backstop rather than the normal path.
 */
export const SINK_EXPORT_TIMEOUT_SECONDS = 2;

/**
 * How often a KNOWN-UNHEALTHY sink re-checks whether the endpoint is back.
 *
 * Only ever runs while the tracker is already down, so this is not a background
 * cost on a working system. 5 s matches the batch processor's default export
 * cadence: probing faster would just race the queue's own attempts, and slower
 * would leave the recovery line trailing the actual recovery.
 */
export const SINK_HEALTH_PROBE_MS = 5_000;

interface TraceObservation {
  startObservation(
    name: string,
    body: {
      input?: unknown;
      output?: unknown;
      metadata?: Record<string, unknown>;
    },
  ): TraceObservation;
  updateTrace(input: {
    name: string;
    tags: string[];
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    sessionId?: string;
    userId?: string;
  }): void;
  end(endTime?: Date): void;
}

interface TraceEmissionOptions<T extends TraceObservation> {
  emitObservation?: (parent: T, observation: BackgroundObservation) => void;
}

/** Materialize one completed trace body through the SDK observation surface. */
export function emitTraceBodyWithObservations<T extends TraceObservation>(
  body: TraceBody,
  start: (name: string, body: Record<string, unknown>) => T,
  options: TraceEmissionOptions<T> = {},
): void {
  const span = start(body.name, {
    input: body.input,
    output: body.output,
    metadata: body.metadata,
  });
  try {
    span.updateTrace({
      name: body.name,
      tags: body.tags,
      input: body.input,
      output: body.output,
      metadata: body.metadata,
      ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
      ...(body.userId === undefined ? {} : { userId: body.userId }),
    });
    for (const childBody of body.spans ?? []) {
      const child = span.startObservation(childBody.name, {
        input: childBody.input,
        output: childBody.output,
        metadata: childBody.metadata,
      });
      child.end();
    }
    for (const observation of body.observations ?? []) {
      options.emitObservation?.(span, observation);
    }
  } finally {
    span.end(body.endedAt === undefined ? undefined : new Date(body.endedAt));
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
function emitChildObservation(
  parent: LangfuseSpan,
  observation: BackgroundObservation,
): void {
  const attributes = {
    input: observation.input,
    output: observation.output,
    metadata: {
      ...observation.metadata,
      duration_ms: Math.max(0, observation.endedAt - observation.startedAt),
    },
    ...(observation.model === undefined ? {} : { model: observation.model }),
    ...(observation.usageDetails === undefined
      ? {}
      : { usageDetails: observation.usageDetails }),
    ...(observation.level === undefined ? {} : { level: observation.level }),
    ...(observation.statusMessage === undefined
      ? {}
      : { statusMessage: observation.statusMessage }),
  };
  const options = {
    startTime: new Date(observation.startedAt),
    parentSpanContext: parent.otelSpan.spanContext(),
  };
  const child =
    observation.type === "generation"
      ? startObservation(observation.name, attributes, {
          ...options,
          asType: "generation",
        })
      : observation.type === "embedding"
        ? startObservation(observation.name, attributes, {
            ...options,
            asType: "embedding",
          })
        : startObservation(observation.name, attributes, {
            ...options,
            asType: "span",
          });
  child.end(new Date(observation.endedAt));
}

export function defaultSinkFactory(
  config: McpTracingConfig,
  logger: TracingLogger,
): TracingSink {
  // The SDK's own logger writes export failures straight to `console.error`
  // with the raw error attached (`@langfuse/core` Logger.error), which would
  // route a transport message — potentially carrying the endpoint, a request
  // body, or an auth header — around this module's content-free discipline and
  // around the shared logger's redaction. Silenced to ERROR+1 so nothing the
  // SDK emits reaches the log; this lane reports its own health through the
  // two state-change lines instead, which carry a label and a count only.
  configureGlobalLogger({ level: (LogLevel.ERROR + 1) as LogLevel });
  // `release` belongs to the PROCESSOR, not to `updateTrace` (#560). The SDK
  // stamps it onto every span it sees at start, and `LangfuseTraceAttributes`
  // — what `updateTrace` accepts — has no release field at all, so setting it
  // there would be silently dropped rather than rejected. Verified against the
  // installed `@langfuse/otel` 4.6.x type surface.
  //
  // Spread so an unresolvable SHA omits the option entirely instead of passing
  // `undefined`, keeping "unknown release" distinct from a placeholder value.
  const release = repoRelease();
  const processor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.endpoint,
    timeout: SINK_EXPORT_TIMEOUT_SECONDS,
    exportMode: "batched",
    ...(release === undefined ? {} : { release }),
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  setLangfuseTracerProvider(provider);
  const tracker = new SinkHealthTracker();

  // WHERE AN OUTAGE ACTUALLY BECOMES VISIBLE WHILE THE SERVER RUNS.
  //
  // `emit` cannot fail against a dead endpoint — it is a synchronous enqueue
  // onto the batch processor's in-memory queue, which succeeds whether or not
  // anything is listening on the far end. The failure happens later, on the
  // processor's own background export, and OTel routes that rejection to the
  // global error handler (`BatchSpanProcessorBase._maybeStartTimer`'s `.catch`,
  // verified in `@opentelemetry/sdk-trace` 2.10.0). The default handler logs
  // through `diag`, and this module silences the SDK logger for content-free
  // reasons — so before this hook an outage produced NOTHING until shutdown
  // flush, which is precisely the silence #530 forbids.
  //
  // `forceFlush()` rejects to its CALLER instead of coming through here, so the
  // drain path below and this hook are disjoint and one outage is never
  // double-reported.
  //
  // This handler is process-global and OTel offers no per-processor seam, so it
  // is installed only when this lane builds a real sink (never in tests, which
  // inject a fake factory), and it deliberately reports rather than swallows:
  // the previous behaviour for a non-Langfuse OTel error was a silent drop into
  // a silenced diag logger, so routing it to a content-free warn strictly
  // increases what an operator sees.
  // `countsAsTrace: false` — a failed export batch is not itself a lost trace.
  // The traces are counted as they are enqueued below, so counting the batch
  // here as well would double-count them.
  setGlobalErrorHandler((err: unknown) => {
    reportSinkFailure(logger, tracker, err, false);
  });

  // THE RECOVERY EDGE, which the error handler above cannot see.
  //
  // OTel signals export FAILURE globally but signals success nowhere: on a good
  // batch `_flushOneBatch` simply resolves into a `.finally`, with no hook
  // (verified in `@opentelemetry/sdk-trace` 2.10.0). Without this probe an
  // outage would print its suspend line and then stay silent forever, and #530
  // asks for the pair — the recovery line naming the dropped count is the half
  // that tells an operator to stop looking.
  //
  // ONLY probes while already known-unhealthy, so the happy path costs exactly
  // nothing.
  //
  // A REAL SPAN IS SENT, and that is not incidental. `forceFlush()` on an EMPTY
  // queue returns an already-resolved promise without touching the network
  // (`_flushOneBatch` returns early on `length === 0`), so flushing nothing
  // "succeeds" against a blackholed endpoint and reads as recovery. That false
  // recovery was MEASURED on the first probe of this fix: the lane reported
  // `mcp_tool_tracing_resumed` while the endpoint was still non-routable.
  // Enqueueing one span first means the flush has something to actually export,
  // so its result reflects the transport rather than an empty queue.
  const probe = setInterval(() => {
    if (tracker.isHealthy) return;
    try {
      const span = startObservation("mcp_tool_tracing_health_probe", {
        // Content-free by construction: the probe carries no payload, so it can
        // never smuggle argument or result text to the endpoint.
        metadata: { probe: true },
      });
      span.end();
    } catch {
      // A probe that cannot even be built is not a recovery; stay down.
      return;
    }
    void processor
      .forceFlush()
      .then(() => {
        // The probe span above guarantees the queue was non-empty, so a resolve
        // here really is the endpoint answering.
        tracker.noteDelivered();
        reportSinkSuccess(logger, tracker);
      })
      // Still down — and deliberately NOT `recordFailure`, which would count
      // this probe as a dropped trace and inflate the recovery line with
      // attempts that carried no payload. The window is already open; a failed
      // probe is simply not the recovery, so it reports nothing.
      .catch(() => undefined);
  }, SINK_HEALTH_PROBE_MS);
  // Never hold the event loop open for a diagnostic: without this an idle
  // process would refuse to exit on account of the tracing lane alone.
  probe.unref?.();

  return {
    health: tracker,
    emit(body: TraceBody): void {
      // These records are emitted after the work completes. Supplying the real
      // timestamps preserves worker/provider duration instead of measuring the
      // few microseconds spent enqueueing the completed trace.
      emitTraceBodyWithObservations(
        body,
        (name, attributes) =>
          startObservation(
            name,
            attributes,
            body.startedAt === undefined
              ? undefined
              : { startTime: new Date(body.startedAt) },
          ),
        { emitObservation: emitChildObservation },
      );
      tracker.recordEnqueued();
    },
    async forceFlush(): Promise<void> {
      // DRAINING IS NOT EVIDENCE OF HEALTH, so this path deliberately reports
      // no recovery. `forceFlush()` resolves whenever the queue ends up empty —
      // including when the spans were already DROPPED by earlier failed
      // exports, which is exactly the state a long outage leaves behind. A
      // blackholed 500-call probe was measured printing `resumed` from right
      // here with the endpoint still non-routable; announcing a recovery that
      // did not happen is worse than saying nothing, because it retracts a
      // warning the operator was correctly given.
      //
      // Recovery is the health probe's job (see above): it enqueues its own
      // span first, so a resolve there means that span was exported rather than
      // merely absent. A failure is still worth recording, since a REJECTED
      // flush is unambiguous.
      try {
        await processor.forceFlush();
      } catch (err: unknown) {
        reportSinkFailure(logger, tracker, err, false);
      }
    },
    shutdown(): Promise<void> {
      // Stop probing before draining, so a probe cannot race the shutdown flush
      // and report health state about a sink that is on its way out.
      clearInterval(probe);
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
export async function shutdownSink(
  sink: TracingSink,
  logger: TracingLogger,
  timeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const outcome = await withDeadline(drainSink(sink, logger), timeoutMs);
  if (outcome === "timeout") {
    // Content-free: the deadline itself, never a payload, a key, or a
    // transport error message.
    logger.warn({ timeoutMs }, "mcp_tool_tracing_shutdown_timeout");
  }
}

/** The drain pair, each failure logged content-free and never rethrown. */
async function drainSink(sink: TracingSink, logger: TracingLogger): Promise<void> {
  try {
    await sink.forceFlush();
  } catch (err: unknown) {
    logger.warn({ error: tracingErrorLabel(err) }, "mcp_tool_tracing_flush_failed");
  }
  try {
    await sink.shutdown();
  } catch (err: unknown) {
    logger.warn({ error: tracingErrorLabel(err) }, "mcp_tool_tracing_shutdown_failed");
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
  const outcome = await Promise.race([work.then(() => "settled" as const), timed]);
  if (timer) clearTimeout(timer);
  return outcome;
}
