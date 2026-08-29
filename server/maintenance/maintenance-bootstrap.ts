/**
 * Production bootstrap for the server-owned maintenance queue (#343 substrate,
 * #345 handler). This is the piece that was missing: `buildEmbeddingRepairHandlers`
 * and `MaintenanceQueueRunner` both existed, but nothing in the running server
 * constructed the durable queue, registered the handler, or started polling — so
 * an enqueued `embedding.repair` job could never actually run in production.
 *
 * `startMaintenanceQueue` constructs the durable `MaintenanceQueue` over the real
 * pool, composes the server-owned handler map (embedding-repair #345 +
 * graph-derivation #346, the latter under an explicit global maintenance
 * identity) with the real embed provider and a content-free logger, and starts
 * the runner's bounded automatic polling. The returned handle exposes `stop()`,
 * which the server's shutdown path awaits before `pool.end()` so in-flight jobs
 * drain (their leases are honored) instead of being stranded mid-run.
 *
 * The bootstrap also starts the missing recurring producer from #384. Each
 * producer tick selects lane-owned undistilled work for memory.distill and reuses
 * enqueueGraphDerivationJobs for changed source hashes. The producer is
 * single-flight, uses configured batch bounds, and stops before the runner drains
 * so shutdown cannot add work after polling has halted.
 *
 * THE PRODUCER LOOP ITSELF NOW LIVES IN `maintenance-sweep.ts`, not here. This
 * bootstrap is reached from the LEGACY `src/index.ts` through the L5 adapter at
 * `src/maintenance-bootstrap.ts`, which supplies the env-derived values; the serving
 * entrypoint since the Phase 6 cutover is `server/main.ts`, which composes
 * maintenance through `server/maintenance/index.ts`. While the loop was private
 * to this file, only one of those two compositions produced any work at all, so
 * the serving process polled a queue nothing filled — #384's symptom, surviving
 * the PR that added the producer. Both compositions now start the same loop.
 *
 * #343 invariants preserved verbatim — this only wires them, it changes none:
 *  - Bounded concurrency: the runner clamps to [1, MAX_CONCURRENCY].
 *  - No overlapping ticks: `runOnce` is single-flight; `start()` reuses it.
 *  - Persisted retries/backoff: owned by `MaintenanceQueue.fail`, durable-row-derived.
 *  - Content-free logs: handlers, runner, and producer log counts/kinds only.
 *  - No Dream/MCP mutation path: the producer writes only durable maintenance
 *    jobs. Distill jobs bind the selected lane and namespace; graph jobs retain
 *    the source snapshot and namespace checks owned by their existing producer.
 */
import type pg from "pg";
import type { BackgroundTraceEmitter } from "../application/background-tracing.ts";
import { generateEmbeddingWithMetadata } from "../../src/embedding.ts";
import type { EmbedWithMetaFn } from "../../src/embedding-repair.ts";
import type { AuthInfo } from "../types.ts";
import { MaintenanceQueue } from "./maintenance-queue.ts";
import {
  MaintenanceQueueRunner,
  type MaintenanceJobHandler,
  type MaintenanceQueueLogger,
} from "./maintenance-queue-runner.ts";
import { buildEmbeddingRepairHandlers } from "./embedding-repair-handler.ts";
import {
  GRAPH_DERIVATION_JOB_KIND,
  makeGraphDerivationHandler,
} from "./graph-derivation-handler.ts";
import { DREAM_LIGHT_JOB_KIND, makeDreamLightHandler } from "./dream-light.ts";
import { DREAM_REM_JOB_KIND, makeDreamRemHandler } from "./dream-rem.ts";
import {
  MEMORY_DISTILL_JOB_KIND,
  makeMemoryDistillHandler,
} from "./distill-handler.ts";
import { startRecurringMaintenanceSweep } from "./maintenance-sweep.ts";

/**
 * The deliberate, server-owned identity the graph-derivation handler derives
 * under. It is a global maintenance identity (ob-admin, token-sourced) so the
 * handler can write into whatever namespace a claimed job carries — but it is
 * NOT the namespace authority: the persisted job payload's namespace remains the
 * exact authority, and the handler re-checks canWriteNamespace against it AND
 * re-validates it against the live source row before deriving. This identity
 * only grants the cross-namespace write capability a maintenance sweep needs; it
 * grants no bypass of the per-job namespace/source guards.
 *
 * `namespaceSource: "token"` is required: a "header"-sourced identity would pin
 * every write to a single clientId namespace and could not serve jobs across
 * namespaces.
 *
 * `tokenClientId: "openbrain-promoter"` satisfies the EXISTING shared-kb write
 * convention (namespace-policy.ts: canWriteNamespace gates shared-kb writes on
 * isPromoterIdentity, which recognizes an admin/ob-admin token whose
 * `tokenClientId ?? clientId` is in PROMOTER_CLIENT_IDS). Without it, a claimed
 * shared-kb graph.derive job fails canWriteNamespace and terminal-dead-letters,
 * even though ob-admin holds global maintenance capability everywhere else. The
 * `clientId` stays the fixed maintenance label used for logging/provenance; only
 * the promoter-convention check reads `tokenClientId`, so this narrowly grants
 * the shared-kb write capability without weakening canWriteNamespace or adding a
 * bypass — the per-job namespace and source-snapshot guards remain the authority.
 */
export const MAINTENANCE_GRAPH_AUTH: AuthInfo = {
  role: "ob-admin",
  clientId: "open-brain-maintenance",
  tokenClientId: "openbrain-promoter",
  namespaceSource: "token",
};

/**
 * Runtime handle for the started maintenance queue. `stop()` halts polling and
 * drains in-flight jobs; it is idempotent and safe to call once from shutdown.
 */
export interface MaintenanceRuntime {
  readonly queue: MaintenanceQueue;
  readonly runner: MaintenanceQueueRunner;
  stop(): Promise<void>;
}

export interface StartMaintenanceQueueOptions {
  pool: pg.Pool;
  /** Content-free logger; the app logger satisfies this shape. */
  logger: MaintenanceQueueLogger;
  /** Injectable embed fn for tests; defaults to the configured provider. */
  embedFn?: EmbedWithMetaFn;
  /** Process-owned background tracing emitter; omitted when tracing is disabled. */
  tracing?: BackgroundTraceEmitter;
  /** Poll cadence, supplied by the caller from config; else the 5s default. */
  pollIntervalMs?: number;
  /** Concurrency, supplied by the caller from config; else the runner default. */
  concurrency?: number;
  /** Lease duration, supplied by the caller from config; else the runner default. */
  leaseMs?: number;
  /** Maximum turns assigned to one memory.distill job. */
  distillBatchSize?: number;
  /** Maximum memory.distill jobs produced by one recurring sweep. */
  maxDistillBatchesPerTick?: number;
  /** Maximum graph.derive jobs produced by one recurring sweep. */
  graphDerivationLimit?: number;
  /** Start automatic polling and recurring production immediately (default true). */
  autoStart?: boolean;
  /**
   * The server-owned identity the graph-derivation handler derives under.
   * Defaults to {@link MAINTENANCE_GRAPH_AUTH}. Injectable for tests; must carry
   * a concrete role/clientId — a handler cannot be registered without a clear
   * auth identity (see composeMaintenanceHandlers).
   */
  graphAuth?: AuthInfo;
}

/**
 * Compose the server-owned maintenance handler map without a second bootstrap or
 * framework: start from the #345 embedding-repair map and register the #346
 * graph-derivation handler under its kind. Both handlers share the runner's
 * content-free logger and the same pool.
 *
 * The graph handler CANNOT be registered without a clear auth identity: a
 * missing role or clientId throws before any handler is built, so a mis-wired
 * bootstrap fails closed at startup instead of dispatching graph jobs under an
 * ambiguous identity. The identity grants only the cross-namespace write
 * capability the sweep needs; the per-job namespace and source-snapshot guards
 * inside the handler remain the authority.
 */
export function composeMaintenanceHandlers(input: {
  pool: pg.Pool;
  logger: MaintenanceQueueLogger;
  embedFn: EmbedWithMetaFn;
  graphAuth: AuthInfo;
  tracing?: BackgroundTraceEmitter;
}): ReadonlyMap<string, MaintenanceJobHandler> {
  if (!input.graphAuth.role || !input.graphAuth.clientId) {
    throw new Error(
      "maintenance bootstrap requires a graph-derivation auth identity with a role and clientId",
    );
  }

  const handlers = new Map<string, MaintenanceJobHandler>(
    buildEmbeddingRepairHandlers({
      db: input.pool,
      logger: input.logger,
      embedFn: input.embedFn,
      ...(input.tracing ? { tracing: input.tracing } : {}),
    }),
  );
  handlers.set(
    GRAPH_DERIVATION_JOB_KIND,
    makeGraphDerivationHandler({
      pool: input.pool,
      auth: input.graphAuth,
    }),
  );

  // The DREAM pipeline: distill -> light -> rem. Registered here because this
  // Map is the only dispatch surface -- a kind that is not in it can never be
  // claimed, however many jobs are enqueued under it.
  //
  // THIS CLOSES A LIVE WIRING GAP. DREAM_LIGHT_JOB_KIND and
  // makeDreamLightHandler have existed since #390 (src/dream-light.ts:58, :374)
  // and were referenced nowhere outside their own module and test -- so
  // `dream.light` jobs could be enqueued, would be claimed by no handler, and
  // would burn their retries into the dead-letter state. Light only ever ran
  // through the manual entrypoint scripts/dream-light-run.ts.
  //
  // NONE OF THESE ENQUEUE ANYTHING. Registration is dispatch only. The
  // recurring producer starts below after this map and the durable queue exist;
  // manual DREAM cycles remain available through scripts/dream-cycle.ts.
  handlers.set(
    MEMORY_DISTILL_JOB_KIND,
    makeMemoryDistillHandler({
      pool: input.pool,
      logger: input.logger,
      embedFn: input.embedFn,
      auth: input.graphAuth,
      ...(input.tracing ? { tracing: input.tracing } : {}),
    }),
  );
  handlers.set(
    DREAM_LIGHT_JOB_KIND,
    makeDreamLightHandler({
      pool: input.pool,
      logger: input.logger,
      ...(input.tracing ? { tracing: input.tracing } : {}),
    }),
  );
  handlers.set(
    DREAM_REM_JOB_KIND,
    makeDreamRemHandler({
      pool: input.pool,
      logger: input.logger,
      ...(input.tracing ? { tracing: input.tracing } : {}),
    }),
  );

  // Deep (#394) is deliberately ABSENT. It is a read-only bundle builder whose
  // output is a page an operator reads (src/dream-deep.ts), so there is nothing
  // for a background worker to dispatch -- registering it would create a job
  // kind whose only effect is to compute a result and discard it.
  return handlers;
}

/**
 * Construct the durable queue + runner, register the embedding-repair handler,
 * and (by default) start bounded automatic polling. Caller owns `stop()` in its
 * shutdown lifecycle.
 *
 * Every tuning value arrives on `options`, read from `server/config.ts` by the
 * caller (`parseMaintenanceConfig` owns the env contract). Each is clamped again
 * by the runner and the sweep, which stay the single owners of their defaults.
 */
export function startMaintenanceQueue(
  options: StartMaintenanceQueueOptions,
): MaintenanceRuntime {
  const queue = new MaintenanceQueue(options.pool);
  // Compose the server-owned handler map: embedding.repair (#345) +
  // graph.derive (#346), the latter under an explicit global maintenance
  // identity. currentModel / embeddingUrl are intentionally omitted from the
  // embedding handler: it defaults to the configured EMBEDDING_MODEL and
  // endpoint, matching the live write path.
  const handlers = composeMaintenanceHandlers({
    pool: options.pool,
    logger: options.logger,
    embedFn: options.embedFn ?? generateEmbeddingWithMetadata,
    graphAuth: options.graphAuth ?? MAINTENANCE_GRAPH_AUTH,
    ...(options.tracing ? { tracing: options.tracing } : {}),
  });

  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const runner = new MaintenanceQueueRunner({
    queue,
    handlers,
    logger: options.logger,
    concurrency: options.concurrency,
    pollIntervalMs,
    leaseMs: options.leaseMs,
  });

  const autoStart = options.autoStart !== false;
  if (autoStart) runner.start();
  const sweep = autoStart
    ? startRecurringMaintenanceSweep({
        pool: options.pool,
        queue,
        logger: options.logger,
        intervalMs: pollIntervalMs,
        distillBatchSize: options.distillBatchSize,
        maxDistillBatchesPerTick: options.maxDistillBatchesPerTick,
        graphDerivationLimit: options.graphDerivationLimit,
      })
    : null;

  let stopped = false;
  return {
    queue,
    runner,
    async stop(): Promise<void> {
      // runner.stop() is safe even if start() was never called (null interval,
      // null tick, empty active set). Guard only against a double shutdown call.
      if (stopped) return;
      stopped = true;
      await sweep?.stop();
      await runner.stop();
    },
  };
}
