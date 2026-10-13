/**
 * The dream.route PRODUCER (issue 1525): decides from injected facts whether
 * the maintenance sweep enqueues one route pass. Modelled on the REM producer
 * in `./maintenance-sweep.ts`, which calls `produceRoute` right after REM.
 */
import { buildDreamRouteEnqueue } from "./dream-route.ts";
import type { GraphDerivationEnqueuePort } from "./graph-derivation-handler.ts";
import type { RouteProducerConfig } from "../config/maintenance.ts";
import { safeMaintenanceErrorCategory } from "./maintenance-job.ts";
import type { MaintenanceSweepOptions } from "./maintenance-sweep.ts";

function validSignal(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export interface RouteEligibilitySignals {
  nowMs: number;
  lastRouteTerminalAtMs: number | null;
  hasUnrouted: boolean;
}

export interface RouteProducerResult {
  eligible: boolean;
  enqueued: boolean;
  reason: "disabled" | "invalid_signals" | "cooldown" | "nothing_unrouted" | "due";
}

function routeSignalsValid(s: RouteEligibilitySignals): boolean {
  return (
    validSignal(s.nowMs) &&
    (s.lastRouteTerminalAtMs === null ||
      (validSignal(s.lastRouteTerminalAtMs) && s.lastRouteTerminalAtMs <= s.nowMs))
  );
}

/**
 * Decide and enqueue one route pass (issue 1525). The gap runs from the last
 * terminal route job; the sweep label names that window, so one window maps to
 * one idempotency key.
 */
export async function enqueueDreamRouteIfEligible(input: {
  config: RouteProducerConfig;
  signals: RouteEligibilitySignals;
  queue: Pick<GraphDerivationEnqueuePort, "enqueue">;
}): Promise<RouteProducerResult> {
  if (!input.config.enabled) {
    return { eligible: false, enqueued: false, reason: "disabled" };
  }
  const s = input.signals;
  if (!routeSignalsValid(s)) {
    return { eligible: false, enqueued: false, reason: "invalid_signals" };
  }
  const last = s.lastRouteTerminalAtMs;
  if (last !== null && s.nowMs - last < input.config.minGapMs) {
    return { eligible: false, enqueued: false, reason: "cooldown" };
  }
  if (!s.hasUnrouted) {
    return { eligible: false, enqueued: false, reason: "nothing_unrouted" };
  }
  const job = await input.queue.enqueue(
    buildDreamRouteEnqueue({
      sweepLabel: `auto:${last ?? "first"}`,
      batchSize: input.config.sliceSize,
    }),
  );
  return { eligible: true, enqueued: job.enqueueOutcome !== "deduped", reason: "due" };
}

export async function produceRoute(
  options: Pick<
    MaintenanceSweepOptions,
    "route" | "readRouteSignals" | "queue" | "logger"
  >,
): Promise<RouteProducerResult> {
  if (!options.route?.enabled) {
    return { eligible: false, enqueued: false, reason: "disabled" };
  }
  if (!options.readRouteSignals) {
    return { eligible: false, enqueued: false, reason: "invalid_signals" };
  }
  try {
    return await enqueueDreamRouteIfEligible({
      config: options.route,
      signals: await options.readRouteSignals(),
      queue: options.queue,
    });
  } catch (error: unknown) {
    options.logger.warn("maintenance_sweep_route_signals_failed", {
      error_category: safeMaintenanceErrorCategory(error),
    });
    return { eligible: false, enqueued: false, reason: "invalid_signals" };
  }
}
