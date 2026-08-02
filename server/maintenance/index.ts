/**
 * Maintenance runtime boundary: the queue runner as a composed, ordered-shutdown
 * background runtime.
 *
 * Design authority: `_plans/463-server-rewrite-charter.md` Phase 5 names
 * "maintenance" as a gate the candidate must answer. `server/config/maintenance.ts`
 * already owns the four env reads. `server/application/index.ts` already owns
 * ordered shutdown through its `backgroundRuntimes` port. The piece between them
 * — the thing that actually CONSTRUCTS a runner and hands it to that port — did
 * not exist, so the port had no production supplier and every proof of ordered
 * shutdown ran against a fake runtime.
 *
 * WHAT THIS OWNS: composition and lifecycle adaptation. Constructing the durable
 * queue over the application's pool, composing the handler map, starting bounded
 * polling when the config enables it, and presenting the whole thing as one
 * `BackgroundRuntime` the application can stop in dependency order.
 *
 * WHAT THIS DELIBERATELY DOES NOT OWN: the lease semantics. `MaintenanceQueue`
 * and `MaintenanceQueueRunner` are imported from `src/`, not reimplemented here,
 * and that is the load-bearing decision in this module.
 *
 * WHY IMPORTING IS THE PORT, AND COPYING WOULD BE THE FORK. PR #494 declined to
 * port the runner because "reimplementing it here would fork the one component
 * whose failure mode is silent" — rows sitting `running` under a live lease with
 * no handler, and nothing erroring. That reasoning is preserved exactly, not
 * overridden: the fix for it is to have ONE implementation reachable from both
 * compositions, which is what this module does. Two copies would need the same
 * two lease invariants re-proven forever, and would drift precisely where drift
 * is invisible.
 *
 * The two invariants that must survive this port, both from the PR #350 /
 * issue #343 review swarm, and both proven through THIS boundary in
 * `maintenance.pg.test.ts` against a real database rather than assumed from the
 * fact that the import compiles:
 *
 *  1. STOP IS A DRAIN, NOT A CANCEL (`docs/sme/domain-backend.md`). A claim
 *     already in flight when `stop()` is called has leased rows in the database.
 *     Those rows are owned work: they must be dispatched and tracked, and
 *     `stop()` must await the in-flight tick before draining, or they sit
 *     `running` until lease expiry. This is why `stop()` on the returned runtime
 *     is `runner.stop()` and not a timer clear.
 *
 *  2. THE RETRY BOUND APPLIES TO THE EXPIRY PATH TOO (`docs/sme/correctness.md`).
 *     An expired `running` row that has already consumed `max_attempts`
 *     executions dead-letters inside the claim statement rather than being
 *     reclaimed forever.
 *
 * `src/maintenance-queue.ts` imports nothing but `pg` types, so reaching it from
 * here pulls in no `src/` composition — this is the same strangler-direction
 * import `server/config/nats.ts` and `server/tools/source-registry.ts` already
 * use, and it leaves the eventual `src/` retirement a file move rather than a
 * reconciliation of two divergent runners.
 */
import type pg from "pg";
import type { Logger } from "pino";
import type { ServerModuleBoundary } from "../module.ts";
import type { MaintenanceConfig } from "../config/maintenance.ts";
import type { BackgroundRuntime } from "../application/index.ts";
import {
  MaintenanceQueue,
  MaintenanceQueueRunner,
  type MaintenanceJobHandler,
  type MaintenanceQueueLogger,
} from "../../src/maintenance-queue.ts";

export const MAINTENANCE_BOUNDARY: ServerModuleBoundary = {
  name: "maintenance",
  owns: ["queue composition", "handler registration", "runner lifecycle"],
  excludes: ["lease semantics", "retry policy", "SQL", "handler behavior"],
};

/** The name this runtime reports in ordered-shutdown logs. */
export const MAINTENANCE_RUNTIME_NAME = "maintenance";

export interface MaintenanceRuntimeInput {
  readonly config: MaintenanceConfig;
  readonly logger: Logger;
  readonly pool: Pick<pg.Pool, "query" | "connect">;
  /**
   * The dispatch surface. A job kind absent from this map can never run, however
   * many jobs are enqueued under it, so registration is the whole contract
   * between an enqueuer and a worker.
   *
   * Passed IN rather than composed here: the handlers reach embedding providers,
   * the graph deriver, and the DREAM pipeline, each with its own auth identity
   * and its own reasons. This boundary owns the runner's lifecycle, not what the
   * jobs do.
   */
  readonly handlers: ReadonlyMap<string, MaintenanceJobHandler>;
  /**
   * Start polling immediately (default true). `false` composes the runtime
   * without a timer, which is what a test wants when it drives `runOnce()`
   * itself and needs the tick boundary to be deterministic.
   */
  readonly autoStart?: boolean;
}

/**
 * A composed maintenance runtime: the queue, the runner, and the
 * `BackgroundRuntime` adaptation the application shuts down.
 */
export interface MaintenanceRuntime extends BackgroundRuntime {
  readonly queue: MaintenanceQueue;
  readonly runner: MaintenanceQueueRunner;
}

/**
 * Adapt a pino logger to the queue's content-free logger shape.
 *
 * The queue logs `(message, fields)` where every field value is already a string
 * or number — it never passes an error object or a payload. Pino takes the
 * object first, so the two are swapped here and nothing else: no field is added,
 * renamed, or dropped, because the queue's field names are what its own log
 * assertions and any operator grep are written against.
 */
function queueLogger(logger: Logger): MaintenanceQueueLogger {
  return {
    info: (message, fields) => logger.info(fields, message),
    warn: (message, fields) => logger.warn(fields, message),
    error: (message, fields) => logger.error(fields, message),
  };
}

/**
 * Compose the maintenance queue runner as a background runtime.
 *
 * Returns `undefined` when the config disables maintenance for this process, so
 * a disabled worker composes NO runner at all rather than an idle one: an
 * opted-out process should hold no pool connection for polling and should emit
 * no maintenance lines. The caller spreads the result into `backgroundRuntimes`,
 * so "disabled" and "absent from the shutdown order" are the same state and
 * cannot disagree.
 *
 * The three tuning values are forwarded ONLY when the config supplies them.
 * `MaintenanceConfig` deliberately leaves them `undefined` rather than
 * defaulting, so that the runner stays the single owner of its own defaults;
 * passing an explicit `undefined` through would be equivalent here, but spelling
 * it as omission keeps that ownership visible at the call site. The runner
 * clamps whatever it receives to its own safe bounds regardless.
 */
export function createMaintenanceRuntime(
  input: MaintenanceRuntimeInput,
): MaintenanceRuntime | undefined {
  if (!input.config.enabled) {
    input.logger.info(
      { runtime: MAINTENANCE_RUNTIME_NAME },
      "maintenance_runtime_disabled",
    );
    return undefined;
  }

  const logger = queueLogger(input.logger);
  const queue = new MaintenanceQueue(input.pool);
  const runner = new MaintenanceQueueRunner({
    queue,
    handlers: input.handlers,
    logger,
    ...(input.config.concurrency !== undefined
      ? { concurrency: input.config.concurrency }
      : {}),
    ...(input.config.pollIntervalMs !== undefined
      ? { pollIntervalMs: input.config.pollIntervalMs }
      : {}),
    ...(input.config.leaseMs !== undefined
      ? { leaseMs: input.config.leaseMs }
      : {}),
  });

  // `start()` throws on an empty handler map rather than polling a queue whose
  // every claim would dead-letter as `unsupported_job_kind`. Let it throw: a
  // process composed with no handlers is mis-wired, and failing at startup is
  // strictly better than discovering it as a growing dead-letter table.
  if (input.autoStart !== false) runner.start();

  let stopped = false;
  return {
    name: MAINTENANCE_RUNTIME_NAME,
    queue,
    runner,
    // `runner.stop()` is a DRAIN (invariant 1 above): it awaits the in-flight
    // tick so any rows that tick's claim leased are tracked, then waits for
    // every tracked handler to finish. The application calls this BEFORE
    // closing the database, because a drain needs the pool to complete the work
    // it has already leased.
    //
    // Idempotent: the application stops each runtime once, but a shutdown path
    // that can be entered twice (a signal arriving during shutdown) must not
    // turn the second entry into a second drain.
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      await runner.stop();
    },
  };
}
