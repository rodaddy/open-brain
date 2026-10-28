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
  readonly rem?: RemProducerConfig;
  /** The scheduled DREAM route job (issue 1525). */
  readonly route?: RouteProducerConfig;
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

export type RemProducerConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly backlogHighWater: number;
      readonly maxRequestsPerMinute: number;
      readonly minHeadroomBytes: number;
      readonly forcedSliceSize: number;
      readonly minGapMs: number;
    };

export type RouteProducerConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly backend: "fake" | "jev";
      readonly sliceSize: number;
      readonly minGapMs: number;
      readonly maxUsdPerRun: number;
    };

export class MaintenanceConfigError extends Error {
  readonly path: string;

  constructor(message: string, path = "OPEN_BRAIN_MAINTENANCE_REM") {
    super(message);
    this.path = path;
  }
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

/** New REM knobs have no legacy fallback: malformed explicit input is invalid. */
function strictPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const MAX_REM_FORCED_SLICE_SIZE = 300;
// Operator ruling 2026-09-25 (issue 1488): REM must not hammer the database, so
// runs keep a minimum gap. Default 15 min; 0 disables; maximum 6 h.
const DEFAULT_REM_MIN_GAP_MS = 900_000;
const MAX_REM_MIN_GAP_MS = 6 * 60 * 60 * 1000;

// Issue 1525: the route default gap is 60 s per operator ruling 2026-09-26,
// superseding the REM-like 1 h pacing of 2026-09-25 for the route only: 2x the
// measured real peak needs about 3,810 candidates/hour and a 200-candidate
// slice per hour cannot carry it. REM's own gap is unchanged. Off by default;
// enabling it on dogfood needs Dana's go.
const MAX_ROUTE_SLICE_SIZE = 200;
const DEFAULT_ROUTE_MIN_GAP_MS = 60_000;
const MAX_ROUTE_MIN_GAP_MS = 86_400_000;
const MAX_ROUTE_USD_PER_RUN = 1;

/** Unset means the default; explicit input must be an integer in [0, maxMs]. */
function minGapMs(
  value: string | undefined,
  defaultMs: number,
  maxMs: number,
): number | undefined {
  if (value === undefined || value.trim() === "") return defaultMs;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maxMs
    ? parsed
    : undefined;
}

function parseRemProducerConfig(environment: Environment): RemProducerConfig {
  if (environment.OPEN_BRAIN_MAINTENANCE_REM_ENABLED !== "1") {
    return { enabled: false };
  }
  const values = {
    backlogHighWater: strictPositiveInteger(
      environment.OPEN_BRAIN_MAINTENANCE_REM_BACKLOG_HIGH_WATER,
    ),
    maxRequestsPerMinute: strictPositiveInteger(
      environment.OPEN_BRAIN_MAINTENANCE_REM_MAX_REQUESTS_PER_MINUTE,
    ),
    minHeadroomBytes: strictPositiveInteger(
      environment.OPEN_BRAIN_MAINTENANCE_REM_MIN_HEADROOM_BYTES,
    ),
    forcedSliceSize: strictPositiveInteger(
      environment.OPEN_BRAIN_MAINTENANCE_REM_FORCED_SLICE_SIZE,
    ),
    minGapMs: minGapMs(
      environment.OPEN_BRAIN_MAINTENANCE_REM_MIN_GAP_MS,
      DEFAULT_REM_MIN_GAP_MS,
      MAX_REM_MIN_GAP_MS,
    ),
  };
  const complete = Object.values(values).every((value) => value !== undefined);
  if (!complete || (values.forcedSliceSize ?? Infinity) > MAX_REM_FORCED_SLICE_SIZE) {
    throw new MaintenanceConfigError(
      "REM configuration requires explicit positive integers for backlog high-water, max requests per minute, minimum headroom bytes, and forced slice size (maximum 300), and an optional minimum gap of 0 to 21600000 ms",
    );
  }
  return {
    enabled: true,
    ...(values as Omit<RemProducerConfig & { enabled: true }, "enabled">),
  };
}

function parseRouteBackend(value: string | undefined): "fake" | "jev" | undefined {
  const trimmed = value?.trim();
  return trimmed === "fake" || trimmed === "jev" ? trimmed : undefined;
}

function parseUsdPerRun(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_ROUTE_USD_PER_RUN
    ? parsed
    : undefined;
}

export function parseRouteProducerConfig(
  environment: Environment,
): RouteProducerConfig {
  if (environment.OPEN_BRAIN_MAINTENANCE_ROUTE_ENABLED !== "1") {
    return { enabled: false };
  }
  const backend = parseRouteBackend(environment.OPEN_BRAIN_MAINTENANCE_ROUTE_BACKEND);
  const sliceSize = strictPositiveInteger(
    environment.OPEN_BRAIN_MAINTENANCE_ROUTE_SLICE_SIZE,
  );
  const gapMs = minGapMs(
    environment.OPEN_BRAIN_MAINTENANCE_ROUTE_MIN_GAP_MS,
    DEFAULT_ROUTE_MIN_GAP_MS,
    MAX_ROUTE_MIN_GAP_MS,
  );
  const maxUsdPerRun = parseUsdPerRun(
    environment.OPEN_BRAIN_MAINTENANCE_ROUTE_MAX_USD_PER_RUN,
  );
  if (
    backend === undefined ||
    sliceSize === undefined ||
    sliceSize > MAX_ROUTE_SLICE_SIZE ||
    gapMs === undefined ||
    maxUsdPerRun === undefined
  ) {
    throw new MaintenanceConfigError(
      "DREAM route configuration requires backend fake or jev, a positive integer slice size (maximum 200), a max USD per run above 0 and at most 1, and an optional minimum gap of 0 to 86400000 ms",
      "OPEN_BRAIN_MAINTENANCE_ROUTE",
    );
  }
  return { enabled: true, backend, sliceSize, minGapMs: gapMs, maxUsdPerRun };
}

export function parseMaintenanceConfig(environment: Environment): MaintenanceConfig {
  const raw = environment.OPEN_BRAIN_MAINTENANCE_ENABLED?.trim().toLowerCase();
  const concurrency = positiveInteger(environment.OPEN_BRAIN_MAINTENANCE_CONCURRENCY);
  const pollIntervalMs = positiveInteger(environment.OPEN_BRAIN_MAINTENANCE_POLL_MS);
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
  const rem = parseRemProducerConfig(environment);
  const route = parseRouteProducerConfig(environment);
  return {
    enabled: raw !== "0" && raw !== "false",
    rem,
    route,
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
    ...(leaseMs !== undefined ? { leaseMs } : {}),
    ...(distillBatchSize !== undefined ? { distillBatchSize } : {}),
    ...(maxDistillBatchesPerTick !== undefined ? { maxDistillBatchesPerTick } : {}),
    ...(graphDerivationLimit !== undefined ? { graphDerivationLimit } : {}),
  };
}
