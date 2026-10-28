/**
 * Production bootstrap for the server-owned maintenance queue (#343 substrate,
 * #345 handler): `startMaintenanceQueue` builds the durable queue over the real
 * pool, registers the server-owned handlers, and starts bounded polling. The
 * recurring producer loop lives in `maintenance-sweep.ts` and is started by both
 * compositions.
 *
 * Registered kinds: embedding repair, graph.derive, memory.distill,
 * dream.light, dream.rem, and dream.route (issue 1525) -- the last ONLY when
 * the route config is enabled.
 *
 * Why this module exists, the missing-producer defect behind #384, and the #343
 * invariants this wiring preserves:
 * See docs/decisions/maintenance-bootstrap-queue-wiring.md
 */
import type pg from "pg";
import type { BackgroundTraceEmitter } from "../observability/background-tracing.ts";
import { generateEmbeddingWithMetadata } from "../embedding/provider.ts";
import type { EmbedWithMetaFn } from "../embedding/embedding-repair.ts";
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
import { DREAM_ROUTE_JOB_KIND, makeDreamRouteHandler } from "./dream-route.ts";
import type { RouteProducerConfig } from "../config/maintenance.ts";
import { createScheduledJevRemGrader } from "./rem-jev-grader.ts";
import type { JevConfig, JevFetch } from "../integrations/jev.ts";
import type { JevRemConfig } from "../config/env-groups.ts";
import {
  MEMORY_DISTILL_JOB_KIND,
  makeMemoryDistillHandler,
} from "./distill-handler.ts";
import { startRecurringMaintenanceSweep } from "./maintenance-sweep.ts";

/**
 * The server-owned identity the graph-derivation handler derives under: a global
 * maintenance identity that grants the cross-namespace write capability only —
 * the persisted job payload's namespace stays the authority.
 *
 * Why token-sourced, and why `tokenClientId` is the promoter id:
 * See docs/decisions/maintenance-bootstrap-graph-identity.md
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
  jevRem?: { config: JevRemConfig; fetchFn?: JevFetch };
  /** Issue 1618 B1: Jev candidate typing at distill; used only when enabled. */
  jevDistillType?: { config: JevConfig; fetchFn?: JevFetch };
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
  rem?: import("../config/maintenance.ts").RemProducerConfig;
  /** The scheduled DREAM route job; its handler registers only when enabled. */
  route?: RouteProducerConfig;
  readRemSignals?: () => Promise<
    import("./maintenance-sweep.ts").RemEligibilitySignals
  >;
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

/** The optional compose inputs `startMaintenanceQueue` forwards when set. */
function optionalComposeInputs(options: StartMaintenanceQueueOptions) {
  return {
    ...(options.jevRem ? { jevRem: options.jevRem } : {}),
    ...(options.jevDistillType ? { jevDistillType: options.jevDistillType } : {}),
    ...(options.route ? { route: options.route } : {}),
    ...(options.tracing ? { tracing: options.tracing } : {}),
  };
}

/** Issue 1618 B1: the distill handler gets Jev typing only when the flag is on. */
function enabledDistillJevType(
  jevDistillType: { config: JevConfig; fetchFn?: JevFetch } | undefined,
) {
  return jevDistillType?.config.enabled ? { jevType: jevDistillType } : {};
}

/** Sets the dream.route handler ONLY when the route config is enabled. */
function registerDreamRoute(
  handlers: Map<string, MaintenanceJobHandler>,
  input: {
    pool: pg.Pool;
    logger: MaintenanceQueueLogger;
    jevRem?: { config: JevConfig; fetchFn?: JevFetch };
    route?: RouteProducerConfig;
  },
): void {
  if (input.route?.enabled) {
    handlers.set(
      DREAM_ROUTE_JOB_KIND,
      makeDreamRouteHandler({
        pool: input.pool,
        logger: input.logger,
        route: input.route,
        ...(input.jevRem ? { jev: input.jevRem } : {}),
      }),
    );
  }
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
  jevRem?: { config: JevRemConfig; fetchFn?: JevFetch };
  jevDistillType?: { config: JevConfig; fetchFn?: JevFetch };
  route?: RouteProducerConfig;
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
  // makeDreamLightHandler have existed since #390 (./dream-light.ts)
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
      ...enabledDistillJevType(input.jevDistillType),
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
      ...(input.jevRem?.config.enabled
        ? {
            graderFactory: (trace) => {
              const jevRem = input.jevRem;
              if (!jevRem) throw new Error("enabled REM Jev config is missing");
              return createScheduledJevRemGrader({
                config: jevRem.config,
                ...(jevRem.fetchFn ? { fetchFn: jevRem.fetchFn } : {}),
                logger: input.logger,
                trace,
              });
            },
          }
        : {}),
      ...(input.tracing ? { tracing: input.tracing } : {}),
    }),
  );

  // dream.route (issue 1525) is registered ONLY when its config is enabled:
  // with no handler the kind can never be claimed, so a disabled route is
  // inert even if a job were enqueued under it.
  registerDreamRoute(handlers, input);

  // Deep (#394) is deliberately ABSENT. It is a read-only bundle builder whose
  // output is a page an operator reads (./dream-deep.ts), so there is nothing
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
  // embedding handler: it defaults to the configured embeddingModel and
  // endpoint, matching the live write path.
  const handlers = composeMaintenanceHandlers({
    pool: options.pool,
    logger: options.logger,
    embedFn: options.embedFn ?? generateEmbeddingWithMetadata,
    graphAuth: options.graphAuth ?? MAINTENANCE_GRAPH_AUTH,
    ...optionalComposeInputs(options),
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
        ...(options.rem ? { rem: options.rem } : {}),
        ...(options.readRemSignals ? { readRemSignals: options.readRemSignals } : {}),
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
