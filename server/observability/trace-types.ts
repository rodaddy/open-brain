/**
 * The public type contracts of the tracing lane.
 *
 * Their own module because the SDK sink (`trace-sink.ts`) and the wrapper
 * (`langfuse-tracing.ts`) both need them, and a type-only module is what keeps
 * that from becoming an import cycle through the SDK.
 */
import type { BackgroundObservation } from "../../src/background-tracing.ts";
import type { SinkHealthTracker } from "./trace-sink-health.ts";

export type McpTraceStatus = "success" | "error" | "exception";

export interface McpTracingConfig {
  enabled: boolean;
  maskingEnabled: boolean;
  endpoint: string;
  publicKey: string;
  secretKey: string;
}

/** One child observation collected while a traced MCP tool call is active. */
export interface TraceSpanBody {
  name: string;
  input: unknown;
  output: unknown;
  metadata: Record<string, unknown>;
}

/** The content-ful trace payload for one tool call. */
export interface TraceBody {
  name: string;
  input: unknown;
  output: unknown;
  tags: string[];
  metadata: Record<string, unknown>;
  spans?: TraceSpanBody[];
  sessionId?: string;
  userId?: string;
  observations?: BackgroundObservation[];
  startedAt?: number;
  endedAt?: number;
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
  /**
   * Outage state for THIS sink, owned by whoever built it.
   *
   * Health belongs to the sink and not to an install, because the composition
   * root builds ONE sink and hands it to every per-session install. A tracker
   * created per install would be a tracker the shared path never has (the bug
   * this field exists to remove: `installMcpTracing` used to create one only
   * when it owned the sink, so in production — where `server/main.ts` always
   * passes a shared sink — every failure was counted into `undefined` and no
   * line was ever emitted, measured as zero suspend/recovery lines across a
   * 500-call outage). Optional so a hand-written test fake stays a three-method
   * object; when it is absent the emit path simply has nothing to report to.
   */
  readonly health?: SinkHealthTracker;
}

/**
 * The whole logging surface this lane uses, declared structurally.
 *
 * Two fields-then-message methods, which is the Pino call shape the composition
 * root's logger already has. Structural rather than an import so this lane
 * depends on the SHAPE it needs and not on the
 * root's logging composition, and so a test can hand in a two-method recorder
 * without a transport, a destination, or a correlation context.
 */
export interface TracingLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface McpTracingDeps {
  config?: McpTracingConfig;
  /**
   * The logger this lane reports its own health through.
   *
   * Received from the composition root rather than imported, so the process has
   * ONE logger and this lane cannot acquire a second view of the log
   * destination or the correlation context (#860, L3). Required in practice at
   * every entry point that can log; the field is optional here only because
   * `McpTracingDeps` is also the shape a test passes when it exercises a path
   * that never logs.
   */
  logger?: TracingLogger;
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
  /**
   * Health-tracker tuning for a sink the runtime has to wrap.
   *
   * Exists so a test can drive the flap cooldown from an injected clock instead
   * of sleeping through a 30 s real one.
   */
  healthOptions?: { cooldownMs?: number; now?: () => number };
}

/** Shutdown handle returned by `installMcpTracing`, wired into the stop path. */
export interface McpTracingHandle {
  /** True when a sink was actually built and tool calls are being traced. */
  readonly active: boolean;
  /** Flush pending events and stop the SDK's background machinery. */
  shutdown(): Promise<void>;
}
