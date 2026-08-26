/**
 * Outage state for the tracing sink, and the two lines an outage may print.
 *
 * OUTAGE BEHAVIOUR IS STATE-CHANGE-ONLY, in the operator's words on #530:
 * Langfuse is "an extremely super important, nice to have. It shouldn't stop
 * things from running, but it should continue loudly." What an outage must not
 * be is silent, and it must not be per-call either — "if you do that every
 * time, you're going to spend most of your time saying hey hey this isn't
 * working." So exactly two lines are emitted per outage: one when the sink
 * transitions to unreachable, one when it recovers, carrying the count dropped
 * during that window.
 *
 * Split out of `langfuse-tracing.ts` because this is a self-contained state
 * machine with its own external consumer (`src/rotating-file.ts`) and no
 * dependency on the SDK, the MCP server, or the trace body.
 */
import { logger } from "../../src/logger.ts";
import { tracingErrorLabel } from "./trace-error-label.ts";

/**
 * Quiet period after a reported recovery before another PAIR may be printed.
 *
 * State-change-only is not by itself a floor under output: a sink alternating
 * fail/success is a state change on every call, which is how 20 alternating
 * calls MEASURED 10 suspend and 10 resume lines — per-call noise arriving
 * through the rule meant to prevent it. The operator's ruling on #530 is
 * state-change-only "within reason", so a flapping sink reports at most one
 * pair per cooldown while a genuine outage still reports immediately: the first
 * transition after a quiet period is never delayed, only the ones stacked
 * behind a recovery that was just printed.
 *
 * 30 s is chosen against the export cadence rather than arbitrarily — the batch
 * processor's default schedule is 5 s, so this spans several export attempts
 * and a real outage is still surfaced inside one operator-noticeable interval.
 */
export const DEFAULT_FLAP_COOLDOWN_MS = 30_000;

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
   * Traces enqueued while the sink still looked healthy.
   *
   * Rolled into `dropped` when a failure is discovered, because a background
   * export failure condemns the batch that was already queued — those traces
   * were lost, they simply had not been found out yet. Cleared on a flush that
   * really reached the endpoint (`noteDelivered`).
   */
  private pending = 0;
  /**
   * When the last REPORTED pair completed, i.e. the last recovery that actually
   * logged. `undefined` until one has, so the first outage is never delayed.
   */
  private lastReportedAt: number | undefined;
  /** True while a window is being ridden out silently under the cooldown. */
  private suppressed = false;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: { cooldownMs?: number; now?: () => number } = {}) {
    this.cooldownMs = options.cooldownMs ?? DEFAULT_FLAP_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Count one trace handed to the sink, whatever the current health state.
   *
   * SEPARATE FROM `recordFailure` because the two count different things, and
   * conflating them under-reports the loss by orders of magnitude. A failure is
   * one failed EXPORT BATCH; the operator's question is the TRACE count that
   * went missing. The first probe of this lane reported `droppedTraces: 1`
   * after 500 dropped calls, because the batch processor had failed a single
   * export — a figure that reads as "nearly nothing happened" for a total
   * outage.
   *
   * COUNTED WHILE HEALTHY TOO, into a pending tally that only becomes a loss if
   * the window turns out to be bad. An outage is discovered on the background
   * export, SECONDS after the traces were enqueued — the same 500-call probe
   * then reported `droppedTraces: 0`, because every one of those traces had
   * been handed over while the sink still looked healthy. The traces already
   * sitting in the queue when the endpoint dies are exactly the ones an
   * operator lost, so they have to be in the figure.
   */
  recordEnqueued(): void {
    if (this.healthy) {
      this.pending += 1;
      return;
    }
    this.dropped += 1;
  }

  /**
   * Record a failed emit or export. Returns true ONLY on the transition into
   * an outage, so the caller logs the suspend line exactly once per window.
   *
   * A transition inside the cooldown window returns false and marks the whole
   * window suppressed, so its recovery stays silent too: the unit of output is
   * the PAIR, and reporting a resume whose suspend was never printed would read
   * as a recovery from nothing.
   *
   * `countsAsTrace` distinguishes the two callers: a throwing `emit` lost
   * exactly one trace, while a failed background export batch lost none by
   * itself — its traces are already counted by `recordEnqueued`, so counting
   * the batch too would double-count.
   */
  recordFailure(countsAsTrace = true): boolean {
    if (countsAsTrace) this.dropped += 1;
    if (!this.healthy) return false;
    this.healthy = false;
    // The batch that was in flight when the endpoint died is lost with it.
    this.dropped += this.pending;
    this.pending = 0;
    if (this.withinCooldown()) {
      this.suppressed = true;
      return false;
    }
    this.suppressed = false;
    return true;
  }

  /**
   * Record a success. Returns the number of traces dropped during the window
   * that just ended, or undefined when nothing changed — so a healthy sink
   * emits nothing at all on the happy path.
   *
   * The drop count is cleared on every recovery including a suppressed one:
   * the counter measures a window, and a suppressed window is still a window
   * that ended. Carrying it forward would inflate the next reported figure with
   * drops from flaps the operator was deliberately not shown.
   */
  recordSuccess(): number | undefined {
    if (this.healthy) return undefined;
    const dropped = this.dropped;
    this.healthy = true;
    this.dropped = 0;
    if (this.suppressed) {
      this.suppressed = false;
      return undefined;
    }
    // Only a REPORTED pair starts the next cooldown. A suppressed window must
    // not extend the quiet period, or a sink flapping faster than the cooldown
    // would stay silent forever instead of reporting once per cooldown.
    this.lastReportedAt = this.now();
    return dropped;
  }

  /**
   * A flush that really reached the endpoint: the pending traces landed, so
   * they can no longer become a loss. Distinct from `recordSuccess`, which is
   * about the health EDGE — a healthy sink calls this routinely and logs
   * nothing.
   */
  noteDelivered(): void {
    this.pending = 0;
  }

  private withinCooldown(): boolean {
    if (this.lastReportedAt === undefined) return false;
    return this.now() - this.lastReportedAt < this.cooldownMs;
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
  countsAsTrace = true,
): void {
  if (!tracker.recordFailure(countsAsTrace)) return;
  logger.warn("mcp_tool_tracing_suspended", { error: tracingErrorLabel(err) });
}

/** Emit the recovery line with the window's drop count, and only on the edge. */
export function reportSinkSuccess(tracker: SinkHealthTracker): void {
  const dropped = tracker.recordSuccess();
  if (dropped === undefined) return;
  logger.info("mcp_tool_tracing_resumed", { droppedTraces: dropped });
}
