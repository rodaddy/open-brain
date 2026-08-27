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
 * WHY THE PARSERS MIRROR THEIR READER RATHER THAN BEING TIDIED. The bar for
 * this rung is start-equivalence: a deployment whose environment starts the
 * server today must still start it, with the same values. Several of these
 * readers deliberately IGNORE an unusable value and fall back rather than
 * failing — `searchEmbeddingTimeoutMs` (`server/tools/search-engine.ts:147`)
 * answers 3000 for `abc`, and `envPositiveInteger`
 * (`server/tools/shared-namespace.ts:52`) answers 5 for `-1`. Tightening any of
 * those into a hard rejection here would turn a currently-booting deployment
 * into `server_configuration_invalid` at startup, which is a behavior change
 * smuggled in under a typing change. So the fallback semantics are reproduced
 * exactly.
 *
 * WHICH PARSE FUNCTION, THOUGH — `Number` AND `parseInt` ARE NOT THE SAME. They
 * disagree in both directions (`Number("1e3")` is 1000, `parseInt("1e3")` is 1;
 * `Number("3000ms")` is `NaN`, `parseInt("3000ms")` is 3000), so a mirror is
 * only a mirror if it uses the reader's own function. Three helpers below, one
 * per reader shape, and each field's comment names the reader line it copies:
 * `fallbackInteger` for the `parseInt` readers, `numberPositiveInteger` for
 * `readPositiveInteger` (`server/capture/liveness-observer.ts:535`), and
 * `portNumber` for `server/main.ts:362`.
 *
 * ONE FIELD REJECTS, AND REJECTING IS THE EQUIVALENT ANSWER THERE. `PORT` is
 * the reader that does not fall back: `Number(...)` goes straight to
 * `server.listen(port)`, which THROWS on a non-integer or an out-of-range port,
 * so those environments crash the process today. Naming the bad variable in a
 * config issue is that same crash reached earlier and legibly. Substituting a
 * silent default would be the behavior change — it boots a deployment that does
 * not boot now, on a port nobody chose.
 *
 * The one place that is stricter is the shape, not the value: a field that is
 * documented as a positive integer is typed `number`, so a consumer reading it
 * cannot receive the string it would get from `process.env`.
 */
import { z } from "zod";
import {
  ftsConfigSchema,
  resolveFtsConfig,
  type FtsConfig,
} from "../tools/fts-config.ts";

/** Trim, and treat a blank value as absent. Present-but-empty is unset. */
const blankAsAbsent = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}, z.string().optional());

/**
 * A base-10 integer at or above `minimum`, falling back on anything else.
 *
 * Reproduces `Number.parseInt(raw, 10)` plus a range guard, which is what the
 * `parseInt`-shaped integer readers in section A do — `envPositiveInteger`
 * (`server/tools/shared-namespace.ts:52`) is the one this still serves.
 * `parseInt` is NOT `Number`: it accepts a trailing suffix, so `3000ms` is 3000
 * to that reader and must stay 3000 here. Using `z.coerce.number()` would
 * reject it and stop a deployment that boots today.
 *
 * The readers that use `Number` instead — `PORT` and the capture-health pair —
 * do NOT use this helper; mirroring `parseInt` onto them was the start-
 * equivalence defect this rung's review caught.
 */
function fallbackInteger(minimum: number, fallback: number) {
  return z.preprocess((value) => {
    if (typeof value !== "string" || value.trim() === "") return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
  }, z.number().int());
}

/**
 * A positive integer parsed the way `readPositiveInteger` parses one.
 *
 * Mirrors `server/capture/liveness-observer.ts:535-550` line for line:
 * `Number(raw.trim())`, then `Number.isFinite` + `Number.isInteger` + `> 0`,
 * else the fallback. NOT `parseInt`: that reader deliberately REJECTS anything
 * which is not a clean integer, so `10.5` is a rejected override there and must
 * not become a silent 10 here. `readPositiveInteger` is module-private, so it
 * is reproduced rather than called; the WARN it emits
 * (`capture_health_override_invalid`) stays with the reader, which owns a
 * logger, and this is the pure derivation.
 */
function numberPositiveInteger(fallback: number) {
  return z.preprocess((value) => {
    if (typeof value !== "string" || value.trim() === "") return fallback;
    const parsed = Number(value.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      return fallback;
    }
    return parsed;
  }, z.number().int());
}

/**
 * A port parsed the way `server/main.ts:362` parses one, rejecting unbindable.
 *
 * The reader is `Number(process.env.PORT ?? DEFAULT_PORT)` followed by
 * `server.listen(port)`, so `Number` semantics are exact here and `parseInt`
 * would be wrong in both directions: `""` is 0 (an ephemeral port, a real
 * deployment shape), `"1e3"` is 1000, `"0x10"` is 16, `" 42 "` is 42, and
 * `"3000ms"` is `NaN`.
 *
 * Where the reader produces a value `listen` THROWS on — a non-integer, or one
 * outside `0..65535` — this rejects with a config issue naming `PORT` instead.
 * That is start-equivalent: the process crashes today on exactly those inputs,
 * and an earlier named crash is the same outcome reached sooner. Substituting a
 * silent 3100 would not be: it would boot a deployment that does not boot now,
 * on a port nobody configured.
 */
const portNumber = z.preprocess(
  (value) => (typeof value === "string" ? Number(value) : 3_100),
  z
    .number()
    .int("PORT must be an integer port number that `listen` can bind")
    .min(0, "PORT must be between 0 and 65535")
    .max(65_535, "PORT must be between 0 and 65535"),
);

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
  (value) =>
    resolveFtsConfig(typeof value === "string" ? value.trim() : undefined),
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
  // search — `server/tools/search-engine.ts:147-152`. The legacy name is a
  // FALLBACK, not an alias: the preferred name wins even when both are set, so
  // an operator migrating can set the new one without unsetting the old.
  // RAW strings, deliberately not `blankAsAbsent`: the reader joins the two
  // names with `??`, which does NOT fall through on `""`, so
  // `OPENBRAIN_…=""` with the legacy name set answers 3000 today. Normalizing
  // blank to absent here would let the legacy value through instead.
  OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS: z.string().optional(),
  SEARCH_EMBEDDING_TIMEOUT_MS: z.string().optional(),
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
  OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES: permissiveBoolean,
  // tracing — `server/observability/langfuse-tracing.ts:599-604`.
  OPENBRAIN_TRACING_ENDPOINT: blankAsAbsent,
  OPENBRAIN_TRACING_PUBLIC_KEY: blankAsAbsent,
  OPENBRAIN_TRACING_SECRET_KEY: blankAsAbsent,
  OPENBRAIN_TRACING_ENABLED: strictOneFlag,
  OPENBRAIN_TRACING_MASKING_ENABLED: strictZeroDisablesFlag,
  // capture health — names at `server/capture/liveness-observer.ts:404-408`,
  // read via the exported name constants rather than a literal member
  // expression; the PARSE is `readPositiveInteger` at `:535-550`, which is
  // `Number`-based, not `parseInt`-based.
  OPENBRAIN_CAPTURE_HEALTH_NAMESPACE: blankAsAbsent,
  OPENBRAIN_CAPTURE_HEALTH_WINDOW_MINUTES: numberPositiveInteger(360),
  OPENBRAIN_CAPTURE_HEALTH_REFRESH_MS: numberPositiveInteger(60_000),
  // http — `server/main.ts:313` (origins) and `:362` (port).
  ALLOWED_ORIGINS: originList,
  PORT: portNumber,
} as const;

type ExtendedEnvironment = z.infer<
  z.ZodObject<typeof extendedEnvironmentFields>
>;

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

/**
 * The full shared-namespace name set, canonical included.
 *
 * Field names match `server/tools/shared-namespace.ts`'s own reader shape
 * exactly, so the validated group can be handed straight to the helpers there
 * without a translation step that could invert a name. That module re-exports
 * this type under its historical name `SharedNamespaceConfig`; the type lives
 * HERE because `server/config` must never import from `server/tools`.
 */
export interface SharedNamespaceGroup {
  /** The name callers pass and results report. */
  readonly canonicalSharedNamespace: string;
  /** The name the `namespace` column actually holds. */
  readonly physicalSharedNamespace: string;
  /** Non-empty only while an operator has configured a migration source. */
  readonly legacySharedNamespace: string;
  /** Whether reads may top up from the legacy namespace. */
  readonly legacyFallbackEnabled: boolean;
  /** Shared-hit count at or above which the legacy fallback is skipped. */
  readonly fallbackMinResults: number;
  /** Physical shared namespace used by existing read/write call sites. */
  readonly sharedNamespace: string;
  /** Whether a non-admin may write into the configured legacy namespace. */
  readonly allowLegacySharedWrites: boolean;
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
 * Reproduces `searchEmbeddingTimeoutMs` (`server/tools/search-engine.ts:147-152`)
 * line for line, and both of the reader's quirks are load-bearing:
 *
 *   - the FALLBACK is between the NAMES, not between a value and a default, so
 *     `OPENBRAIN_…=abc` falls to 3000 rather than through to the legacy name —
 *     the reader picks the name first and parses second;
 *   - the join is `??`, which does NOT fall through on `""`. So
 *     `OPENBRAIN_…=""` with `SEARCH_EMBEDDING_TIMEOUT_MS=900` answers 3000,
 *     not 900. Both fields are therefore raw strings; blank-as-absent here
 *     would answer 900 and diverge from a live deployment.
 */
export function searchGroup(parsed: ExtendedEnvironment): SearchConfigGroup {
  const raw =
    parsed.OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS ??
    parsed.SEARCH_EMBEDDING_TIMEOUT_MS;
  if (!raw) return { embeddingTimeoutMs: 3_000 };
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

export function recoveryGroup(
  parsed: ExtendedEnvironment,
): RecoveryConfigGroup {
  return { walPath: parsed.OPENBRAIN_RECOVERY_WAL_PATH ?? null };
}

/**
 * Canonical, physical, and legacy shared-namespace names.
 *
 * `ServerConfig.sharedNamespace` remains the `"shared-kb"` literal by decision (`docs/decisions/shared-kb-canonical-namespace.md`).
 * The PHYSICAL name defaults to whatever the canonical override resolved to, so
 * the two are equal in every normal deployment and diverge only when an
 * operator points them apart during a migration —
 * `server/tools/shared-namespace.ts` header.
 *
 * PRECEDENCE IS THE READER'S, AND IT IS NOT THE SCHEMA'S DEFAULT. The reader is
 * `envString(["SHARED_NAMESPACE_CANONICAL", "OPENBRAIN_SHARED_NAMESPACE"], "shared-kb")`
 * (`server/tools/shared-namespace.ts:79-82`): the first NON-EMPTY trimmed value
 * in that order, so `SHARED_NAMESPACE_CANONICAL` wins. `parsed` cannot express
 * that, because the schema declares that name as a literal WITH a default
 * (`server/config.ts:167`) and so it is never absent there. The RAW value is
 * therefore threaded in: blank or absent means unset, exactly as `envString`
 * reads it. Namespace resolution is a security boundary
 * (`docs/sme/security.md`), so a precedence inversion here is not cosmetic even
 * while the consumer is un-rewired.
 */
export function sharedNamespaceGroup(
  parsed: ExtendedEnvironment,
  rawCanonical: string | undefined,
): SharedNamespaceGroup {
  const resolvedCanonical =
    rawCanonical?.trim() || parsed.OPENBRAIN_SHARED_NAMESPACE || "shared-kb";
  return {
    canonicalSharedNamespace: resolvedCanonical,
    physicalSharedNamespace:
      parsed.SHARED_NAMESPACE_PHYSICAL ?? resolvedCanonical,
    legacySharedNamespace:
      parsed.SHARED_NAMESPACE_LEGACY ??
      parsed.OPENBRAIN_LEGACY_SHARED_NAMESPACE ??
      DEFAULT_LEGACY_SHARED_NAMESPACE,
    legacyFallbackEnabled: parsed.OPENBRAIN_LEGACY_SHARED_FALLBACK,
    fallbackMinResults: parsed.OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS,
    sharedNamespace: parsed.SHARED_NAMESPACE_PHYSICAL ?? resolvedCanonical,
    allowLegacySharedWrites: parsed.OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES,
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
