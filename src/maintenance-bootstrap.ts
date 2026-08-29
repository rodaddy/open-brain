// L5 adapter (issue 864): legacy call form over server/maintenance/maintenance-bootstrap.ts; retired with src/ at L6.
//
// The server/ module takes every tuning value on its options object, filled by
// server/main.ts from server/config.ts. The legacy src/index.ts callers do not
// hold a config object, so this adapter keeps the old call form: it reads the
// env overrides at call time and folds them into the options it forwards. It
// also keeps `maintenanceQueueEnabled`, which is an env predicate with no
// server/ caller.
import {
  startMaintenanceQueue as startMaintenanceQueueWithOptions,
  type MaintenanceRuntime,
  type StartMaintenanceQueueOptions,
} from "../server/maintenance/maintenance-bootstrap.ts";

export {
  MAINTENANCE_GRAPH_AUTH,
  composeMaintenanceHandlers,
} from "../server/maintenance/maintenance-bootstrap.ts";
export type {
  MaintenanceRuntime,
  StartMaintenanceQueueOptions,
} from "../server/maintenance/maintenance-bootstrap.ts";

/**
 * Parse a positive integer env override, falling back when unset or invalid.
 * Non-positive / non-numeric values fall back rather than surprising the runner;
 * the runner still clamps whatever it receives to its own safe bounds.
 */
function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Whether the maintenance queue should run in this process. Enabled by default;
 * `OPEN_BRAIN_MAINTENANCE_ENABLED=0` (or `false`) turns it off so a worker that
 * must not poll (e.g. a read replica) can opt out without code changes.
 */
export function maintenanceQueueEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OPEN_BRAIN_MAINTENANCE_ENABLED?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

/** Legacy call form: explicit options win, then env, then the module default. */
export function startMaintenanceQueue(
  options: StartMaintenanceQueueOptions,
): MaintenanceRuntime {
  const overrides: Record<string, number | undefined> = {
    pollIntervalMs:
      options.pollIntervalMs ?? envPositiveInt("OPEN_BRAIN_MAINTENANCE_POLL_MS"),
    concurrency:
      options.concurrency ?? envPositiveInt("OPEN_BRAIN_MAINTENANCE_CONCURRENCY"),
    leaseMs: options.leaseMs ?? envPositiveInt("OPEN_BRAIN_MAINTENANCE_LEASE_MS"),
    distillBatchSize:
      options.distillBatchSize ??
      envPositiveInt("OPEN_BRAIN_MAINTENANCE_DISTILL_BATCH_SIZE"),
    maxDistillBatchesPerTick:
      options.maxDistillBatchesPerTick ??
      envPositiveInt("OPEN_BRAIN_MAINTENANCE_MAX_DISTILL_BATCHES"),
    graphDerivationLimit:
      options.graphDerivationLimit ??
      envPositiveInt("OPEN_BRAIN_MAINTENANCE_GRAPH_LIMIT"),
  };
  const resolved = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  return startMaintenanceQueueWithOptions({ ...options, ...resolved });
}
