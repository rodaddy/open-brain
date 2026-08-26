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
 *
 * Every name here arrives from the validated `ServerConfig`; this module reads no
 * environment of its own, so a call site that forgets to pass the set gets an
 * error naming the function rather than a default that quietly mis-binds.
 */

import type { SharedNamespaceGroup } from "../config/env-groups.ts";

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
 * Assert that the composition root supplied the validated name set.
 *
 * The names arrive from `ServerConfig` and nowhere else — this module reads no
 * environment. A missing set is a wiring defect at the call site, so it fails
 * loudly here rather than resolving to a default that would silently point an
 * isolation predicate at the wrong partition.
 *
 * @param names The set handed down from the composition root, if any.
 * @param caller Name of the function whose call site is wired wrong.
 * @returns The same set, now known to be present.
 */
function requireNames(
  names: SharedNamespaceGroup | undefined,
  caller: string,
): SharedNamespaceGroup {
  if (names) return names;
  throw new Error(
    `${caller}: shared-namespace names are missing. The composition root must ` +
      `supply sharedNamespaceNames from the validated ServerConfig.`,
  );
}

/**
 * Pass through the validated shared-namespace name set.
 *
 * Kept as a named accessor so existing call sites read the same way; it adds no
 * resolution of its own and throws when the names were never wired through.
 *
 * @param names The set handed down from the composition root.
 * @returns The same set.
 */
export function sharedNamespaceConfig(
  names?: SharedNamespaceGroup,
): SharedNamespaceGroup {
  return requireNames(names, "sharedNamespaceConfig");
}

/**
 * @param namespace Caller-supplied or stored namespace name.
 * @param names Validated set from the composition root.
 * @returns Whether the name refers to shared truth, canonical or physical.
 */
export function isSharedNamespace(
  namespace: string,
  names?: SharedNamespaceGroup,
): boolean {
  const config = requireNames(names, "isSharedNamespace");
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
 *
 * @param namespace Stored namespace name.
 * @param names Validated set from the composition root.
 * @returns The canonical name callers should see.
 */
export function canonicalNamespace(
  namespace: string,
  names?: SharedNamespaceGroup,
): string {
  const config = requireNames(names, "canonicalNamespace");
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
 *
 * @param namespace Caller-supplied namespace name.
 * @param names Validated set from the composition root.
 * @returns The physical name a predicate binds.
 */
export function physicalNamespace(
  namespace: string,
  names?: SharedNamespaceGroup,
): string {
  const config = requireNames(names, "physicalNamespace");
  return namespace === config.canonicalSharedNamespace
    ? config.physicalSharedNamespace
    : namespace;
}
