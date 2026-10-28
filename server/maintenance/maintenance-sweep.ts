/**
 * The maintenance PRODUCER: selects due distill lanes and changed graph sources
 * and enqueues one bounded job each, plus the recurring timer that runs it.
 *
 * The consumer half is the runner (`./maintenance-queue-runner.ts`); this is
 * the only thing that fills the queue it polls.
 */
import type pg from "pg";
import {
  enqueueGraphDerivationJobs,
  type GraphDerivationEnqueuePort,
} from "./graph-derivation-handler.ts";
import { buildMemoryDistillEnqueue } from "./distill-handler.ts";
import { buildDreamLightEnqueue } from "./dream-light.ts";
import { buildDreamRemEnqueue, DEFAULT_REM_BATCH } from "./dream-rem.ts";
import {
  produceRoute,
  type RouteEligibilitySignals,
  type RouteProducerResult,
} from "./route-producer.ts";
import type { RemProducerConfig, RouteProducerConfig } from "../config/maintenance.ts";
import { createDreamLightRepository } from "../db/dream-light-repository.ts";
import { DEFAULT_MAX_DISTILL_SESSIONS } from "../domain/distill-window.ts";
import {
  createMaintenanceSweepRepository,
  type DistillLaneBatchRow,
} from "../db/maintenance-sweep-repository.ts";
import {
  safeMaintenanceErrorCategory,
  type MaintenanceJob,
} from "./maintenance-job.ts";
import type { MaintenanceQueueLogger } from "./maintenance-queue-runner.ts";

const DEFAULT_DISTILL_BATCH_SIZE = 1_500;
const MAX_DISTILL_BATCH_SIZE = 20_000;
const DEFAULT_MAX_DISTILL_BATCHES = 4;
const MAX_DISTILL_BATCHES = 64;
const DEFAULT_GRAPH_DERIVATION_LIMIT = 100;
const MAX_GRAPH_DERIVATION_LIMIT = 256;

interface DistillLaneBatch {
  laneId: string | null;
  namespace: string;
  batchHash: string;
  pendingTurns: number;
  processableTurns: number;
  totalBatches: number;
}

export interface MaintenanceSweepOptions {
  pool: Pick<pg.Pool, "query">;
  queue: GraphDerivationEnqueuePort;
  logger: MaintenanceQueueLogger;
  distillBatchSize?: number;
  maxDistillBatchesPerTick?: number;
  graphDerivationLimit?: number;
  rem?: RemProducerConfig;
  readRemSignals?: () => Promise<RemEligibilitySignals>;
  route?: RouteProducerConfig;
  readRouteSignals?: () => Promise<RouteEligibilitySignals>;
}

export interface RemEligibilitySignals {
  nowMs: number;
  schedulerStartedAtMs: number;
  lastRemCompletedAtMs: number | null;
  requestsPerMinute: number;
  headroomBytes: number;
  lightBacklog: number;
}

export interface RemProducerResult {
  eligible: boolean;
  enqueued: boolean;
  reason:
    | "disabled"
    | "invalid_config"
    | "invalid_signals"
    | "headroom"
    | "cooldown"
    | "busy"
    | "low_rate"
    | "backlog"
    | "forced";
}

const REM_STARVATION_CEILING_MS = 6 * 60 * 60 * 1_000;

function validSignal(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function remSignalsValid(s: RemEligibilitySignals): boolean {
  const scalarSignals = [
    s.nowMs,
    s.schedulerStartedAtMs,
    s.requestsPerMinute,
    s.headroomBytes,
    s.lightBacklog,
  ];
  return (
    scalarSignals.every(validSignal) &&
    (s.lastRemCompletedAtMs === null || validSignal(s.lastRemCompletedAtMs)) &&
    s.schedulerStartedAtMs <= s.nowMs &&
    (s.lastRemCompletedAtMs === null || s.lastRemCompletedAtMs <= s.nowMs)
  );
}

function remEligibilityReason(
  config: Extract<RemProducerConfig, { enabled: true }>,
  signals: RemEligibilitySignals,
): RemProducerResult["reason"] {
  const since =
    signals.nowMs - (signals.lastRemCompletedAtMs ?? signals.schedulerStartedAtMs);
  if (since >= REM_STARVATION_CEILING_MS) return "forced";
  if (signals.lightBacklog >= config.backlogHighWater) return "backlog";
  if (signals.requestsPerMinute <= config.maxRequestsPerMinute) return "low_rate";
  return "busy";
}

/** Issue 1488: no gap before the first completion; otherwise wait minGapMs. */
function remInCooldown(
  config: Extract<RemProducerConfig, { enabled: true }>,
  s: RemEligibilitySignals,
): boolean {
  return (
    s.lastRemCompletedAtMs !== null &&
    s.nowMs - s.lastRemCompletedAtMs < config.minGapMs
  );
}

/** Decide and enqueue one bounded REM slice; all measurements are injected. */
export async function enqueueDreamRemIfEligible(input: {
  config: RemProducerConfig;
  signals: RemEligibilitySignals;
  queue: Pick<GraphDerivationEnqueuePort, "enqueue">;
}): Promise<RemProducerResult> {
  if (!input.config.enabled) {
    return { eligible: false, enqueued: false, reason: "disabled" };
  }
  if (
    !Number.isSafeInteger(input.config.forcedSliceSize) ||
    input.config.forcedSliceSize < 1 ||
    input.config.forcedSliceSize > DEFAULT_REM_BATCH
  ) {
    return { eligible: false, enqueued: false, reason: "invalid_config" };
  }
  const s = input.signals;
  if (!remSignalsValid(s)) {
    return { eligible: false, enqueued: false, reason: "invalid_signals" };
  }
  if (s.headroomBytes < input.config.minHeadroomBytes) {
    return { eligible: false, enqueued: false, reason: "headroom" };
  }
  if (remInCooldown(input.config, s)) {
    return { eligible: false, enqueued: false, reason: "cooldown" };
  }
  const reason = remEligibilityReason(input.config, s);
  if (reason === "busy") {
    return { eligible: false, enqueued: false, reason: "busy" };
  }
  const completionIdentity = s.lastRemCompletedAtMs ?? s.schedulerStartedAtMs;
  const job = await input.queue.enqueue(
    buildDreamRemEnqueue({
      sweepLabel: `auto:${completionIdentity}`,
      batchSize: input.config.forcedSliceSize,
    }),
  );
  return {
    eligible: true,
    enqueued: job.enqueueOutcome !== "deduped",
    reason,
  };
}

async function produceRem(
  options: MaintenanceSweepOptions,
): Promise<RemProducerResult> {
  if (!options.rem?.enabled) {
    return { eligible: false, enqueued: false, reason: "disabled" };
  }
  if (!options.readRemSignals) {
    return { eligible: false, enqueued: false, reason: "invalid_signals" };
  }
  try {
    return await enqueueDreamRemIfEligible({
      config: options.rem,
      signals: await options.readRemSignals(),
      queue: options.queue,
    });
  } catch (error: unknown) {
    options.logger.warn("maintenance_sweep_rem_signals_failed", {
      error_category: safeMaintenanceErrorCategory(error),
    });
    return { eligible: false, enqueued: false, reason: "invalid_signals" };
  }
}

export interface MaintenanceSweepSummary {
  distillBatchesSelected: number;
  distillJobsEnqueued: number;
  /**
   * Enqueue attempts the queue dropped on an existing idempotency key.
   *
   * A nonzero value here against a nonzero backlog means the lane is WEDGED,
   * not busy: the key is unchanged because nothing consumed the work it names,
   * so no new job can be scheduled under it. This count is the difference
   * between "the sweep is keeping up" and "the sweep has been shouting into a
   * dropped insert for 27 days", which were previously the same log line.
   */
  distillJobsDeduped: number;
  distillBatchesDeferred: number;
  distillTurnsDeferred: number;
  graphJobsEnqueued: number;
  graphLimitReached: boolean;
  rem: RemProducerResult;
  route: RouteProducerResult;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  return Math.min(Math.max(Math.trunc(value ?? fallback), 1), max);
}

/**
 * Widen one raw batch row into the producer's shape.
 *
 * The statement itself moved to ../db/maintenance-sweep-repository.ts (issue
 * 1209); this mapping stayed, because DistillLaneBatch is a maintenance-tier
 * vocabulary rather than a database one.
 */
function toDistillLaneBatch(row: DistillLaneBatchRow): DistillLaneBatch {
  return {
    laneId: row.lane_id ?? null,
    namespace: row.namespace,
    batchHash: row.batch_hash,
    pendingTurns: row.pending_turns,
    processableTurns: row.processable_turns,
    totalBatches: row.total_batches,
  };
}

async function enqueueDistillBatches(
  options: MaintenanceSweepOptions,
  batches: readonly DistillLaneBatch[],
  maxSessions: number,
  maxTurns: number,
): Promise<{
  jobs: MaintenanceJob[];
  deferredTurns: number;
  /** Inserts the queue dropped on the idempotency key: attempted, not scheduled. */
  dedupedJobs: number;
}> {
  const jobs: MaintenanceJob[] = [];
  let deferredTurns = 0;
  let dedupedJobs = 0;
  for (const batch of batches) {
    deferredTurns += Math.max(batch.pendingTurns - batch.processableTurns, 0);
    const job = await options.queue.enqueue(
      buildMemoryDistillEnqueue({
        // The key binds the exact bounded due-turn window the handler can
        // consume. Unchanged ticks dedupe; consuming any due turn changes the
        // watermark, so a succeeded job cannot block the lane's next window.
        //
        // That reasoning holds ONLY while something actually consumes. When the
        // claim returned no due turns (fixed in ../domain/distill-window.ts), nothing
        // was consumed, the watermark never moved, and this key stayed
        // identical forever -- so every later insert was dropped by ON CONFLICT
        // DO NOTHING while this loop went on counting them as enqueued.
        // Observed: `distill_jobs_enqueued: 1` every 5 seconds against a
        // newest job row six hours old.
        sweepLabel: `${batch.batchHash}:s${maxSessions}:t${maxTurns}`,
        namespace: batch.namespace,
        laneId: batch.laneId,
        maxSessions,
        maxTurns,
      }),
    );
    // Count what the queue DID, not what was attempted. A deduped insert
    // scheduled no work, and reporting it as an enqueue is what made a wedged
    // lane read as a healthy one.
    if (job.enqueueOutcome === "deduped") {
      dedupedJobs++;
      continue;
    }
    jobs.push(job);
  }
  return { jobs, deferredTurns, dedupedJobs };
}

async function enqueueGraphBatches(
  options: MaintenanceSweepOptions,
  graphLimit: number,
): Promise<{ jobs: MaintenanceJob[]; limitReached: boolean }> {
  const batch = await enqueueGraphDerivationJobs(
    options.pool,
    options.queue,
    undefined,
    { limit: graphLimit },
  );
  if (batch.limitReached) {
    options.logger.warn("maintenance_sweep_graph_cap_reached", {
      graph_limit: graphLimit,
      enqueued: batch.jobs.length,
    });
  }
  return batch;
}

async function enqueueLightBatches(options: MaintenanceSweepOptions): Promise<void> {
  const repository = createDreamLightRepository(options.pool);
  const rows = await repository.claimUnsweptTurns({
    batchSize: 1,
  });
  const deferred = await repository.countDeferredMissingTimestamp();
  if (deferred > 0) {
    options.logger.warn("maintenance_sweep_light_deferred_missing_timestamp", {
      deferred_missing_timestamp: deferred,
    });
  }
  if (rows.length > 0) await options.queue.enqueue(buildDreamLightEnqueue());
}

/**
 * Produce one bounded maintenance sweep. Selection is read-only and happens
 * outside queue claims; the durable queue's idempotency keys make repeated
 * ticks over unchanged backlog converge without duplicate work.
 */
export async function runMaintenanceSweep(
  options: MaintenanceSweepOptions,
): Promise<MaintenanceSweepSummary> {
  const distillBatchSize = boundedInteger(
    options.distillBatchSize,
    DEFAULT_DISTILL_BATCH_SIZE,
    MAX_DISTILL_BATCH_SIZE,
  );
  const maxDistillBatches = boundedInteger(
    options.maxDistillBatchesPerTick,
    DEFAULT_MAX_DISTILL_BATCHES,
    MAX_DISTILL_BATCHES,
  );
  const graphDerivationLimit = boundedInteger(
    options.graphDerivationLimit,
    DEFAULT_GRAPH_DERIVATION_LIMIT,
    MAX_GRAPH_DERIVATION_LIMIT,
  );

  const distillMaxSessions = DEFAULT_MAX_DISTILL_SESSIONS;
  const batchRows = await createMaintenanceSweepRepository(
    options.pool,
  ).selectDistillLaneBatches({
    maxSessions: distillMaxSessions,
    maxTurns: distillBatchSize,
    maxBatches: maxDistillBatches,
  });
  const batches = batchRows.map(toDistillLaneBatch);
  const totalBatches = batches[0]?.totalBatches ?? 0;
  const distill = await enqueueDistillBatches(
    options,
    batches,
    distillMaxSessions,
    distillBatchSize,
  );
  const deferredBatches = Math.max(totalBatches - batches.length, 0);
  if (deferredBatches > 0 || distill.deferredTurns > 0) {
    options.logger.warn("maintenance_sweep_distill_cap_hit", {
      batch_size: distillBatchSize,
      max_sessions: distillMaxSessions,
      max_batches: maxDistillBatches,
      selected_batches: batches.length,
      deferred_batches: deferredBatches,
      deferred_turns_in_selected_lanes: distill.deferredTurns,
    });
  }

  try {
    await enqueueLightBatches(options);
  } catch (error: unknown) {
    options.logger.warn("maintenance_sweep_light_failed", {
      error_category: safeMaintenanceErrorCategory(error),
    });
  }
  const rem = await produceRem(options);
  const route = await produceRoute(options);
  const graph = await enqueueGraphBatches(options, graphDerivationLimit);
  const summary: MaintenanceSweepSummary = {
    distillBatchesSelected: batches.length,
    distillJobsEnqueued: distill.jobs.length,
    distillJobsDeduped: distill.dedupedJobs,
    distillBatchesDeferred: deferredBatches,
    distillTurnsDeferred: distill.deferredTurns,
    graphJobsEnqueued: graph.jobs.length,
    graphLimitReached: graph.limitReached,
    rem,
    route,
  };
  options.logger.info("maintenance_sweep_complete", {
    distill_batches_selected: summary.distillBatchesSelected,
    distill_jobs_enqueued: summary.distillJobsEnqueued,
    distill_jobs_deduped: summary.distillJobsDeduped,
    distill_batches_deferred: summary.distillBatchesDeferred,
    distill_turns_deferred: summary.distillTurnsDeferred,
    graph_jobs_enqueued: summary.graphJobsEnqueued,
    graph_limit_reached: summary.graphLimitReached ? 1 : 0,
    rem_eligible: summary.rem.eligible ? 1 : 0,
    rem_enqueued: summary.rem.enqueued ? 1 : 0,
    rem_reason: summary.rem.reason,
    route_eligible: Number(summary.route.eligible),
    route_enqueued: Number(summary.route.enqueued),
    route_reason: summary.route.reason,
  });
  return summary;
}

/**
 * What the producer can say about its own liveness, for a health reader.
 *
 * `quietMs` is the age of the last COMPLETED tick, not the age of the last
 * attempt: a producer whose ticks all hang is quiet no matter how often the
 * timer fires, and that distinction is the whole point of #625.
 */
export interface MaintenanceSweepLiveness {
  /** Milliseconds since the last tick that finished (success or handled failure). */
  readonly quietMs: number;
  /** True once `quietMs` exceeds the configured threshold. */
  readonly stale: boolean;
  /** The threshold `stale` was computed against, so a reader can report it. */
  readonly quietThresholdMs: number;
  /** Ticks that returned early because a previous tick was still running. */
  readonly overlappedTicks: number;
  /** Ticks that ran to completion, successfully or with a handled failure. */
  readonly completedTicks: number;
}

export interface RecurringMaintenanceSweep {
  stop(): Promise<void>;
  /**
   * Current producer liveness. Read by `/health` so a wedged producer cannot
   * stay invisible behind a green database probe.
   */
  liveness(): MaintenanceSweepLiveness;
}

/**
 * Default quiet threshold: a producer is stale once it has gone this long with
 * no completed tick. Twelve times the 5s default cadence — long enough that an
 * ordinarily slow sweep does not flap the health status, short enough that the
 * ~18 minutes of silence observed in #625 is reported within the first minute.
 */
const DEFAULT_QUIET_THRESHOLD_MS = 60_000;

/**
 * Start the recurring producer: one bounded sweep now, then one per interval.
 *
 * THIS LIVES HERE, NOT IN A BOOTSTRAP, BECAUSE THERE ARE TWO COMPOSITIONS OF
 * THE MAINTENANCE RUNNER AND ONLY ONE OF THEM USED TO START A PRODUCER.
 * `./maintenance-bootstrap.ts` (reached from the legacy entrypoint) has
 * started the sweep since #577. `server/maintenance/index.ts` — reached from
 * `server/main.ts`, which the Phase 6 cutover made the SERVING entrypoint —
 * composed the runner and nothing else. So #384's exact symptom survived the PR
 * that added the producer: the serving process polled a queue that no producer
 * filled, emitting "maintenance queue idle" indefinitely and never one
 * `maintenance_sweep_complete`.
 *
 * Placing the loop in this module — which imports only the sweep's own leaf
 * dependencies — lets the server boundary reach it WITHOUT importing the
 * bootstrap's embedding providers and handler composition. Writing a second
 * copy of the loop for the server was the alternative and is rejected for the
 * reason `server/maintenance/index.ts` already gives about the runner: a
 * duplicated loop whose failure mode is silence drifts precisely where drift is
 * invisible.
 *
 * Bounded and non-overlapping, mirroring the runner's own discipline: a tick
 * already in flight is returned rather than a second one started, a failed tick
 * logs a content-free category and the interval survives it, and `stop()`
 * refuses new ticks and awaits the in-flight one so the producer cannot add
 * work after the runner has begun draining.
 */
export function startRecurringMaintenanceSweep(
  input: MaintenanceSweepOptions & {
    intervalMs: number;
    /**
     * Clock source, injected so liveness can be tested without sleeping.
     * Defaults to `Date.now`. A wall-clock assertion is a flake generator
     * (docs/lane-contract.md, Tightenings round 5), so the only way to test
     * staleness honestly is to make time a parameter.
     */
    now?: () => number;
    /** Quiet duration after which the producer reports itself stale. */
    quietThresholdMs?: number;
  },
): RecurringMaintenanceSweep {
  let interval: ReturnType<typeof setInterval> | null = null;
  let active: Promise<void> | null = null;
  let stopping = false;

  const now = input.now ?? Date.now;
  const quietThresholdMs = Math.max(
    input.quietThresholdMs ?? DEFAULT_QUIET_THRESHOLD_MS,
    1,
  );

  // Seeded at start, not at 0: a producer that has just booted is not stale,
  // and treating "never completed" as infinitely quiet would report every
  // process as degraded for its first tick.
  let lastCompletedAt = now();
  let overlappedTicks = 0;
  let completedTicks = 0;
  // Warn once per stall, not once per skipped tick: at a 5s cadence an
  // 18-minute stall is ~216 skips, and 216 identical warnings is how a real
  // signal gets filtered out as noise. The counter carried on the first line is
  // what makes the extent recoverable without emitting each one.
  let warnedForCurrentStall = false;

  const runOnce = (): Promise<void> => {
    if (stopping) return Promise.resolve();
    if (active) {
      // THE #625 DEFECT. Declining to start a second overlapping tick is
      // correct; returning from here SILENTLY is not. When a tick hangs — a
      // slow selection query, a pool connection that never returns, a lock —
      // every subsequent interval landed here and emitted nothing, so a wedged
      // producer and a keeping-up producer looked identical from the outside:
      // both are quiet between sweeps. Observed as ~18 minutes of silence on
      // the local clone while /health stayed green (#625, found by the #612
      // lane). `_DOCS/STANDARDS-observability.md` names the guard-trigger path
      // as one of the five required log points and states the governing rule:
      // absence of a log line must never be used as proof of success.
      overlappedTicks += 1;
      if (!warnedForCurrentStall) {
        warnedForCurrentStall = true;
        input.logger.warn("maintenance_sweep_tick_overlapped", {
          quiet_ms: now() - lastCompletedAt,
          quiet_threshold_ms: quietThresholdMs,
          overlapped_ticks: overlappedTicks,
          completed_ticks: completedTicks,
          interval_ms: input.intervalMs,
        });
      }
      return active;
    }

    const run = runMaintenanceSweep(input)
      .then(() => undefined)
      .catch((error: unknown) => {
        input.logger.error("maintenance_sweep_failed", {
          error_category: safeMaintenanceErrorCategory(error),
        });
      })
      .finally(() => {
        // A handled failure still counts as a completed tick: the producer is
        // alive and reporting, which is a different condition from silence, and
        // conflating them would make an erroring sweep also look wedged.
        const wasStalled = warnedForCurrentStall;
        const quietMs = now() - lastCompletedAt;
        lastCompletedAt = now();
        completedTicks += 1;
        active = null;
        warnedForCurrentStall = false;
        if (wasStalled) {
          // Recovery is an outcome and gets its own signal, so an operator
          // reading the log can close the incident without inferring it from
          // the absence of further warnings.
          input.logger.warn("maintenance_sweep_tick_recovered", {
            quiet_ms: quietMs,
            quiet_threshold_ms: quietThresholdMs,
            overlapped_ticks: overlappedTicks,
            completed_ticks: completedTicks,
          });
        }
      });
    active = run;
    return run;
  };

  void runOnce();
  interval = setInterval(() => void runOnce(), input.intervalMs);

  return {
    liveness(): MaintenanceSweepLiveness {
      const quietMs = now() - lastCompletedAt;
      return {
        quietMs,
        stale: quietMs > quietThresholdMs,
        quietThresholdMs,
        overlappedTicks,
        completedTicks,
      };
    },
    async stop(): Promise<void> {
      stopping = true;
      if (interval) clearInterval(interval);
      interval = null;
      await active;
    },
  };
}
