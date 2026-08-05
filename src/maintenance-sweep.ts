import type pg from "pg";
import {
  enqueueGraphDerivationJobs,
  type GraphDerivationEnqueuePort,
} from "./graph-derivation-handler.ts";
import { buildMemoryDistillEnqueue } from "./distill-handler.ts";
import type {
  MaintenanceJob,
  MaintenanceQueueLogger,
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
  batchAnchor: string;
  pendingTurns: number;
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
  distillTurnsDeferredByBatchCap: number;
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
  maxBatches: number,
): Promise<DistillLaneBatch[]> {
  const { rows } = await pool.query(
    `WITH due_lanes AS (
       SELECT lane_id, namespace,
              count(*)::int AS pending_turns,
              (array_agg(id ORDER BY created_at, id))[1]::text AS batch_anchor,
              min(created_at) AS first_due
         FROM ob_raw_turns
        WHERE distilled_at IS NULL
          AND retention_tier = 'live'
        GROUP BY lane_id, namespace
     )
     SELECT lane_id, namespace, pending_turns, batch_anchor,
            count(*) OVER()::int AS total_batches
       FROM due_lanes
      ORDER BY first_due, lane_id
      LIMIT $1`,
    [maxBatches],
  );

  return rows.map((row) => ({
    laneId: (row.lane_id as string | null) ?? null,
    namespace: row.namespace as string,
    batchAnchor: row.batch_anchor as string,
    pendingTurns: row.pending_turns as number,
    totalBatches: row.total_batches as number,
  }));
}

async function enqueueDistillBatches(
  options: MaintenanceSweepOptions,
  batches: readonly DistillLaneBatch[],
  batchSize: number,
): Promise<{ jobs: MaintenanceJob[]; deferredTurns: number }> {
  const jobs: MaintenanceJob[] = [];
  let deferredTurns = 0;
  for (const batch of batches) {
    deferredTurns += Math.max(batch.pendingTurns - batchSize, 0);
    jobs.push(
      await options.queue.enqueue(
        buildMemoryDistillEnqueue({
          sweepLabel: `${batch.laneId ?? "unassigned"}:${batch.batchAnchor}`,
          namespace: batch.namespace,
          laneId: batch.laneId,
          maxTurns: batchSize,
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
  const jobs = await enqueueGraphDerivationJobs(
    options.pool,
    options.queue,
    undefined,
    { limit: graphLimit },
  );
  const limitReached = jobs.length === graphLimit;
  if (limitReached) {
    options.logger.warn("maintenance_sweep_graph_cap_reached", {
      graph_limit: graphLimit,
      enqueued: jobs.length,
    });
  }
  return { jobs, limitReached };
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

  const batches = await selectDistillLaneBatches(
    options.pool,
    maxDistillBatches,
  );
  const totalBatches = batches[0]?.totalBatches ?? 0;
  const distill = await enqueueDistillBatches(
    options,
    batches,
    distillBatchSize,
  );
  const deferredBatches = Math.max(totalBatches - batches.length, 0);
  if (deferredBatches > 0 || distill.deferredTurns > 0) {
    options.logger.warn("maintenance_sweep_distill_cap_hit", {
      batch_size: distillBatchSize,
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
    distillTurnsDeferredByBatchCap: distill.deferredTurns,
    graphJobsEnqueued: graph.jobs.length,
    graphLimitReached: graph.limitReached,
  };
  options.logger.info("maintenance_sweep_complete", {
    distill_batches_selected: summary.distillBatchesSelected,
    distill_jobs_enqueued: summary.distillJobsEnqueued,
    distill_batches_deferred: summary.distillBatchesDeferred,
    distill_turns_deferred_by_batch_cap:
      summary.distillTurnsDeferredByBatchCap,
    graph_jobs_enqueued: summary.graphJobsEnqueued,
    graph_limit_reached: summary.graphLimitReached ? 1 : 0,
  });
  return summary;
}
