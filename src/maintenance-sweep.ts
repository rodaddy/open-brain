import type pg from "pg";
import {
  enqueueGraphDerivationJobs,
  type GraphDerivationEnqueuePort,
} from "./graph-derivation-handler.ts";
import { buildMemoryDistillEnqueue } from "./distill-handler.ts";
import {
  DEFAULT_MAX_DISTILL_SESSIONS,
  DISTILL_ORDER_BY,
} from "./distill-window.ts";
import {
  safeMaintenanceErrorCategory,
  type MaintenanceJob,
  type MaintenanceQueueLogger,
} from "./maintenance-queue.ts";

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
}

export interface MaintenanceSweepSummary {
  distillBatchesSelected: number;
  distillJobsEnqueued: number;
  distillBatchesDeferred: number;
  distillTurnsDeferred: number;
  graphJobsEnqueued: number;
  graphLimitReached: boolean;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  return Math.min(Math.max(Math.trunc(value ?? fallback), 1), max);
}

async function selectDistillLaneBatches(
  pool: Pick<pg.Pool, "query">,
  maxSessions: number,
  maxTurns: number,
  maxBatches: number,
): Promise<DistillLaneBatch[]> {
  const { rows } = await pool.query(
    `WITH due_turns AS (
       SELECT id, lane_id, namespace, session_ref, occurred_at, created_at
         FROM ob_raw_turns
        WHERE distilled_at IS NULL
          AND retention_tier = 'live'
     ),
     due_sessions AS (
       SELECT lane_id, namespace, session_ref, min(occurred_at) AS first_due
         FROM due_turns
        GROUP BY lane_id, namespace, session_ref
     ),
     ranked_sessions AS (
       SELECT *, row_number() OVER (
                PARTITION BY lane_id, namespace
                ORDER BY first_due ASC NULLS LAST,
                         session_ref ASC NULLS LAST
              ) AS session_rank
         FROM due_sessions
     ),
     window_turns AS (
       SELECT t.id, t.lane_id, t.namespace, t.session_ref, t.occurred_at,
              t.content_hash, (t.distilled_at IS NULL) AS is_due
         FROM ob_raw_turns t
         JOIN ranked_sessions s
           ON s.lane_id IS NOT DISTINCT FROM t.lane_id
          AND s.namespace = t.namespace
          AND s.session_ref IS NOT DISTINCT FROM t.session_ref
          AND s.session_rank <= $1
        WHERE t.retention_tier = 'live'
     ),
     ranked_window_turns AS (
       SELECT *, row_number() OVER (
                PARTITION BY lane_id, namespace
                ORDER BY ${DISTILL_ORDER_BY}
              ) AS turn_rank
         FROM window_turns
     ),
     lane_totals AS (
       SELECT lane_id, namespace, count(*)::int AS pending_turns,
              min(created_at) AS first_due
         FROM due_turns
        GROUP BY lane_id, namespace
     ),
     due_lanes AS (
       SELECT totals.lane_id, totals.namespace, totals.pending_turns,
              count(*) FILTER (
                WHERE w.is_due AND w.turn_rank <= $2
              )::int AS processable_turns,
              md5(string_agg(w.id::text || ':' || w.content_hash, ','
                             ORDER BY w.turn_rank)
                  FILTER (
                    WHERE w.is_due AND w.turn_rank <= $2
                  )) AS batch_hash,
              totals.first_due
         FROM lane_totals totals
         JOIN ranked_window_turns w
           ON w.lane_id IS NOT DISTINCT FROM totals.lane_id
          AND w.namespace = totals.namespace
        GROUP BY totals.lane_id, totals.namespace, totals.pending_turns,
                 totals.first_due
       HAVING count(*) FILTER (
                WHERE w.is_due AND w.turn_rank <= $2
              ) > 0
     )
     SELECT lane_id, namespace, pending_turns, processable_turns, batch_hash,
            count(*) OVER()::int AS total_batches
       FROM due_lanes
      ORDER BY first_due, lane_id
      LIMIT $3`,
    [maxSessions, maxTurns, maxBatches],
  );

  return rows.map((row) => ({
    laneId: (row.lane_id as string | null) ?? null,
    namespace: row.namespace as string,
    batchHash: row.batch_hash as string,
    pendingTurns: row.pending_turns as number,
    processableTurns: row.processable_turns as number,
    totalBatches: row.total_batches as number,
  }));
}

async function enqueueDistillBatches(
  options: MaintenanceSweepOptions,
  batches: readonly DistillLaneBatch[],
  maxSessions: number,
  maxTurns: number,
): Promise<{ jobs: MaintenanceJob[]; deferredTurns: number }> {
  const jobs: MaintenanceJob[] = [];
  let deferredTurns = 0;
  for (const batch of batches) {
    deferredTurns += Math.max(
      batch.pendingTurns - batch.processableTurns,
      0,
    );
    jobs.push(
      await options.queue.enqueue(
        buildMemoryDistillEnqueue({
          // The key binds the exact bounded due-turn window the handler can
          // consume. Unchanged ticks dedupe; consuming any due turn changes the
          // watermark, so a succeeded job cannot block the lane's next window.
          sweepLabel: `${batch.batchHash}:s${maxSessions}:t${maxTurns}`,
          namespace: batch.namespace,
          laneId: batch.laneId,
          maxSessions,
          maxTurns,
        }),
      ),
    );
  }
  return { jobs, deferredTurns };
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
  const batches = await selectDistillLaneBatches(
    options.pool,
    distillMaxSessions,
    distillBatchSize,
    maxDistillBatches,
  );
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

  const graph = await enqueueGraphBatches(options, graphDerivationLimit);
  const summary: MaintenanceSweepSummary = {
    distillBatchesSelected: batches.length,
    distillJobsEnqueued: distill.jobs.length,
    distillBatchesDeferred: deferredBatches,
    distillTurnsDeferred: distill.deferredTurns,
    graphJobsEnqueued: graph.jobs.length,
    graphLimitReached: graph.limitReached,
  };
  options.logger.info("maintenance_sweep_complete", {
    distill_batches_selected: summary.distillBatchesSelected,
    distill_jobs_enqueued: summary.distillJobsEnqueued,
    distill_batches_deferred: summary.distillBatchesDeferred,
    distill_turns_deferred: summary.distillTurnsDeferred,
    graph_jobs_enqueued: summary.graphJobsEnqueued,
    graph_limit_reached: summary.graphLimitReached ? 1 : 0,
  });
  return summary;
}

export interface RecurringMaintenanceSweep {
  stop(): Promise<void>;
}

/**
 * Start the recurring producer: one bounded sweep now, then one per interval.
 *
 * THIS LIVES HERE, NOT IN A BOOTSTRAP, BECAUSE THERE ARE TWO COMPOSITIONS OF
 * THE MAINTENANCE RUNNER AND ONLY ONE OF THEM USED TO START A PRODUCER.
 * `src/maintenance-bootstrap.ts` (reached from the LEGACY `src/index.ts`) has
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
  input: MaintenanceSweepOptions & { intervalMs: number },
): RecurringMaintenanceSweep {
  let interval: ReturnType<typeof setInterval> | null = null;
  let active: Promise<void> | null = null;
  let stopping = false;

  const runOnce = (): Promise<void> => {
    if (stopping) return Promise.resolve();
    if (active) return active;

    const run = runMaintenanceSweep(input)
      .then(() => undefined)
      .catch((error: unknown) => {
        input.logger.error("maintenance_sweep_failed", {
          error_category: safeMaintenanceErrorCategory(error),
        });
      })
      .finally(() => {
        active = null;
      });
    active = run;
    return run;
  };

  void runOnce();
  interval = setInterval(() => void runOnce(), input.intervalMs);

  return {
    async stop(): Promise<void> {
      stopping = true;
      if (interval) clearInterval(interval);
      interval = null;
      await active;
    },
  };
}
