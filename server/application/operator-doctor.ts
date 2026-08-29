/**
 * `operator_doctor`: assemble the frozen diagnostic payload, and serve it from
 * a single-flight short-TTL cache.
 *
 * Moved out of `src/operator-doctor.ts` (issue 864, L5 of
 * `_plans/server-hardening-ladder.md`) and split into siblings by
 * responsibility: `./operator-doctor-types.ts` owns the frozen shape and the
 * classification constants, `./operator-doctor-probes.ts` asks the individual
 * diagnostic questions, and this file assembles and caches.
 *
 * Every value the old module read from `process.env` now arrives as a field of
 * the single `OperatorDoctorOptions` parameter, filled by `server/main.ts` from
 * the parsed `ServerConfig`. The legacy env-reading call form survives on the
 * `src/operator-doctor.ts` L5 adapter, which retires with `src/` at L6.
 */
import type pg from "pg";
import { CONTRACT_VERSION, CONTRACT_SCHEMA_VERSION } from "../../src/contract.ts";
import {
  getEmbeddingProviderDiagnostics,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
} from "../../src/embedding.ts";
import { checkPoolHealth } from "../../src/db/pool.ts";
import { logger } from "../../src/logger.ts";
import { describeError } from "../../src/observability/index.ts";
import type { NatsBridgeHealth } from "../../src/nats-bridge.ts";
import type { NatsRuntimeBoundary } from "../../src/nats-runtime.ts";
import { isRequestedTransportDegraded } from "../../src/nats-runtime.ts";
import {
  DOCTOR_CACHE_TTL_MS,
  DOCTOR_CONTRACT_VERSION,
  type OperatorDoctorBuildOptions,
  type OperatorDoctorOptions,
  type OperatorDoctorStatus,
} from "./operator-doctor-types.ts";
import {
  checkEmbeddingAvailability,
  checkQmdStatus,
  readAuditStorageStatus,
  readDistillationLag,
  readMigrationStatus,
  readServiceVersion,
} from "./operator-doctor-probes.ts";

export * from "./operator-doctor-types.ts";
export {
  probeUrl,
  withTimeout,
  resetCachedServiceVersion,
} from "./operator-doctor-probes.ts";

interface DoctorProbeResults {
  database: OperatorDoctorStatus["database"];
  migrations: OperatorDoctorStatus["migrations"];
  distillationLag: OperatorDoctorStatus["distillation_lag"];
  embeddingAvailable: boolean;
  serviceVersion: string;
  auditStorage: OperatorDoctorStatus["log_audit"]["audit_storage"];
  qmd: OperatorDoctorStatus["qmd"];
}

async function runDoctorProbes(
  pool: pg.Pool,
  options: OperatorDoctorBuildOptions,
): Promise<DoctorProbeResults> {
  const [
    database,
    migrations,
    distillationLag,
    embeddingAvailable,
    serviceVersion,
    auditStorage,
    qmd,
  ] = await Promise.all([
    checkPoolHealth(pool),
    readMigrationStatus(pool),
    readDistillationLag(pool, options.rawTurnTtlSeconds),
    checkEmbeddingAvailability(),
    readServiceVersion(options.serviceVersionFallback),
    readAuditStorageStatus(pool),
    checkQmdStatus(options),
  ]);
  return {
    database,
    migrations,
    distillationLag,
    embeddingAvailable,
    serviceVersion,
    auditStorage,
    qmd,
  };
}

// Migrations not verified current (pending OR unknown) with a connected
// DB means an unverified or broken schema: degraded, never silently healthy.
// A configured-but-unavailable embedding provider hard-fails vector search.
// Critical distillation lag means acknowledged live turns are nearing TTL
// expiry, so it degrades service status; warning lag is early signal only.
function overallStatus(
  probes: DoctorProbeResults,
  embeddingConfigured: boolean,
  transportDegraded: boolean,
): OperatorDoctorStatus["status"] {
  if (!probes.database.connected) return "unhealthy";
  const migrationsDegraded = probes.migrations.status !== "current";
  const embeddingDegraded = embeddingConfigured && !probes.embeddingAvailable;
  const distillationDegraded = probes.distillationLag.some(
    ({ level }) => level === "critical",
  );
  return migrationsDegraded ||
    transportDegraded ||
    embeddingDegraded ||
    distillationDegraded
    ? "degraded"
    : "healthy";
}

function embeddingSection(
  available: boolean,
): OperatorDoctorStatus["embedding_provider"] {
  const diagnostics = getEmbeddingProviderDiagnostics();
  return {
    configured: diagnostics.configured,
    available,
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    recent_failures: {
      last_failure_code: diagnostics.last_failure_code,
      consecutive_restartable_failures: diagnostics.consecutive_restartable_failures,
      restart_configured: diagnostics.restart_configured,
      restart_in_flight: diagnostics.restart_in_flight,
      last_restart_at: diagnostics.last_restart_at,
    },
  };
}

export async function buildOperatorDoctorStatus(
  pool: pg.Pool,
  natsRuntimeBoundary: NatsRuntimeBoundary,
  natsBridgeHealth: NatsBridgeHealth | undefined,
  options: OperatorDoctorBuildOptions,
): Promise<OperatorDoctorStatus> {
  const probes = await runDoctorProbes(pool, options);
  const embeddingDiagnostics = getEmbeddingProviderDiagnostics();
  const transportAvailability =
    natsBridgeHealth?.availability ?? natsRuntimeBoundary.nats.availability;
  const transportDegraded = isRequestedTransportDegraded(
    natsRuntimeBoundary,
    transportAvailability,
  );

  return {
    status: overallStatus(probes, embeddingDiagnostics.configured, transportDegraded),
    contract_version: DOCTOR_CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
    runtime: {
      service: "open-brain",
      version: probes.serviceVersion,
      contract_version: CONTRACT_VERSION,
      contract_schema_version: CONTRACT_SCHEMA_VERSION,
      node_env: options.nodeEnvironment,
    },
    database: probes.database,
    migrations: probes.migrations,
    distillation_lag: probes.distillationLag,
    embedding_provider: embeddingSection(probes.embeddingAvailable),
    qmd: probes.qmd,
    transport: {
      mode: natsRuntimeBoundary.requested_transport,
      availability: transportAvailability,
      fallback_http: natsRuntimeBoundary.nats.fallback_http,
      consecutive_failures: natsBridgeHealth?.consecutiveFailures ?? 0,
      last_error: natsBridgeHealth?.lastError ? "redacted" : null,
    },
    log_audit: {
      request_logger: "enabled",
      file_log_configured: options.fileLogConfigured,
      rotation_configured: options.fileLogConfigured && options.rotationConfigured,
      audit_storage: probes.auditStorage,
    },
    optional_dependencies: {
      embedding_provider: embeddingDiagnostics.configured
        ? probes.embeddingAvailable
          ? "available"
          : "unavailable"
        : "not_configured",
      qmd: probes.qmd.status,
    },
  };
}

// --- Single-flight + short-TTL cache -----------------------------------
//
// Every doctor build fans out DB scans and an outbound embedding probe;
// without a cache, a polling dashboard or looping token amplifies probes
// during the exact incident being diagnosed. All callers (REST route and
// MCP tool) go through getOperatorDoctorStatus: concurrent callers share
// one in-flight build, and results are served from cache within the TTL.

interface DoctorCacheEntry {
  value: OperatorDoctorStatus;
  expiresAt: number;
}

let doctorCache: DoctorCacheEntry | null = null;
let doctorInFlight: Promise<OperatorDoctorStatus> | null = null;

export function resetOperatorDoctorCache(): void {
  doctorCache = null;
  doctorInFlight = null;
}

export async function getOperatorDoctorStatus(
  pool: pg.Pool,
  natsRuntimeBoundary: NatsRuntimeBoundary,
  natsBridgeHealth: NatsBridgeHealth | undefined,
  options: OperatorDoctorOptions,
): Promise<OperatorDoctorStatus> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DOCTOR_CACHE_TTL_MS;
  if (doctorCache && now() < doctorCache.expiresAt) {
    return doctorCache.value;
  }
  if (doctorInFlight) return doctorInFlight;
  const build = buildOperatorDoctorStatus(
    pool,
    natsRuntimeBoundary,
    natsBridgeHealth,
    options,
  )
    .then((value) => {
      doctorCache = { value, expiresAt: now() + ttlMs };
      return value;
    })
    .catch((error: unknown) => {
      // Logged HERE, at the owning boundary, and then re-thrown unchanged.
      //
      // Every consumer of this function converts the rejection into a
      // deliberately content-free response -- the REST route in src/index.ts
      // sends `{ error: "operator doctor status unavailable" }` and the MCP tool
      // sends the same string -- because a raw doctor error can carry paths and
      // env detail. That is right for the RESPONSE and left alone. But it meant
      // the reason existed nowhere: the diagnostic surface is gone at exactly
      // the moment it is needed, and the only trace was a 500 in an access log.
      //
      // Logging at this single point covers both consumers at once, and it is
      // the only place that can: the in-flight promise below is shared, so one
      // rejection is handed to every concurrent caller, and a per-caller catch
      // would report the same failure once per waiter.
      logger.error("doctor_status_build_failed", describeError(error));
      throw error;
    })
    .finally(() => {
      doctorInFlight = null;
    });
  doctorInFlight = build;
  return build;
}
