/**
 * The frozen `operator_doctor` payload shape and its classification constants.
 *
 * Split out of `./operator-doctor.ts` (issue 864) so the builder, the probes,
 * and the cache each stay under the server/ file rule. The interface is a
 * FROZEN contract: any field addition or removal requires bumping
 * `DOCTOR_CONTRACT_VERSION`, and `src/operator-doctor.test.ts` locks the exact
 * key set against it.
 */
import type { AuthInfo, PoolHealth } from "../../src/types.ts";

export const DOCTOR_CONTRACT_VERSION = "2026-08-05.operator-doctor.v4";
export const DISTILLATION_LAG_TTL_SECONDS_DEFAULT = 7 * 24 * 60 * 60;
export const DISTILLATION_LAG_WARNING_RATIO = 0.5;
export const DISTILLATION_LAG_CRITICAL_RATIO = 0.8;
export const OPTIONAL_TIMEOUT_MS = 2_000;
export const DOCTOR_CACHE_TTL_MS = 5_000;
export const QMD_INDEX_STALE_AFTER_HOURS = 48;

// Shared privileged-read predicate for the doctor surface. Consumed by both
// the MCP tool (src/tools/operator-doctor.ts) and the REST route
// (src/index.ts) so the gates cannot diverge.
export function canReadDoctor(auth: AuthInfo | undefined): boolean {
  return auth?.role === "admin" || auth?.role === "ob-admin";
}

export interface OperatorDoctorStatus {
  // unhealthy: the database is unreachable (hard failure).
  // degraded: DB is connected but migrations are not verified current
  //   (pending OR unknown), the requested transport is unavailable, a
  //   CONFIGURED embedding provider is unavailable, or distillation lag is
  //   critical. Critical lag means live turns are nearing retention expiry;
  //   unhealthy remains reserved for a database hard failure.
  // Neutral: warning-level lag, an unconfigured embedding provider, and qmd
  //   availability or index freshness never affect the tier (issue #270
  //   optional-dep rule).
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
  distillation_lag: Array<{
    namespace: string;
    undistilled_depth: number;
    oldest_undistilled_age_seconds: number;
    ratio: number;
    level: "ok" | "warning" | "critical";
  }>;
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
    index: {
      path: string;
      path_source: "option" | "env" | "default";
      status: "available" | "unavailable";
      last_updated_at: string | null;
      age_hours: number | null;
      freshness: "current" | "stale" | "unknown";
      stale_after_hours: number;
      document_count: number | null;
      collection_count: number | null;
    };
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

/**
 * Every value the doctor used to read from `process.env` itself, plus the
 * build and cache knobs it already took.
 *
 * The env-derived fields are REQUIRED: `server/main.ts` holds the parsed
 * `ServerConfig` and fills them, so there is no ambient fallback to drift from
 * (`.oxlintrc.json` permits `process.env` only at the composition root). The
 * legacy call form lives on in the `src/operator-doctor.ts` L5 adapter.
 */
export interface OperatorDoctorOptions {
  /** `package.json` fallback when the file itself cannot be read. */
  serviceVersionFallback: string;
  /** One of the three known values, or `unknown` for anything else. */
  nodeEnvironment: OperatorDoctorStatus["runtime"]["node_env"];
  /** Whether `LOG_FILE` carries a non-blank value. */
  fileLogConfigured: boolean;
  /** Whether either log rotation variable carries a non-blank value. */
  rotationConfigured: boolean;
  /** Raw-turn retention seconds: the distillation-lag alarm denominator. */
  rawTurnTtlSeconds: number;
  /** Absent means the doctor falls back to its own default index path. */
  qmdIndexPath?: string;
  /** Where `qmdIndexPath` came from, reported verbatim in the payload. */
  qmdIndexPathSource?: "option" | "env";
  qmdIndexStaleAfterHours?: number;
  now?: () => number;
  ttlMs?: number;
}

/** The subset the payload builder needs; the cache knobs are not its business. */
export type OperatorDoctorBuildOptions = Omit<OperatorDoctorOptions, "ttlMs">;

/** Classify oldest-undistilled-age / raw-turn-TTL without reading the database. */
export function classifyDistillationLag(
  ratio: number,
): OperatorDoctorStatus["distillation_lag"][number]["level"] {
  if (ratio >= DISTILLATION_LAG_CRITICAL_RATIO) return "critical";
  if (ratio >= DISTILLATION_LAG_WARNING_RATIO) return "warning";
  return "ok";
}
