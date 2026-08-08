/**
 * Maintenance queue runtime settings, owned by the config layer.
 *
 * Design authority: `_plans/463-server-rewrite-charter.md` section 3 puts ALL
 * env parsing in `server/config/`. The behavior preserved is
 * `src/maintenance-bootstrap.ts`'s `maintenanceQueueEnabled` and the three
 * `envPositiveInt` reads that feed `MaintenanceQueueRunner`.
 *
 * SCOPE. This module owns the SETTINGS ONLY. The queue, the runner, and the
 * handler map stay where they are: the runner's stop path is a DRAIN with a
 * lease-boundary rule that took a review swarm to get right
 * (`docs/sme/domain-backend.md`, PR #350 / issue #343 -- a stop observed
 * between a claim committing its leases and those jobs being tracked abandons
 * leased rows until lease expiry). Reimplementing that here to "complete the
 * rewrite" would fork the one component whose failure mode is invisible: rows
 * sit `running` with a live lease and nothing errors.
 *
 * ENABLED BY DEFAULT. `OPEN_BRAIN_MAINTENANCE_ENABLED=0`/`false` opts a process
 * out, so a worker that must not poll can be configured rather than patched.
 * Absent means ON, matching current behavior -- the inverse default would
 * silently stop maintenance everywhere the variable is unset, which is
 * everywhere.
 */

export interface MaintenanceConfig {
  readonly enabled: boolean;
  /**
   * Absent means "the runner's own default", not zero. These are deliberately
   * `undefined` rather than defaulted here so one owner keeps the defaults:
   * duplicating them would let config and runner disagree, and the runner would
   * silently win.
   */
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly leaseMs?: number;
  /**
   * Producer bounds (#384). Absent means "the sweep's own default", for the
   * same single-owner reason as the runner knobs above: `maintenance-sweep.ts`
   * clamps every one of these to its own safe maximum, so re-defaulting them
   * here would create a second opinion that the sweep silently overrides.
   */
  readonly distillBatchSize?: number;
  readonly maxDistillBatchesPerTick?: number;
  readonly graphDerivationLimit?: number;
}

type Environment = Record<string, string | undefined>;

/**
 * Read a positive integer, or `undefined` when unset, blank, or unusable.
 *
 * A non-numeric or non-positive value reads as absent rather than throwing,
 * which is the current behavior: the runner then applies its own default and
 * the process still starts. Failing startup on a typo in an optional tuning
 * knob would be a behavior change this rewrite is not authorized to make.
 */
function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseMaintenanceConfig(
  environment: Environment,
): MaintenanceConfig {
  const raw = environment.OPEN_BRAIN_MAINTENANCE_ENABLED?.trim().toLowerCase();
  const concurrency = positiveInteger(
    environment.OPEN_BRAIN_MAINTENANCE_CONCURRENCY,
  );
  const pollIntervalMs = positiveInteger(
    environment.OPEN_BRAIN_MAINTENANCE_POLL_MS,
  );
  const leaseMs = positiveInteger(environment.OPEN_BRAIN_MAINTENANCE_LEASE_MS);
  const distillBatchSize = positiveInteger(
    environment.OPEN_BRAIN_MAINTENANCE_DISTILL_BATCH_SIZE,
  );
  const maxDistillBatchesPerTick = positiveInteger(
    environment.OPEN_BRAIN_MAINTENANCE_MAX_DISTILL_BATCHES,
  );
  const graphDerivationLimit = positiveInteger(
    environment.OPEN_BRAIN_MAINTENANCE_GRAPH_LIMIT,
  );
  return {
    enabled: raw !== "0" && raw !== "false",
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
    ...(leaseMs !== undefined ? { leaseMs } : {}),
    ...(distillBatchSize !== undefined ? { distillBatchSize } : {}),
    ...(maxDistillBatchesPerTick !== undefined
      ? { maxDistillBatchesPerTick }
      : {}),
    ...(graphDerivationLimit !== undefined ? { graphDerivationLimit } : {}),
  };
}
