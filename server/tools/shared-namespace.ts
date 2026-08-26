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

import type { SharedNamespaceGroup } from "../config/env-groups.ts";

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

/**
 * The shared-namespace name set.
 *
 * Declared in `server/config/env-groups.ts` as `SharedNamespaceGroup` and
 * re-exported here under its historical name so callers do not change: the
 * dependency direction only runs one way, and `server/config` must never
 * import from `server/tools`.
 */
export type { SharedNamespaceGroup as SharedNamespaceConfig };

/**
 * Resolve the shared-namespace configuration from the environment.
 *
 * Read on every call rather than cached at module load: tests and operators
 * both repoint these values at runtime, and a cached copy would silently serve
 * a stale namespace to the predicate that enforces isolation.
 *
 * @param names When supplied, the already-validated set from `ServerConfig` is
 * used verbatim and the environment is not consulted. Omitting it preserves the
 * historical environment-derived behavior exactly; the reads below go away in a
 * later rung, once every caller passes the value down.
 */
export function sharedNamespaceConfig(
  names?: SharedNamespaceGroup,
): SharedNamespaceGroup {
  if (names) return names;
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
    legacyFallbackEnabled: envBoolean(
      "OPENBRAIN_LEGACY_SHARED_FALLBACK",
      false,
    ),
    fallbackMinResults: envPositiveInteger(
      "OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS",
      DEFAULT_FALLBACK_MIN_RESULTS,
    ),
  };
}

/** @returns Whether the name refers to shared truth, canonical or physical. */
export function isSharedNamespace(
  namespace: string,
  names?: SharedNamespaceGroup,
): boolean {
  const config = sharedNamespaceConfig(names);
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
export function canonicalNamespace(
  namespace: string,
  names?: SharedNamespaceGroup,
): string {
  const config = sharedNamespaceConfig(names);
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
export function physicalNamespace(
  namespace: string,
  names?: SharedNamespaceGroup,
): string {
  const config = sharedNamespaceConfig(names);
  return namespace === config.canonicalSharedNamespace
    ? config.physicalSharedNamespace
    : namespace;
}
