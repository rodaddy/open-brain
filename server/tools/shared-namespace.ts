/**
 * Canonical vs physical shared-namespace resolution.
 *
 * Design authority: `docs/decisions/shared-kb-canonical-namespace.md`. `shared-kb`
 * is the ONE public name for shared truth. The legacy `collab` namespace was
 * retired in #167 — it is frozen and mirrored, not deleted — so this module
 * carries a deliberate two-name model:
 *
 *   - the CANONICAL name is what callers pass and what results report back, so a
 *     client never has to know which physical partition a row lives in;
 *   - the PHYSICAL name is what the `namespace` column actually holds, which is
 *     what a predicate must bind.
 *
 * They are equal in every normal deployment. They diverge only when an operator
 * points them apart during a migration, and the split exists so that window does
 * not require rewriting call sites. Read paths translate canonical -> physical
 * before building a predicate ({@link physicalNamespace}) and physical ->
 * canonical before emitting a row ({@link canonicalNamespace}); mixing those two
 * directions up is the failure this separation is here to make visible.
 *
 * There is NO default legacy namespace: `legacySharedNamespace` is `""` unless an
 * operator sets one. An empty legacy name must never match caller input, so every
 * legacy check below tests for non-empty FIRST — otherwise an unset config would
 * make `""` "legacy" and match unnamespaced input.
 */

/** Public name for shared truth when no operator override is configured. */
const DEFAULT_SHARED_NAMESPACE = "shared-kb";
/** No namespace is legacy by default; #167 retired `collab`. */
const DEFAULT_LEGACY_SHARED_NAMESPACE = "";
/** Shared hits below this count let the legacy fallback top up a result set. */
const DEFAULT_FALLBACK_MIN_RESULTS = 5;

/** First non-empty environment value among `names`, else `defaultValue`. */
function envString(names: readonly string[], defaultValue: string): string {
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (raw) return raw;
  }
  return defaultValue;
}

/** Parse a permissive boolean environment flag. */
function envBoolean(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Parse a positive-integer environment value, falling back when unusable. */
function envPositiveInteger(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

export interface SharedNamespaceConfig {
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
}

/**
 * Resolve the shared-namespace configuration from the environment.
 *
 * Read on every call rather than cached at module load: tests and operators
 * both repoint these values at runtime, and a cached copy would silently serve
 * a stale namespace to the predicate that enforces isolation.
 */
export function sharedNamespaceConfig(): SharedNamespaceConfig {
  const canonicalSharedNamespace = envString(
    ["SHARED_NAMESPACE_CANONICAL", "OPENBRAIN_SHARED_NAMESPACE"],
    DEFAULT_SHARED_NAMESPACE,
  );
  return {
    canonicalSharedNamespace,
    physicalSharedNamespace: envString(
      ["SHARED_NAMESPACE_PHYSICAL", "OPENBRAIN_SHARED_NAMESPACE"],
      canonicalSharedNamespace,
    ),
    legacySharedNamespace: envString(
      ["SHARED_NAMESPACE_LEGACY", "OPENBRAIN_LEGACY_SHARED_NAMESPACE"],
      DEFAULT_LEGACY_SHARED_NAMESPACE,
    ),
    legacyFallbackEnabled: envBoolean("OPENBRAIN_LEGACY_SHARED_FALLBACK", false),
    fallbackMinResults: envPositiveInteger(
      "OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS",
      DEFAULT_FALLBACK_MIN_RESULTS,
    ),
  };
}

/** @returns Whether the name refers to shared truth, canonical or physical. */
export function isSharedNamespace(namespace: string): boolean {
  const config = sharedNamespaceConfig();
  return (
    namespace === config.canonicalSharedNamespace ||
    namespace === config.physicalSharedNamespace
  );
}

/**
 * Translate a stored namespace to the name callers see.
 *
 * Applied to emitted rows so a result never exposes the physical partition or
 * the retired legacy name.
 */
export function canonicalNamespace(namespace: string): string {
  const config = sharedNamespaceConfig();
  if (
    config.legacySharedNamespace !== "" &&
    namespace === config.legacySharedNamespace
  ) {
    return config.canonicalSharedNamespace;
  }
  return namespace === config.physicalSharedNamespace
    ? config.canonicalSharedNamespace
    : namespace;
}

/**
 * Translate a caller-supplied namespace to the value a predicate binds.
 *
 * Applied before building SQL so an authorized canonical name matches the rows
 * that physically carry the partition name.
 */
export function physicalNamespace(namespace: string): string {
  const config = sharedNamespaceConfig();
  return namespace === config.canonicalSharedNamespace
    ? config.physicalSharedNamespace
    : namespace;
}
