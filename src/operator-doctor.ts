// L5 adapter (issue 864): legacy call form over server/application/operator-doctor.ts; retired with src/ at L6.
import type pg from "pg";
import type { NatsBridgeHealth } from "../server/application/operator-doctor.ts";
import type { NatsRuntimeBoundary } from "../server/application/nats-runtime.ts";
import {
  buildOperatorDoctorStatus as buildStatus,
  getOperatorDoctorStatus as getStatus,
  DISTILLATION_LAG_TTL_SECONDS_DEFAULT,
  type OperatorDoctorOptions,
  type OperatorDoctorStatus,
} from "../server/application/operator-doctor.ts";

export {
  canReadDoctor,
  classifyDistillationLag,
  probeUrl,
  resetOperatorDoctorCache,
  DISTILLATION_LAG_CRITICAL_RATIO,
  DISTILLATION_LAG_TTL_SECONDS_DEFAULT,
  DISTILLATION_LAG_WARNING_RATIO,
  DOCTOR_CONTRACT_VERSION,
  type OperatorDoctorStatus,
} from "../server/application/operator-doctor.ts";

/** Read the alarm denominator, falling back to the documented one-week TTL. */
export function readDistillationLagTtlSeconds(
  environment: Record<string, string | undefined> = process.env,
): number {
  const configured = Number(environment.OPENBRAIN_RAW_TURN_TTL_SECONDS);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DISTILLATION_LAG_TTL_SECONDS_DEFAULT;
}

/** The legacy options both entry points accepted before the env fields moved. */
export interface OperatorDoctorBuildOptions {
  now?: () => number;
  qmdIndexPath?: string;
  qmdIndexStaleAfterHours?: number;
}

export interface OperatorDoctorCacheOptions {
  ttlMs?: number;
  now?: () => number;
}

/** Read at call time, not at import: the legacy tests flip env per case. */
function ambientOptions(): OperatorDoctorOptions {
  const nodeEnv = process.env.NODE_ENV;
  return {
    serviceVersionFallback: process.env.npm_package_version ?? "unknown",
    nodeEnvironment:
      nodeEnv === "production" || nodeEnv === "development" || nodeEnv === "test"
        ? nodeEnv
        : "unknown",
    fileLogConfigured: Boolean(process.env.LOG_FILE?.trim()),
    rotationConfigured:
      Boolean(process.env.LOG_MAX_BYTES) || Boolean(process.env.LOG_MAX_FILES),
    rawTurnTtlSeconds: readDistillationLagTtlSeconds(),
    ...(process.env.QMD_PATH !== undefined ? { qmdPath: process.env.QMD_PATH } : {}),
    ...(process.env.QMD_INDEX_PATH !== undefined
      ? { qmdIndexPath: process.env.QMD_INDEX_PATH, qmdIndexPathSource: "env" as const }
      : {}),
  };
}

export async function buildOperatorDoctorStatus(
  pool: pg.Pool,
  natsRuntimeBoundary: NatsRuntimeBoundary,
  natsBridgeHealth?: NatsBridgeHealth,
  options: OperatorDoctorBuildOptions = {},
): Promise<OperatorDoctorStatus> {
  const { qmdIndexPath, ...rest } = options;
  return buildStatus(pool, natsRuntimeBoundary, natsBridgeHealth, {
    ...ambientOptions(),
    ...rest,
    ...(qmdIndexPath !== undefined
      ? { qmdIndexPath, qmdIndexPathSource: "option" as const }
      : {}),
  });
}

export async function getOperatorDoctorStatus(
  pool: pg.Pool,
  natsRuntimeBoundary: NatsRuntimeBoundary,
  natsBridgeHealth?: NatsBridgeHealth,
  options: OperatorDoctorCacheOptions = {},
): Promise<OperatorDoctorStatus> {
  return getStatus(pool, natsRuntimeBoundary, natsBridgeHealth, {
    ...ambientOptions(),
    ...options,
  });
}
