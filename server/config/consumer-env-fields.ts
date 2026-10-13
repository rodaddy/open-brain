/**
 * Env fields for the embedding, promotion, MCP-audit, doctor, drop-collector,
 * and logger-identity consumers, declared here so the composition root can hand
 * them inward.
 *
 * These were added while those consumers still lived outside `server/`; the
 * transplant has since finished and every one of them is under `server/` now.
 * The per-field provenance comments below still name the pre-transplant
 * modules, which is history rather than a live location -- read them as where a
 * field came from, not where to go looking for its reader today.
 *
 * Design authority: `_plans/server-hardening-ladder.md` L2 made the config
 * layer the single place the environment is parsed, and `.oxlintrc.json`
 * permits `process.env` only at the composition root. Four L5 move lanes
 * stopped because the module they were moving reads a key the door does not
 * parse; this module widened the door.
 *
 * WHY THE PARSERS MIRROR THEIR READER RATHER THAN BEING TIDIED. The bar is
 * start-equivalence, exactly as in `./env-groups.ts`: an environment that boots
 * the server today must still boot it, with the same values. Every reader below
 * ignores an unusable value and falls back, so none of these fields rejects.
 * Turning one into a hard rejection would convert a currently-booting
 * deployment into `server_configuration_invalid`, which is a behavior change
 * smuggled in under a typing change.
 *
 * WHICH PARSE FUNCTION MATTERS. The pre-transplant embedding module used bare
 * `parseInt`, which accepts a trailing suffix (`8000ms` is 8000) and rejects
 * exponent notation (`1e3` is 1). `server/security/audit-log.ts` uses
 * `readBoundedInt`, which tests `/^[0-9]+$/` FIRST and so rejects both of
 * those, plus every negative and fractional value, before applying an
 * inclusive range. They are different functions and are reproduced separately.
 *
 * LAZY READERS. The pre-transplant embedding module read its watchdog keys
 * inside `watchdogFailureThreshold` and `watchdogCooldownMs`, so a test
 * flipping `process.env` mid-process changed the answer there; its timeout,
 * dimensions, and model constants were read once at import instead. A parse at
 * the boundary is necessarily the once-at-startup shape. The value and the
 * default are identical either way, so the consumer lane decides how to thread
 * it.
 */
import { z } from "zod";
import type { DropCollectorBounds } from "../capture/drop-folder-contract.ts";

export type { DropCollectorBounds } from "../capture/drop-folder-contract.ts";

/**
 * A `parseInt`-shaped integer, falling back unless it satisfies `accept`.
 *
 * Reproduces `parseInt(raw ?? "<default>", 10)` followed by an
 * `Number.isNaN(...) || <guard>` test, which is the shape every integer reader
 * in the pre-transplant embedding module used. Base-10
 * `parseInt` is NOT `Number`: `8000ms` is 8000 to those readers and must stay
 * 8000 here, and `1e3` is 1 rather than 1000.
 *
 * Absent and blank both take the fallback: `?? "<default>"` covers absent, and
 * `parseInt("", 10)` is `NaN`, which the reader's own `isNaN` branch already
 * sends to the fallback.
 */
function embeddingInteger(fallback: number, accept: (value: number) => boolean) {
  return z.preprocess((value) => {
    if (typeof value !== "string") return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) || !accept(parsed) ? fallback : parsed;
  }, z.number().int());
}

/**
 * An inclusive-range integer parsed the way `readBoundedInt` parses one.
 *
 * Mirrors `server/security/audit-log.ts` line for line, including the order: the
 * `/^[0-9]+$/` test runs BEFORE the parse, which is what makes `1.5` and
 * `1000ms` fall back there instead of becoming 1 and 1000 the way `parseInt`
 * alone would. A blank value fails that test and falls back too.
 */
function boundedInteger(minimum: number, maximum: number, fallback: number) {
  return z.preprocess((value) => {
    if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
      return fallback;
    }
    return parsed;
  }, z.number().int());
}

/**
 * A raw optional string, absent only when the variable itself is absent.
 *
 * Deliberately NOT blank-as-absent: `resolveQmdPath` (`./qmd-path.ts`) and
 * `resolveQmdIndexPath` (`server/application/operator-doctor.ts`) both branch on
 * `=== undefined` and pass the value through untrimmed, so `QMD_PATH=""` means
 * an empty path to them rather than the default.
 */
const rawOptional = z.string().optional();

/** Strip surrounding whitespace, and treat a blank result as unset. */
const strippedBlankAsAbsent = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const stripped = value.trim();
  return stripped === "" ? undefined : stripped;
}, z.string().optional());

/** Exactly `"1"` enables; every other value, absent included, disables. */
const strictOneFlag = z.preprocess((value) => value === "1", z.boolean());

/** Exactly `"0"` disables; every other value, absent included, enables. */
const strictZeroDisablesFlag = z.preprocess((value) => value !== "0", z.boolean());

/**
 * A positive `parseInt` integer, falling back on anything else.
 *
 * Mirrors `boundedInt` in `server/capture/drop-folder-collector.ts` exactly: `!raw`
 * takes the fallback (absent AND blank), the parse is base-10 `parseInt` (so
 * `256files` is 256 there and must stay 256 here), and only an integer greater
 * than zero wins. Zero and negatives fall back rather than rejecting, so an
 * environment that boots today still boots.
 */
function positiveParsedInteger(fallback: number) {
  return z.preprocess((value) => {
    if (typeof value !== "string" || value === "") return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }, z.number().int());
}

/**
 * The scan-entry override, which is absent rather than defaulted.
 *
 * `server/capture/drop-folder-collector.ts` reads it with the same
 * `boundedInt` and a fallback of `0`, then treats any value at or below zero
 * as "no override". The group below reproduces that by omitting the field, so
 * the collector derives the entry bound from `files` as an unconfigured
 * deployment did.
 */
const scanEntriesOverride = positiveParsedInteger(0);

/** Fields added by this rung, merged into `environmentSchema`. */
export const consumerEnvironmentFields = {
  // embedding — the pre-transplant embedding module: timeout, dimensions,
  // model, watchdog thresholds, and restart script. The timeout
  // guards on NaN only, so a negative value is passed through today; the
  // dimensions and threshold guards add `<= 0`, and the cooldown guard `< 0`.
  EMBEDDING_TIMEOUT_MS: embeddingInteger(8_000, () => true),
  EMBEDDING_DIMENSIONS: embeddingInteger(768, (value) => value > 0),
  EMBEDDING_MODEL: rawOptional,
  EMBEDDING_WATCHDOG_FAILURE_THRESHOLD: embeddingInteger(2, (value) => value > 0),
  EMBEDDING_WATCHDOG_COOLDOWN_MS: embeddingInteger(300_000, (value) => value >= 0),
  EMBEDDING_WATCHDOG_RESTART_SCRIPT: rawOptional,
  // promotion — `server/domain/promotion-service.ts`, an exact `=== "1"` test.
  OPENBRAIN_PROMOTION_KILL_SWITCH: strictOneFlag,
  // mcp audit — `readMcpAuditConfig` (`server/security/audit-log.ts`) with the
  // range constants it declares. Audit is ON unless explicitly disabled, the
  // opposite default to tracing: an omitted variable must never silently stop
  // the record of who called what.
  OPENBRAIN_MCP_AUDIT_ENABLED: strictZeroDisablesFlag,
  OPENBRAIN_MCP_AUDIT_RETENTION_DAYS: boundedInteger(1, 366, 30),
  OPENBRAIN_MCP_AUDIT_CLEANUP_INTERVAL_MS: boundedInteger(
    60_000,
    24 * 60 * 60 * 1_000,
    60 * 60 * 1_000,
  ),
  OPENBRAIN_MCP_AUDIT_WRITE_TIMEOUT_MS: boundedInteger(50, 5_000, 1_000),
  // doctor — `server/application/operator-doctor.ts` (index path, node env),
  // and rotation. `QMD_PATH` and `LOG_FILE` are already declared in
  // `server/config.ts`, so they are not repeated here.
  // logger identity — `server/logging/logger.ts`. Surrounding whitespace is
  // and a blank result is absent: the reader ORs the two stripped values, so a
  // whitespace-only `HOSTNAME` falls through to `HOST` rather than winning as
  // an empty string.
  HOSTNAME: strippedBlankAsAbsent,
  HOST: strippedBlankAsAbsent,
  QMD_INDEX_PATH: rawOptional,
  // `server/application/operator-doctor.ts` (lag denominator, version
  // fallback). Both fall back on an unusable value, so neither rejects.
  OPENBRAIN_RAW_TURN_TTL_SECONDS: rawOptional,
  npm_package_version: rawOptional,
  NODE_ENV: rawOptional,
  LOG_MAX_BYTES: rawOptional,
  LOG_MAX_FILES: rawOptional,
  // drop-folder collector — the two env reads the L5 move lifted out of the
  // pre-transplant collector and preserved at
  // `server/capture/drop-folder-collector.ts`. The defaults are
  // `DEFAULT_DROP_COLLECTOR_BOUNDS`
  // (`server/capture/drop-folder-contract.ts:51-56`), which are the values an
  // unconfigured deployment ran with.
  DROP_COLLECTOR_MAX_FILES: positiveParsedInteger(256),
  DROP_COLLECTOR_MAX_FILE_BYTES: positiveParsedInteger(1_048_576),
  DROP_COLLECTOR_MAX_TOTAL_BYTES: positiveParsedInteger(16_777_216),
  DROP_COLLECTOR_MAX_DEPTH: positiveParsedInteger(8),
  DROP_COLLECTOR_MAX_SCAN_ENTRIES: scanEntriesOverride,
} as const;

type ConsumerEnvironment = z.infer<z.ZodObject<typeof consumerEnvironmentFields>>;

/** Default embedding model identifier — the pre-transplant embedding module. */
const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
/** The three values `server/application/operator-doctor.ts` recognizes. */
const KNOWN_NODE_ENVIRONMENTS = ["production", "development", "test"] as const;
/** The documented one-week raw-turn TTL — `server/application/operator-doctor.ts`. */
const DISTILLATION_LAG_TTL_SECONDS_DEFAULT = 7 * 24 * 60 * 60;

export interface EmbeddingWatchdogGroup {
  /** Consecutive restartable failures before a restart is attempted. */
  readonly failureThreshold: number;
  /** Milliseconds between restart attempts. */
  readonly cooldownMs: number;
  /** Absent means the watchdog observes and never restarts anything. */
  readonly restartScript?: string;
}

export interface EmbeddingConfigGroup {
  /** Milliseconds a provider call may take before it is abandoned. */
  readonly timeoutMs: number;
  /** Vector width, which must match the stored halfvec space. */
  readonly dimensions: number;
  /** Provider deployment name, stored in `embedding_model` columns. */
  readonly model: string;
  readonly watchdog: EmbeddingWatchdogGroup;
}

export interface PromotionConfigGroup {
  /** True stops every promotion — `server/domain/promotion-service.ts`. */
  readonly killSwitch: boolean;
}

export interface McpAuditConfigGroup {
  readonly enabled: boolean;
  readonly retentionDays: number;
  readonly cleanupIntervalMs: number;
  readonly writeTimeoutMs: number;
}

export interface DoctorConfigGroup {
  /** Absent means the doctor falls back to its own default index path. */
  readonly qmdIndexPath?: string;
  /** One of the three known values, or `unknown` for anything else. */
  readonly nodeEnvironment: (typeof KNOWN_NODE_ENVIRONMENTS)[number] | "unknown";
  /** Whether either rotation variable carries a non-blank value. */
  readonly rotationConfigured: boolean;
  /** Raw-turn retention seconds: the distillation-lag alarm denominator. */
  readonly rawTurnTtlSeconds: number;
  /** Version reported when `package.json` itself cannot be read. */
  readonly serviceVersionFallback: string;
}

export function embeddingGroup(parsed: ConsumerEnvironment): EmbeddingConfigGroup {
  const restartScript = parsed.EMBEDDING_WATCHDOG_RESTART_SCRIPT;
  return {
    timeoutMs: parsed.EMBEDDING_TIMEOUT_MS,
    dimensions: parsed.EMBEDDING_DIMENSIONS,
    model: parsed.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    watchdog: {
      failureThreshold: parsed.EMBEDDING_WATCHDOG_FAILURE_THRESHOLD,
      cooldownMs: parsed.EMBEDDING_WATCHDOG_COOLDOWN_MS,
      // Truthiness, not presence: the pre-transplant embedding module returns early on any
      // falsy value, so an empty script name configures no restart.
      ...(restartScript ? { restartScript } : {}),
    },
  };
}

/**
 * Drop-folder scan bounds, in the shape the collector takes as options.
 *
 * `scanEntries` is SPREAD rather than assigned: the collector branches on the
 * key being absent (`server/capture/drop-folder-contract.ts:46-47`), so a
 * present-and-undefined key would not be the same value. The adapter reaches
 * the same shape through the `> 0` test at `server/capture/drop-folder-collector.ts`.
 */
export function dropCollectorGroup(parsed: ConsumerEnvironment): DropCollectorBounds {
  const scanEntries = parsed.DROP_COLLECTOR_MAX_SCAN_ENTRIES;
  return {
    files: parsed.DROP_COLLECTOR_MAX_FILES,
    fileBytes: parsed.DROP_COLLECTOR_MAX_FILE_BYTES,
    totalBytes: parsed.DROP_COLLECTOR_MAX_TOTAL_BYTES,
    depth: parsed.DROP_COLLECTOR_MAX_DEPTH,
    ...(scanEntries > 0 ? { scanEntries } : {}),
  };
}

export function promotionGroup(parsed: ConsumerEnvironment): PromotionConfigGroup {
  return { killSwitch: parsed.OPENBRAIN_PROMOTION_KILL_SWITCH };
}

export function mcpAuditGroup(parsed: ConsumerEnvironment): McpAuditConfigGroup {
  return {
    enabled: parsed.OPENBRAIN_MCP_AUDIT_ENABLED,
    retentionDays: parsed.OPENBRAIN_MCP_AUDIT_RETENTION_DAYS,
    cleanupIntervalMs: parsed.OPENBRAIN_MCP_AUDIT_CLEANUP_INTERVAL_MS,
    writeTimeoutMs: parsed.OPENBRAIN_MCP_AUDIT_WRITE_TIMEOUT_MS,
  };
}

/**
 * Doctor coordinates.
 *
 * `rotationConfigured` reproduces only the ROTATION half of
 * `server/application/operator-doctor.ts`; the reader ANDs it with
 * `fileLogConfigured`, which derives from `LOG_FILE` and is already available
 * as `ServerConfig.logging.file`, so combining the two here would duplicate a
 * value the consumer already holds.
 */
/**
 * The lag denominator, reproducing `readDistillationLagTtlSeconds`
 * (`server/application/operator-doctor.ts`): `Number(...)` rather than `parseInt`, so
 * a trailing suffix is `NaN` and falls back, and only a positive integer wins.
 */
function rawTurnTtlSeconds(raw: string | undefined): number {
  const configured = Number(raw);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DISTILLATION_LAG_TTL_SECONDS_DEFAULT;
}

export function doctorGroup(parsed: ConsumerEnvironment): DoctorConfigGroup {
  const qmdIndexPath = parsed.QMD_INDEX_PATH;
  const nodeEnvironment = KNOWN_NODE_ENVIRONMENTS.find(
    (known) => known === parsed.NODE_ENV,
  );
  return {
    ...(qmdIndexPath !== undefined ? { qmdIndexPath } : {}),
    nodeEnvironment: nodeEnvironment ?? "unknown",
    rotationConfigured: Boolean(parsed.LOG_MAX_BYTES) || Boolean(parsed.LOG_MAX_FILES),
    rawTurnTtlSeconds: rawTurnTtlSeconds(parsed.OPENBRAIN_RAW_TURN_TTL_SECONDS),
    serviceVersionFallback: parsed.npm_package_version ?? "unknown",
  };
}

/**
 * The identity the legacy logger stamps on every envelope — one of the two
 * readers L6 rewires. The other, the search embedding deadline, is
 * served from the existing `search` group (`./env-groups.ts`) instead of a
 * second field for the same value.
 *
 * This mirrors an adapter that reads `process.env` per call, and answers
 * `undefined` rather than a default when nothing is configured. That is the
 * point: `server/main.ts` falls back to the transport identity only when
 * `hostName` is absent, so a group that defaulted here would take that
 * decision away from the consumer and change which value wins.
 */
export interface LoggerIdentityGroup {
  /** Absent means no `HOSTNAME`/`HOST` was set, not that identity is empty. */
  readonly hostName: string | undefined;
}

/**
 * Logger identity, mirroring `server/logging/logger.ts`.
 *
 * `HOSTNAME?.trim() || HOST?.trim()` is an OR on the whitespace-stripped value,
 * so a whitespace-only `HOSTNAME` falls through to `HOST` rather than winning
 * as an empty string. `strippedBlankAsAbsent` reproduces exactly that, which
 * makes the `??` below the same choice the `||` makes there.
 */
export function loggerIdentityGroup(parsed: ConsumerEnvironment): LoggerIdentityGroup {
  return { hostName: parsed.HOSTNAME ?? parsed.HOST };
}
