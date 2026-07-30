import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { CONTRACT_VERSION, CONTRACT_SCHEMA_VERSION } from "./contract.ts";
import {
  getEmbeddingProviderDiagnostics,
  embeddingBaseUrl,
  embeddingApiKey,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
} from "./embedding.ts";
import { checkPoolHealth } from "./db/pool.ts";
import { readMcpAuditConfig } from "./audit-log.ts";
import { resolveQmdPath } from "./qmd-path.ts";
import { logger } from "./logger.ts";
import { describeError } from "./observability/index.ts";
import type { NatsBridgeHealth } from "./nats-bridge.ts";
import type { NatsRuntimeBoundary } from "./nats-runtime.ts";
import { isRequestedTransportDegraded } from "./nats-runtime.ts";
import type { AuthInfo, PoolHealth } from "./types.ts";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "db",
  "migrations",
);

// Any field addition/removal in OperatorDoctorStatus requires bumping this
// version. src/operator-doctor.test.ts locks the exact payload shape.
export const DOCTOR_CONTRACT_VERSION = "2026-07-08.operator-doctor.v2";
const OPTIONAL_TIMEOUT_MS = 2_000;
const DOCTOR_CACHE_TTL_MS = 5_000;

let cachedServiceVersion: string | null = null;

async function readServiceVersion(): Promise<string> {
  if (cachedServiceVersion !== null) return cachedServiceVersion;
  try {
    const pkg = (await Bun.file(
      join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    ).json()) as { version?: unknown };
    cachedServiceVersion =
      typeof pkg.version === "string" && pkg.version.length > 0
        ? pkg.version
        : (process.env.npm_package_version ?? "unknown");
  } catch (error) {
    // Falling back to the env var is fine; reporting "unknown" as if it were
    // the answer is not. A doctor that cannot read its own package.json is
    // telling the operator something about its deployment.
    cachedServiceVersion = process.env.npm_package_version ?? "unknown";
    logger.warn("doctor_service_version_unreadable", {
      fallback: cachedServiceVersion,
      ...describeError(error),
    });
  }
  return cachedServiceVersion;
}

// Shared privileged-read predicate for the doctor surface. Consumed by both
// the MCP tool (src/tools/operator-doctor.ts) and the REST route
// (src/index.ts) so the gates cannot diverge.
export function canReadDoctor(auth: AuthInfo | undefined): boolean {
  return auth?.role === "admin" || auth?.role === "ob-admin";
}

export interface OperatorDoctorStatus {
  // unhealthy: the database is unreachable (hard failure).
  // degraded: DB is connected but migrations are not verified current
  //   (pending OR unknown), the requested transport is unavailable, or a
  //   CONFIGURED embedding provider is unavailable.
  // Neutral: an unconfigured embedding provider and qmd availability never
  //   affect the tier (issue #270 optional-dep rule).
  status: "healthy" | "degraded" | "unhealthy";
  contract_version: string;
  generated_at: string;
  runtime: {
    service: "open-brain";
    version: string;
    contract_version: string;
    contract_schema_version: number;
    node_env: "production" | "development" | "test" | "unknown";
  };
  database: PoolHealth;
  migrations: {
    status: "current" | "pending" | "unknown";
    applied_count: number | null;
    expected_count: number;
    pending_count: number | null;
    latest_applied: string | null;
    latest_expected: string | null;
  };
  embedding_provider: {
    configured: boolean;
    available: boolean;
    model: string;
    dimensions: number;
    recent_failures: {
      last_failure_code: string | null;
      consecutive_restartable_failures: number;
      restart_configured: boolean;
      restart_in_flight: boolean;
      last_restart_at: string | null;
    };
  };
  qmd: {
    // The qmd path always resolves (QMD_PATH env override or the built-in
    // default used by search_all), so configured is true whenever a path
    // resolution source exists.
    configured: boolean;
    path_source: "env" | "default";
    // available means the qmd entrypoint file exists at the resolved path --
    // binary presence only, NOT qmd search health. The raw path is never
    // included in the payload.
    available: boolean;
    status: "available" | "unavailable";
  };
  transport: {
    mode: "http" | "nats";
    availability: "available" | "not_runtime_available";
    fallback_http: boolean;
    consecutive_failures: number;
    last_error: "redacted" | null;
  };
  log_audit: {
    request_logger: "enabled";
    file_log_configured: boolean;
    rotation_configured: boolean;
    audit_storage: "available" | "not_available";
  };
  optional_dependencies: {
    embedding_provider: "available" | "unavailable" | "not_configured";
    qmd: "available" | "unavailable";
  };
}

async function withTimeout<T>(
  task: Promise<T>,
  fallback: T,
  timeoutMs = OPTIONAL_TIMEOUT_MS,
): Promise<T> {
  // Absorb late rejections: if the timeout wins the race, a subsequent
  // rejection of the abandoned task must not surface as an unhandled
  // rejection. Absorbing it is right; discarding it was not -- a probe that
  // always loses the race and always rejects reported its fallback forever
  // with nothing anywhere saying why.
  task.catch((error: unknown) => {
    logger.debug("doctor_probe_late_rejection", describeError(error));
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Is an HTTP endpoint answering OK? Exported because `/health` in `src/index.ts`
 * asks the same question of the same provider and had its own byte-identical
 * private copy -- including the bare `catch { return false }` this one no longer
 * has. A REST sibling drifting from the module that owns the logic is the exact
 * shape of the PR #277 failure recorded in docs/sme/correctness.md:475, so the
 * two call sites now share one implementation instead of two.
 *
 * Reports only a boolean by design; which of DNS failure, refused connection,
 * or timeout it was goes to the log, because that is the whole diagnosis.
 *
 * `timeoutMs` is a parameter rather than a shared constant because the two
 * callers genuinely differ and neither should silently inherit the other's
 * value: the doctor allows 2s for an optional-dependency probe, `/health`
 * allowed 3s. Sharing the implementation must not quietly change either one.
 */
export async function probeUrl(
  url: string,
  headers: Record<string, string>,
  timeoutMs = OPTIONAL_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      // A reachable endpoint answering 401 or 503 is a different problem from
      // an unreachable one, and `false` says neither.
      logger.debug("doctor_probe_not_ok", {
        status: resp.status,
        timeout_ms: timeoutMs,
      });
    }
    return resp.ok;
  } catch (error) {
    // DNS failure, connection refused, or the timeout firing. The caller gets
    // only a boolean by design; which of the three it was belongs in the log,
    // because that is the whole diagnosis.
    logger.debug("doctor_probe_failed", {
      timeout_ms: timeoutMs,
      ...describeError(error),
    });
    return false;
  }
}

async function readMigrationStatus(
  pool: pg.Pool,
): Promise<OperatorDoctorStatus["migrations"]> {
  let files: string[];
  try {
    files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch (error) {
    // Never let a filesystem error propagate: thrown messages can carry raw
    // paths into MCP tool error text or Express error pages. That rule governs
    // the *response*; the log is where the operator is allowed to learn that
    // the migrations directory is missing from the deployment entirely, which
    // "status: unknown" on its own never said.
    logger.error("doctor_migrations_dir_unreadable", describeError(error));
    return {
      status: "unknown",
      applied_count: null,
      expected_count: 0,
      pending_count: null,
      latest_applied: null,
      latest_expected: null,
    };
  }
  const latestExpected = files.at(-1) ?? null;
  try {
    const { rows } = await pool.query(
      "SELECT filename FROM _migrations ORDER BY filename",
    );
    const applied = rows.map((row) => String(row.filename));
    const appliedSet = new Set(applied);
    const pending = files.filter((file) => !appliedSet.has(file));
    return {
      status: pending.length === 0 ? "current" : "pending",
      applied_count: applied.length,
      expected_count: files.length,
      pending_count: pending.length,
      latest_applied: applied.at(-1) ?? null,
      latest_expected: latestExpected,
    };
  } catch (error) {
    // Two very different deployments produce this same "unknown": a database
    // the doctor cannot reach at all, and a reachable database with no
    // `_migrations` table (SQLSTATE 42P01 -- never migrated). The pg fields say
    // which; the payload shape cannot.
    logger.error("doctor_migrations_query_failed", describeError(error));
    return {
      status: "unknown",
      applied_count: null,
      expected_count: files.length,
      pending_count: null,
      latest_applied: null,
      latest_expected: latestExpected,
    };
  }
}

async function readAuditStorageStatus(
  pool: pg.Pool,
): Promise<OperatorDoctorStatus["log_audit"]["audit_storage"]> {
  if (!readMcpAuditConfig().enabled) return "not_available";

  const query: pg.QueryConfig<[string]> & { query_timeout: number } = {
    text: "SELECT to_regclass($1) AS table_name",
    values: ["mcp_tool_audit_log"],
    query_timeout: OPTIONAL_TIMEOUT_MS,
  };
  const reachable = await withTimeout(
    pool
      .query(query)
      .then(({ rows }) => rows[0]?.table_name != null)
      .catch(() => false),
    false,
  );
  return reachable ? "available" : "not_available";
}

async function checkEmbeddingAvailability(): Promise<boolean> {
  const baseUrl = embeddingBaseUrl();
  if (!baseUrl) return false;
  const headers: Record<string, string> = {};
  const apiKey = embeddingApiKey();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return withTimeout(probeUrl(`${baseUrl}/models`, headers), false);
}

// Availability = the qmd entrypoint file exists at the same resolved path
// search_all executes (src/qmd-path.ts). This proves binary presence only;
// it does not exercise qmd search health.
function checkQmdBinaryPresence(): OperatorDoctorStatus["qmd"] {
  const resolved = resolveQmdPath();
  let available = false;
  try {
    available = existsSync(resolved.path);
  } catch (error) {
    // existsSync swallows ENOENT itself, so reaching here means something
    // stranger -- a permission error on an ancestor directory, an unmounted
    // volume. Reporting the binary as simply absent would send the operator
    // looking for a missing install that is actually present and unreachable.
    available = false;
    logger.warn("doctor_qmd_probe_failed", {
      path_source: resolved.source,
      ...describeError(error),
    });
  }
  return {
    configured: true,
    path_source: resolved.source,
    available,
    status: available ? "available" : "unavailable",
  };
}

export async function buildOperatorDoctorStatus(
  pool: pg.Pool,
  natsRuntimeBoundary: NatsRuntimeBoundary,
  natsBridgeHealth?: NatsBridgeHealth,
): Promise<OperatorDoctorStatus> {
  const [
    database,
    migrations,
    embeddingAvailable,
    serviceVersion,
    auditStorage,
  ] = await Promise.all([
    checkPoolHealth(pool),
    readMigrationStatus(pool),
    checkEmbeddingAvailability(),
    readServiceVersion(),
    readAuditStorageStatus(pool),
  ]);
  const qmd = checkQmdBinaryPresence();

  const embeddingDiagnostics = getEmbeddingProviderDiagnostics();
  const transportAvailability =
    natsBridgeHealth?.availability ?? natsRuntimeBoundary.nats.availability;
  const transportDegraded = isRequestedTransportDegraded(
    natsRuntimeBoundary,
    transportAvailability,
  );
  // Migrations not verified current (pending OR unknown) with a connected
  // DB means an unverified or broken schema: degraded, never silently
  // healthy. A configured-but-unavailable embedding provider hard-fails
  // vector search: degraded. An unconfigured provider and qmd stay neutral.
  const migrationsDegraded = migrations.status !== "current";
  const embeddingDegraded =
    embeddingDiagnostics.configured && !embeddingAvailable;
  const status: OperatorDoctorStatus["status"] = !database.connected
    ? "unhealthy"
    : migrationsDegraded || transportDegraded || embeddingDegraded
      ? "degraded"
      : "healthy";
  const fileLogConfigured = Boolean(process.env.LOG_FILE?.trim());

  return {
    status,
    contract_version: DOCTOR_CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
    runtime: {
      service: "open-brain",
      version: serviceVersion,
      contract_version: CONTRACT_VERSION,
      contract_schema_version: CONTRACT_SCHEMA_VERSION,
      node_env:
        process.env.NODE_ENV === "production" ||
        process.env.NODE_ENV === "development" ||
        process.env.NODE_ENV === "test"
          ? process.env.NODE_ENV
          : "unknown",
    },
    database,
    migrations,
    embedding_provider: {
      configured: embeddingDiagnostics.configured,
      available: embeddingAvailable,
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      recent_failures: {
        last_failure_code: embeddingDiagnostics.last_failure_code,
        consecutive_restartable_failures:
          embeddingDiagnostics.consecutive_restartable_failures,
        restart_configured: embeddingDiagnostics.restart_configured,
        restart_in_flight: embeddingDiagnostics.restart_in_flight,
        last_restart_at: embeddingDiagnostics.last_restart_at,
      },
    },
    qmd,
    transport: {
      mode: natsRuntimeBoundary.requested_transport,
      availability: transportAvailability,
      fallback_http: natsRuntimeBoundary.nats.fallback_http,
      consecutive_failures: natsBridgeHealth?.consecutiveFailures ?? 0,
      last_error: natsBridgeHealth?.lastError ? "redacted" : null,
    },
    log_audit: {
      request_logger: "enabled",
      file_log_configured: fileLogConfigured,
      rotation_configured:
        fileLogConfigured &&
        (Boolean(process.env.LOG_MAX_BYTES) ||
          Boolean(process.env.LOG_MAX_FILES)),
      audit_storage: auditStorage,
    },
    optional_dependencies: {
      embedding_provider: embeddingDiagnostics.configured
        ? embeddingAvailable
          ? "available"
          : "unavailable"
        : "not_configured",
      qmd: qmd.status,
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

export interface OperatorDoctorCacheOptions {
  ttlMs?: number;
  now?: () => number;
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
  natsBridgeHealth?: NatsBridgeHealth,
  options: OperatorDoctorCacheOptions = {},
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
