// The one script-side settings module (issue 864, L6).
//
// The server/ modules read no environment: each takes its raw values through a
// settings reader that somebody has to register. Under L5 that registration
// lived in the `src/` adapters, and every script imported the adapter to get it
// as a side effect. This module consolidates those registrations for the
// scripts, so a script imports from here instead of reaching back into `src/`.
//
// The registration calls below are copied from the adapters verbatim — same env
// keys, same precedence, same defaults, each reader still a lazy function
// evaluated at call time rather than a snapshot taken at import — so a script
// that switches its specifier to this file keeps the exact behaviour it had.
//
// `process.env` is read here on purpose. The no-env rule is a server/ rule;
// reading the environment is precisely this module's job.
import type pg from "pg";
import {
  createPool as createPoolWithSettings,
  type CreatePoolOptions,
  type PoolSettings,
} from "../server/db/legacy-pool.ts";
import { setLegacyLoggerSettingsReader } from "../server/logging/legacy-logger-settings.ts";
import {
  setEmbeddingSettingsReader,
  type EmbeddingProviderSettings,
} from "../server/embedding/provider.ts";
import type { AuthInfo, Table } from "../server/types.ts";
import type { SharedNamespaceConfig } from "../server/security/shared-namespace.ts";
import { sharedNamespaceEnvironment } from "../server/config.ts";
import {
  canonicalNamespace as canonicalNamespaceWith,
  isLegacySharedNamespace as isLegacySharedNamespaceWith,
  isSharedNamespace as isSharedNamespaceWith,
  physicalNamespace as physicalNamespaceWith,
  sharedNamespaceConfig as sharedNamespaceConfigWith,
  shouldRejectLegacySharedWrite as shouldRejectLegacySharedWriteWith,
} from "../server/security/shared-namespace.ts";
import {
  promoteEntry as promoteEntryFromOptions,
  type PromotionOptions as ServerPromotionOptions,
} from "../server/domain/promotion-service.ts";

// ---------------------------------------------------------------------------
// db/pool — the legacy zero-argument call form
// ---------------------------------------------------------------------------

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** The legacy form: connection settings read from the environment at call time. */
export function createPool(
  overrides?: Partial<pg.PoolConfig>,
  options?: CreatePoolOptions,
): pg.Pool {
  const host = process.env.DB_HOST;
  if (!host) throw new Error("DB_HOST environment variable is required");
  const user = process.env.DB_USER;
  if (!user) throw new Error("DB_USER environment variable is required");

  const settings: PoolSettings = {
    host,
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "open_brain",
    user,
    password: process.env.DB_PASSWORD,
    max: parsePositiveInt(process.env.DB_POOL_MAX, 10),
  };
  return createPoolWithSettings(settings, overrides, options);
}

export { checkPoolHealth } from "../server/db/legacy-pool.ts";
export type { PoolSettings } from "../server/db/legacy-pool.ts";

// ---------------------------------------------------------------------------
// logger
// ---------------------------------------------------------------------------

setLegacyLoggerSettingsReader(() => ({
  logLevel: process.env.LOG_LEVEL,
  hostName: process.env.HOSTNAME?.trim() || process.env.HOST?.trim(),
  logFile: process.env.LOG_FILE,
  logMaxBytes: process.env.LOG_MAX_BYTES,
  logMaxFiles: process.env.LOG_MAX_FILES,
  serviceName: process.env.SERVICE_NAME,
  workerName: process.env.OPEN_BRAIN_WORKER_NAME,
}));

export { addLogSink, logger } from "../server/logging/legacy-logger.ts";

// ---------------------------------------------------------------------------
// embedding
// ---------------------------------------------------------------------------

function parseIntegerSetting(
  raw: string | undefined,
  fallback: number,
  accept: (value: number) => boolean,
): number {
  const parsed = parseInt(raw ?? String(fallback), 10);
  return Number.isNaN(parsed) || !accept(parsed) ? fallback : parsed;
}

/** Every `EMBEDDING_*` key, parsed the way the original module parsed it. */
export function readEmbeddingEnv(): EmbeddingProviderSettings {
  const restartScript = process.env.EMBEDDING_WATCHDOG_RESTART_SCRIPT;
  const baseUrl = process.env.EMBEDDING_BASE_URL;
  const apiKey = process.env.EMBEDDING_API_KEY;
  return {
    timeoutMs: parseIntegerSetting(process.env.EMBEDDING_TIMEOUT_MS, 8000, () => true),
    dimensions: parseIntegerSetting(
      process.env.EMBEDDING_DIMENSIONS,
      768,
      (value) => value > 0,
    ),
    model: process.env.EMBEDDING_MODEL ?? "gemini-embedding-001",
    watchdog: {
      failureThreshold: parseIntegerSetting(
        process.env.EMBEDDING_WATCHDOG_FAILURE_THRESHOLD,
        2,
        (value) => value > 0,
      ),
      cooldownMs: parseIntegerSetting(
        process.env.EMBEDDING_WATCHDOG_COOLDOWN_MS,
        300000,
        (value) => value >= 0,
      ),
      ...(restartScript === undefined ? {} : { restartScript }),
    },
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

setEmbeddingSettingsReader(readEmbeddingEnv);

/** Vector width, read once at import, as the legacy adapter did. */
export const EMBEDDING_DIMENSIONS = readEmbeddingEnv().dimensions;

/** Provider deployment name, read once at import, as the original was. */
export const EMBEDDING_MODEL = readEmbeddingEnv().model;

export {
  normalizedContentHash,
  generateEmbedding,
  generateEmbeddingWithMetadata,
} from "../server/embedding/provider.ts";

// ---------------------------------------------------------------------------
// shared-namespace — the legacy zero-argument call form
// ---------------------------------------------------------------------------

export type { SharedNamespaceConfig };

/**
 * Read the shared-namespace environment at call time, as legacy callers expect.
 *
 * The eight `process.env` reads this used to spell out itself are the same
 * eight `server/config.ts` `sharedNamespaceEnvironment()` already performs, in
 * the same order with the same keys (issue 841). Delegating keeps one copy:
 * that function is likewise read-per-call and not memoized, so the per-case
 * environment mutation the existing tests rely on still takes effect.
 */
const currentSharedNamespaceEnv = sharedNamespaceEnvironment;

export function sharedNamespaceConfig(): SharedNamespaceConfig {
  return sharedNamespaceConfigWith(currentSharedNamespaceEnv());
}

export function isSharedNamespace(namespace: string): boolean {
  return isSharedNamespaceWith(namespace, currentSharedNamespaceEnv());
}

export function isLegacySharedNamespace(namespace: string): boolean {
  return isLegacySharedNamespaceWith(namespace, currentSharedNamespaceEnv());
}

export function canonicalNamespace(namespace: string): string {
  return canonicalNamespaceWith(namespace, currentSharedNamespaceEnv());
}

export function physicalNamespace(namespace: string): string {
  return physicalNamespaceWith(namespace, currentSharedNamespaceEnv());
}

export function shouldRejectLegacySharedWrite(
  auth: AuthInfo,
  targetNamespace: string,
): boolean {
  return shouldRejectLegacySharedWriteWith(
    auth,
    targetNamespace,
    currentSharedNamespaceEnv(),
  );
}

// ---------------------------------------------------------------------------
// promotion-service — the legacy positional call form
// ---------------------------------------------------------------------------

export {
  PROMOTION_CONTENT_COLUMNS,
  type PromotionResult,
} from "../server/domain/promotion-service.ts";

/** The legacy options bag: the target namespace and auth were positional. */
export type PromotionOptions = Omit<
  ServerPromotionOptions,
  "targetNamespace" | "auth" | "reason" | "killSwitch"
>;

/** The seven positional arguments the legacy callers pass, in their order. */
type LegacyPromoteEntryArguments = [
  pool: pg.Pool,
  table: Table,
  id: string,
  targetNamespace: string,
  reason: string | undefined,
  auth: AuthInfo,
  options?: PromotionOptions,
];

/**
 * Legacy positional `promoteEntry`, kept for the callers still in `scripts/`.
 *
 * The arguments arrive as one typed tuple rather than seven declared
 * parameters, which is what lets a seven-argument legacy call form survive
 * under the four-parameter rule without a disable comment; the call sites are
 * unchanged and still type-checked position by position.
 *
 * The kill switch is read here, at call time, because the server-side service
 * takes it as a value and this module is where the environment read belongs.
 * Reading it inside the call rather than at module load keeps the existing
 * tests, which set the variable per case, behaving as they did.
 */
export async function promoteEntry(...args: LegacyPromoteEntryArguments) {
  const [pool, table, id, targetNamespace, reason, auth, options = {}] = args;
  return await promoteEntryFromOptions(pool, table, id, {
    ...options,
    targetNamespace,
    reason,
    auth,
    killSwitch: process.env.OPENBRAIN_PROMOTION_KILL_SWITCH === "1",
  });
}

// ---------------------------------------------------------------------------
// Pure re-export shims: no adapter, no environment, re-exported from the owner
// ---------------------------------------------------------------------------

export { ALL_TABLES } from "../server/db/table-constants.ts";
export type { AuthInfo, Table };
export { buildContract, CONTRACT_VERSION } from "../server/contracts/contract.ts";
export {
  decisionCanonicalText,
  sessionEmbedText,
  sessionSourceHashInput,
} from "../server/embedding/embedding-canonical.ts";
export { extractMetadata, mergeTags } from "../server/domain/extraction.ts";
export {
  getEmbeddingTarget,
  EMBEDDING_TARGET_NAMES,
} from "../server/embedding/embedding-targets.ts";
export {
  planEntryDecomposition,
  type DecompositionPlan,
  type ReplacementProposal,
} from "../server/domain/decomposition.ts";
export {
  classifyShareCandidate,
  type ShareCandidateInput,
  type ShareDecision,
} from "../server/domain/sharing.ts";
export {
  repairStaleBatch,
  MAX_BATCH,
  type RepairScope,
  type StalenessReason,
} from "../server/embedding/embedding-repair.ts";
export {
  classifyLaneEvent,
  findDurableDuplicate,
  graduateLaneEvent,
} from "../server/domain/tiering.ts";
export type { LaneEventRow } from "../server/domain/tiering.ts";
