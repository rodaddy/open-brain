/**
 * DREAM route -- the scheduled `dream.route` maintenance job (issue 1525).
 *
 * Reads the oldest embedded top-level candidates that carry no routing
 * decision, asks the V2 router where each belongs, and in ONE transaction
 * stores the run history (`routing_runs`, `routing_decisions`) and applies
 * each decision. The flow mirrors `runDreamRoute` in
 * `scripts/dream-route-run.ts`, but over the public tables, with the V2
 * router, and with no frozen cohort: the unrouted slice IS the cohort.
 *
 * Nothing here enqueues a job. Registration happens in
 * `maintenance-bootstrap.ts`, and only when the route config is enabled.
 */

import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { JevAnswer, JevConfig, JevFetch } from "../integrations/jev.ts";
import type { RouteProducerConfig } from "../config/maintenance.ts";
import {
  claimUnrouted,
  readUnroutedSlice,
  writeRoutingRun,
  type RoutingDecisionRecord,
} from "../db/dream-route-repository.ts";
import { applyRoutedDecision } from "../db/dream-route-apply-repository.ts";
import { withTransaction } from "../db/transaction.ts";
import {
  candidateOf,
  fakeJevFetch,
  orderForBatches,
  projectCost,
  recordOfV2,
  splitPlan,
  USD_PER_MILLION_INPUT_TOKENS,
  wouldApply,
  type WouldApply,
} from "../domain/dream-route/run-core.ts";
import {
  fakeConfig,
  noSignalDecision,
  planWithDrops,
  runLanes,
  type LaneOutcome,
} from "../domain/dream-route/run-execute.ts";
import {
  DEFAULT_THRESHOLDS_V2,
  decideRouteV2,
} from "../domain/dream-route/decide-v2.ts";
import { buildRouteClassifierSetV2 } from "../domain/dream-route/questions-v2.ts";
import { DEFAULT_MATRIX_PATH, loadMatrix } from "../domain/dream-route/matrix.ts";
import type {
  CandidateSnapshot,
  FrozenRow,
  RouteDecision,
  RouteMatrix,
} from "../domain/dream-route/types.ts";
import { MaintenanceTerminalError } from "./maintenance-job.ts";
import type {
  MaintenanceJobHandler,
  MaintenanceQueueLogger,
} from "./maintenance-queue-runner.ts";

/** The job kind this stage registers under. Matches the queue's kind regex. */
export const DREAM_ROUTE_JOB_KIND = "dream.route" as const;
/** Payload contract version. Bump only on an incompatible payload change. */
export const DREAM_ROUTE_JOB_VERSION = 1 as const;

/**
 * Concurrent sub-plans per run. The manual script's default in-flight value:
 * `parseInFlight` in `scripts/dream-route-run.ts` returns 8 when
 * `--in-flight` is absent.
 */
export const IN_FLIGHT = 8;

/** The enqueue request for one scheduled route pass, shaped like REM's. */
export function buildDreamRouteEnqueue(input: {
  sweepLabel: string;
  namespace?: string;
  batchSize?: number;
}) {
  const payload: Record<string, unknown> = {};
  if (input.batchSize !== undefined) payload.batch_size = input.batchSize;

  return {
    kind: DREAM_ROUTE_JOB_KIND,
    version: DREAM_ROUTE_JOB_VERSION,
    payload,
    idempotencyKey: `${DREAM_ROUTE_JOB_KIND}:${input.sweepLabel}`.slice(0, 200),
    ...(input.namespace !== undefined ? { scope: { namespace: input.namespace } } : {}),
  };
}

export interface DreamRouteHandlerDeps {
  pool: pg.Pool;
  logger: MaintenanceQueueLogger;
  route: Extract<RouteProducerConfig, { enabled: true }>;
  jev?: { config: JevConfig; fetchFn?: JevFetch };
  now?: () => number;
  /**
   * The namespace the slice is read from. Production passes nothing and
   * routes every namespace; the live-Postgres suite scopes it to its own.
   */
  namespace?: string;
}

const EMPTY_OUTCOME: LaneOutcome = {
  answers: new Map<string, Record<string, JevAnswer>>(),
  servedModels: new Map<string, string>(),
  inputTokens: 0,
  failures: new Map<string, string>(),
};

function backendOf(deps: DreamRouteHandlerDeps): {
  config: JevConfig;
  fetchFn: JevFetch;
} {
  if (deps.route.backend === "fake") {
    return { config: fakeConfig(), fetchFn: fakeJevFetch() };
  }
  // The route's own enabled flag plus `backend: jev` is the consent; REM's
  // enable flag is deliberately not inherited, as the manual script says.
  if (deps.jev === undefined) {
    throw new MaintenanceTerminalError("dream.route backend jev has no Jev config");
  }
  return {
    config: { ...deps.jev.config, enabled: true },
    fetchFn: deps.jev.fetchFn ?? fetch,
  };
}

function frozenRowsOf(snapshots: readonly CandidateSnapshot[]): FrozenRow[] {
  return snapshots.map((snapshot, ordinal) => ({
    ordinal,
    candidateId: snapshot.id,
    namespace: snapshot.namespace,
    contentHash: snapshot.content_hash,
    source: "draw",
    neighbourOf: null,
    snapshot,
  }));
}

interface Routed {
  readonly row: FrozenRow;
  readonly decision: RouteDecision;
  readonly action: WouldApply["action"];
  readonly servedModel: string | null;
}

function decideRows(args: {
  rows: readonly FrozenRow[];
  matrix: RouteMatrix;
  outcome: LaneOutcome;
  dropped: ReadonlyMap<string, string>;
}): Routed[] {
  return args.rows.map((row) => {
    const candidate = candidateOf(row);
    const failure =
      args.dropped.get(row.candidateId) ?? args.outcome.failures.get(row.candidateId);
    const decided = decideRouteV2(
      candidate,
      args.outcome.answers.get(row.candidateId) ?? {},
      args.matrix,
      DEFAULT_THRESHOLDS_V2,
    );
    const decision =
      failure === undefined
        ? decided
        : noSignalDecision(candidate, failure, decided.authorityTier);
    return {
      row,
      decision,
      action: wouldApply(decision, row, args.matrix).action,
      servedModel: args.outcome.servedModels.get(row.candidateId) ?? null,
    };
  });
}

function recordOfRouted(entry: Routed): RoutingDecisionRecord {
  return {
    candidateId: entry.row.candidateId,
    namespace: entry.row.namespace,
    destination: entry.decision.destination,
    agreement: entry.decision.agreement,
    authorityTier: entry.decision.authorityTier,
    restates: entry.decision.restates,
    droveDecision: entry.decision.droveDecision,
    reasons: entry.decision.reasons,
    raw: entry.decision.raw,
    servedModel: entry.servedModel,
  };
}

async function applyAll(
  client: pg.PoolClient,
  runId: string,
  kept: readonly Routed[],
): Promise<string[]> {
  const applied: string[] = [];
  for (const entry of kept) {
    const result = await applyRoutedDecision({
      client,
      runId,
      candidate: entry.row.snapshot,
      action: entry.action,
    });
    applied.push(result.outcome);
  }
  return applied;
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key}=${count}`)
    .join(",");
}

/**
 * Builds the `dream.route` handler.
 *
 * @param deps - Pool, content-free logger, the enabled route config, the Jev
 *   config for the paid backend, and an optional clock.
 * @returns The queue handler. It throws `MaintenanceTerminalError` when the
 *   paid backend has no config or the projected spend is over the run maximum,
 *   both before any request is sent.
 */
export function makeDreamRouteHandler(
  deps: DreamRouteHandlerDeps,
): MaintenanceJobHandler {
  const now = deps.now ?? (() => Date.now());
  return async () => {
    const started = now();
    const snapshots = await readUnroutedSlice({
      db: deps.pool,
      namespace: deps.namespace ?? null,
      sliceSize: deps.route.sliceSize,
    });
    if (snapshots.length === 0) {
      deps.logger.info("dream_route_nothing_to_route", { records: 0 });
      return;
    }

    const ordered = orderForBatches(frozenRowsOf(snapshots));
    const records = ordered.map((row) => recordOfV2(candidateOf(row)));
    const matrix = loadMatrix(DEFAULT_MATRIX_PATH);
    const classifierSet = buildRouteClassifierSetV2(matrix);
    const { config, fetchFn } = backendOf(deps);

    const { plan, dropped } = planWithDrops(records, classifierSet, config, (line) =>
      deps.logger.info("dream_route_adjusted", { line }),
    );
    const cost = projectCost(plan);
    if (cost.estimatedUsd > deps.route.maxUsdPerRun) {
      throw new MaintenanceTerminalError(
        `dream.route projected $${cost.estimatedUsd.toFixed(6)} over max ` +
          `$${deps.route.maxUsdPerRun.toFixed(6)}; nothing sent`,
      );
    }

    const outcome =
      plan.batches.length === 0
        ? EMPTY_OUTCOME
        : await runLanes(config, splitPlan(plan, IN_FLIGHT), fetchFn);
    const routed = decideRows({
      rows: ordered,
      matrix,
      outcome,
      dropped: new Map(dropped.map((entry) => [entry.key, entry.reason])),
    });

    const runId = randomUUID();
    const actualUsd = (outcome.inputTokens * USD_PER_MILLION_INPUT_TOKENS) / 1_000_000;
    const written = await withTransaction({
      pool: deps.pool,
      run: async (client) => {
        const unclaimed = await claimUnrouted({
          client,
          candidateIds: routed.map((entry) => entry.row.candidateId),
        });
        const kept = routed.filter((entry) => unclaimed.has(entry.row.candidateId));
        if (kept.length === 0) return null;
        await writeRoutingRun({
          client,
          runId,
          run: {
            matrixFingerprint: matrix.fingerprint,
            classifierVersion: classifierSet.version,
            thresholds: DEFAULT_THRESHOLDS_V2,
            backend: deps.route.backend,
            servedModels: [...new Set(outcome.servedModels.values())].sort(),
            records: kept.length,
            requests: plan.batches.length,
            inputTokens: outcome.inputTokens,
            estimatedUsd: cost.estimatedUsd,
            actualUsd,
            ms: now() - started,
            note: "scheduled",
          },
          decisions: kept.map(recordOfRouted),
        });
        return { kept, applied: await applyAll(client, runId, kept) };
      },
    });

    if (written === null) {
      deps.logger.info("dream_route_raced", { records: routed.length });
      return;
    }
    const { kept, applied: outcomes } = written;
    const raced = routed.length - kept.length;
    deps.logger.info("dream_route_run", {
      run_id: runId,
      records: kept.length,
      requests: plan.batches.length,
      estimated_usd: cost.estimatedUsd,
      actual_usd: actualUsd,
      by_action: countBy(kept, (entry) => entry.action),
      by_outcome: countBy(outcomes, (outcome) => outcome),
      ...(raced > 0 ? { raced } : {}),
    });
  };
}
