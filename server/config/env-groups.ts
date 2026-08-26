/**
 * The env fields the composition root does not yet inject.
 *
 * Design authority: `_plans/463-server-rewrite-charter.md:108` — `server/config/`
 * owns ALL env parsing and startup validation, "replaces 18 scattered
 * process.env readers with injected config" — and `:119`, domain code must not
 * import `process.env`. `_DOCS/STANDARDS-typescript.md:183-191` requires one
 * validated config module.
 *
 * Every field here mirrors a reader that still exists today, listed with its
 * file and line in `_plans/l2-composition-root-inventory.md` section A/B. This
 * module is the SCHEMA half only: declaring the field is what makes rewiring
 * the consumer a mechanical change rather than a behavior change, and the
 * rewiring is the next rung's work (L2b/L2c). Until then both this and the
 * original reader exist, deliberately.
 *
 * WHY THE PARSERS ARE PERMISSIVE AND THE EXISTING ONES ARE NOT REWRITTEN. The
 * bar for this rung is start-equivalence: a deployment whose environment starts
 * the server today must still start it, with the same values. Several of these
 * readers deliberately IGNORE an unusable value and fall back rather than
 * failing — `searchEmbeddingTimeoutMs` (`server/tools/search-engine.ts:148`)
 * answers 3000 for `abc`, and `envPositiveInteger`
 * (`server/tools/shared-namespace.ts:52`) answers 5 for `-1`. Tightening any of
 * those into a hard rejection here would turn a currently-booting deployment
 * into `server_configuration_invalid` at startup, which is a behavior change
 * smuggled in under a typing change. So the fallback semantics are reproduced
 * exactly, and only the fields whose current reader ALREADY rejects — none of
 * them, at present — would reject here.
 *
 * The one place that is stricter is the shape, not the value: a field that is
 * documented as a positive integer is typed `number`, so a consumer reading it
 * cannot receive the string it would get from `process.env`.
 */
import { z } from "zod";
import { ftsConfigSchema, resolveFtsConfig, type FtsConfig } from "../tools/fts-config.ts";

/** Trim, and treat a blank value as absent. Present-but-empty is unset. */
const blankAsAbsent = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  },
  z.string().optional(),
);

/**
 * A base-10 integer at or above `minimum`, falling back on anything else.
 *
 * Reproduces `Number.parseInt(raw, 10)` plus a range guard, which is what every
 * integer reader in section A does. `parseInt` is NOT `Number`: it accepts a
 * trailing suffix, so `3000ms` is 3000 to the current readers and must stay
 * 3000 here. Using `z.coerce.number()` would reject it and stop a deployment
 * that boots today.
 */
function fallbackInteger(minimum: number, fallback: number) {
  return z.preprocess((value) => {
    if (typeof value !== "string" || value.trim() === "") return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
  }, z.number().int());
}

/** `1`/`true`/`yes`/`on` are true; anything else, including blank, is `false`. */
const permissiveBoolean = z.preprocess((value) => {
  if (typeof value !== "string" || value.trim() === "") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}, z.boolean());

/** Exactly `1` enables; every other value, absent included, disables. */
const strictOneFlag = z.preprocess((value) => value === "1", z.boolean());

/** Exactly `0` disables; every other value, absent included, enables. */
const strictZeroDisablesFlag = z.preprocess(
  (value) => value !== "0",
  z.boolean(),
);

/**
 * Any free-text language token, mapped to a supported FTS configuration.
 *
 * `resolveFtsConfig` (`server/tools/fts-config.ts:97`) is reused rather than
 * reimplemented: it owns the alias table and the english fallback, and a second
 * allowlist here would be a second opinion on the same question.
 */
const ftsConfigEnv = z.preprocess(
  (value) => resolveFtsConfig(typeof value === "string" ? value.trim() : undefined),
  ftsConfigSchema,
);

/**
 * A comma-separated origin list, normalized to an array.
 *
 * Unset or empty yields an EMPTY allowlist, never a wildcard —
 * `server/transport/rest.ts:115` and the note above it.
 */
const originList = z.preprocess((value) => {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}, z.array(z.string()));

/** Fields added by this rung, merged into `environmentSchema`. */
export const extendedEnvironmentFields = {
  // search — `server/tools/search-engine.ts:148-149`. The legacy name is a
  // FALLBACK, not an alias: the preferred name wins even when both are set, so
  // an operator migrating can set the new one without unsetting the old.
  OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS: blankAsAbsent,
  SEARCH_EMBEDDING_TIMEOUT_MS: blankAsAbsent,
  // fts — `server/tools/fts-config.ts:111`.
  OPENBRAIN_FTS_CONFIG: ftsConfigEnv,
  // qmd — `server/tools/search-all.ts:119`.
  QMD_PATH: blankAsAbsent,
  // recovery — `server/tools/realtime-stores.ts:46` and `server/main.ts:153`.
  OPENBRAIN_RECOVERY_WAL_PATH: blankAsAbsent,
  // shared namespace — `server/tools/shared-namespace.ts:37-52`. The canonical
  // name is already declared in `environmentSchema`; these are the override and
  // legacy-migration coordinates around it.
  OPENBRAIN_SHARED_NAMESPACE: blankAsAbsent,
  SHARED_NAMESPACE_PHYSICAL: blankAsAbsent,
  SHARED_NAMESPACE_LEGACY: blankAsAbsent,
  OPENBRAIN_LEGACY_SHARED_NAMESPACE: blankAsAbsent,
  OPENBRAIN_LEGACY_SHARED_FALLBACK: permissiveBoolean,
  OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS: fallbackInteger(1, 5),
  // tracing — `server/observability/langfuse-tracing.ts:599-604`.
  OPENBRAIN_TRACING_ENDPOINT: blankAsAbsent,
  OPENBRAIN_TRACING_PUBLIC_KEY: blankAsAbsent,
  OPENBRAIN_TRACING_SECRET_KEY: blankAsAbsent,
  OPENBRAIN_TRACING_ENABLED: strictOneFlag,
  OPENBRAIN_TRACING_MASKING_ENABLED: strictZeroDisablesFlag,
  // capture health — `server/capture/liveness-observer.ts:404-408`, read via
  // the exported name constants rather than a literal member expression.
  OPENBRAIN_CAPTURE_HEALTH_NAMESPACE: blankAsAbsent,
  OPENBRAIN_CAPTURE_HEALTH_WINDOW_MINUTES: fallbackInteger(1, 360),
  OPENBRAIN_CAPTURE_HEALTH_REFRESH_MS: fallbackInteger(1, 60_000),
  // http — `server/main.ts:313` and `:362`.
  ALLOWED_ORIGINS: originList,
  PORT: fallbackInteger(1, 3100),
} as const;

type ExtendedEnvironment = z.infer<z.ZodObject<typeof extendedEnvironmentFields>>;

/** No namespace is legacy by default; #167 retired `collab`. */
const DEFAULT_LEGACY_SHARED_NAMESPACE = "";
/** Ruled default observation window: 6 hours (ledger item 28). */
const DEFAULT_CAPTURE_WINDOW_MINUTES = 360;

export interface SearchConfigGroup {
  /** Milliseconds the query-embedding call may take before degrading. */
  readonly embeddingTimeoutMs: number;
}

export interface FtsConfigGroup {
  /** Deployment-wide corpus default for full-text search. */
  readonly corpusConfig: FtsConfig;
}

export interface QmdConfigGroup {
  /** Path to the qmd binary, absent when federation is not configured. */
  readonly path?: string;
}

export interface RecoveryConfigGroup {
  /** WAL file path, `null` when the store runs without durable backing. */
  readonly walPath: string | null;
}

export interface SharedNamespaceGroup {
  readonly physical: string;
  readonly legacy: string;
  readonly legacyFallbackEnabled: boolean;
  readonly fallbackMinResults: number;
}

export interface TracingConfigGroup {
  /** True only when the flag is set AND all three coordinates are present. */
  readonly enabled: boolean;
  readonly maskingEnabled: boolean;
  readonly endpoint: string;
  readonly publicKey: string;
  /** Never logged and never emitted in `/health`. */
  readonly secretKey: string;
}

export interface CaptureHealthGroup {
  /** Absent means NO observer — never a guessed tenant (ledger item 28). */
  readonly namespace?: string;
  readonly windowMinutes: number;
  readonly refreshMs: number;
}

export interface HttpConfigGroup {
  readonly port: number;
  /** Empty means no origin is permitted, never every origin. */
  readonly allowedOrigins: readonly string[];
}

/**
 * The search timeout, preferring the current name over the legacy one.
 *
 * Both names are typed as optional strings rather than parsed integers because
 * the FALLBACK is between the names, not between a value and a default:
 * `OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS=abc` must not fall through to
 * `SEARCH_EMBEDDING_TIMEOUT_MS`, it must fall through to 3000 — which is what
 * `server/tools/search-engine.ts:148` does, since it picks the name first and
 * parses second.
 */
export function searchGroup(parsed: ExtendedEnvironment): SearchConfigGroup {
  const raw =
    parsed.OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS ??
    parsed.SEARCH_EMBEDDING_TIMEOUT_MS;
  if (raw === undefined) return { embeddingTimeoutMs: 3_000 };
  const value = Number.parseInt(raw, 10);
  return {
    embeddingTimeoutMs: Number.isNaN(value) || value < 1 ? 3_000 : value,
  };
}

export function ftsGroup(parsed: ExtendedEnvironment): FtsConfigGroup {
  return { corpusConfig: parsed.OPENBRAIN_FTS_CONFIG };
}

export function qmdGroup(parsed: ExtendedEnvironment): QmdConfigGroup {
  return parsed.QMD_PATH ? { path: parsed.QMD_PATH } : {};
}

export function recoveryGroup(parsed: ExtendedEnvironment): RecoveryConfigGroup {
  return { walPath: parsed.OPENBRAIN_RECOVERY_WAL_PATH ?? null };
}

/**
 * Physical and legacy shared-namespace names.
 *
 * The canonical name stays on `ServerConfig.sharedNamespace`, which is a
 * `"shared-kb"` literal by decision (`docs/decisions/shared-kb-canonical-namespace.md`).
 * The PHYSICAL name defaults to whatever the canonical override resolved to, so
 * the two are equal in every normal deployment and diverge only when an
 * operator points them apart during a migration —
 * `server/tools/shared-namespace.ts` header.
 */
export function sharedNamespaceGroup(
  parsed: ExtendedEnvironment,
  canonical: string,
): SharedNamespaceGroup {
  const resolvedCanonical = parsed.OPENBRAIN_SHARED_NAMESPACE ?? canonical;
  return {
    physical: parsed.SHARED_NAMESPACE_PHYSICAL ?? resolvedCanonical,
    legacy:
      parsed.SHARED_NAMESPACE_LEGACY ??
      parsed.OPENBRAIN_LEGACY_SHARED_NAMESPACE ??
      DEFAULT_LEGACY_SHARED_NAMESPACE,
    legacyFallbackEnabled: parsed.OPENBRAIN_LEGACY_SHARED_FALLBACK,
    fallbackMinResults: parsed.OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS,
  };
}

/**
 * Tracing coordinates, off unless the flag is set and all three are present.
 *
 * The opposite default to audit, deliberately: a payload-carrying export to an
 * external server is opt-in per deployment, never something a missing variable
 * turns on by accident (`server/observability/langfuse-tracing.ts:589-595`).
 * The incomplete-flag WARN stays with the reader, which owns a logger; this is
 * the pure derivation.
 */
export function tracingGroup(parsed: ExtendedEnvironment): TracingConfigGroup {
  const endpoint = parsed.OPENBRAIN_TRACING_ENDPOINT ?? "";
  const publicKey = parsed.OPENBRAIN_TRACING_PUBLIC_KEY ?? "";
  const secretKey = parsed.OPENBRAIN_TRACING_SECRET_KEY ?? "";
  const complete =
    endpoint.length > 0 && publicKey.length > 0 && secretKey.length > 0;
  return {
    enabled: parsed.OPENBRAIN_TRACING_ENABLED && complete,
    maskingEnabled: parsed.OPENBRAIN_TRACING_MASKING_ENABLED,
    endpoint,
    publicKey,
    secretKey,
  };
}

export function captureHealthGroup(
  parsed: ExtendedEnvironment,
): CaptureHealthGroup {
  const namespace = parsed.OPENBRAIN_CAPTURE_HEALTH_NAMESPACE;
  return {
    ...(namespace ? { namespace } : {}),
    windowMinutes:
      parsed.OPENBRAIN_CAPTURE_HEALTH_WINDOW_MINUTES ??
      DEFAULT_CAPTURE_WINDOW_MINUTES,
    refreshMs: parsed.OPENBRAIN_CAPTURE_HEALTH_REFRESH_MS,
  };
}

export function httpGroup(parsed: ExtendedEnvironment): HttpConfigGroup {
  return {
    port: parsed.PORT,
    allowedOrigins: parsed.ALLOWED_ORIGINS,
  };
}
