/**
 * The validated-name-set shared-namespace call form (issue 841): a call-form
 * adapter over the one implementation in `server/security/shared-namespace.ts`,
 * which owns every namespace decision. Nothing here decides anything.
 *
 * See docs/decisions/shared-namespace-adapter-two-name-model.md
 * Design authority: docs/decisions/shared-kb-canonical-namespace.md
 */

import type { SharedNamespaceGroup } from "../config/env-groups.ts";
import type { AuthInfo } from "../types.ts";
import type { SharedNamespaceEnv } from "../security/shared-namespace.ts";
import {
  canonicalNamespace as canonicalNamespaceWith,
  isLegacySharedNamespace as isLegacySharedNamespaceWith,
  isSharedNamespace as isSharedNamespaceWith,
  physicalNamespace as physicalNamespaceWith,
  shouldRejectLegacySharedWrite as shouldRejectLegacySharedWriteWith,
} from "../security/shared-namespace.ts";

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
 * Project an already-validated name set back into the resolver's raw shape.
 *
 * The one implementation takes {@link SharedNamespaceEnv} — the eight raw
 * environment values — because it is the module that owns precedence and
 * defaulting. A validated group has already been through that resolution, so
 * each field maps to the single raw key that reproduces it verbatim: the
 * per-name keys win over the `OPENBRAIN_*` fallbacks, and the booleans and the
 * count are written in the spellings the resolver's own parsers accept. The
 * round trip is exact, which is what lets this file hold no decision of its own.
 *
 * @param names The validated set from the composition root.
 * @returns Raw values that resolve back to exactly that set.
 */
function asEnv(names: SharedNamespaceGroup): SharedNamespaceEnv {
  return {
    sharedNamespaceCanonical: names.canonicalSharedNamespace,
    sharedNamespacePhysical: names.physicalSharedNamespace,
    sharedNamespaceLegacy: names.legacySharedNamespace,
    legacySharedFallback: names.legacyFallbackEnabled ? "1" : "0",
    sharedFallbackMinResults: String(names.fallbackMinResults),
    allowLegacySharedWrites: names.allowLegacySharedWrites ? "1" : "0",
  };
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
  return isSharedNamespaceWith(
    namespace,
    asEnv(requireNames(names, "isSharedNamespace")),
  );
}

/**
 * Whether the name is the configured legacy shared namespace.
 *
 * True only when a non-empty legacy namespace is configured AND matches. With
 * the default (empty) legacy name, no input is ever legacy — that non-empty
 * test is what stops an unconfigured deployment treating unnamespaced input as
 * legacy.
 *
 * @param namespace Caller-supplied or stored namespace name.
 * @param names Validated set from the composition root.
 * @returns Whether the name is the configured legacy shared namespace.
 */
export function isLegacySharedNamespace(
  namespace: string,
  names?: SharedNamespaceGroup,
): boolean {
  return isLegacySharedNamespaceWith(
    namespace,
    asEnv(requireNames(names, "isLegacySharedNamespace")),
  );
}

/**
 * Whether a write into the legacy shared namespace must be refused.
 *
 * The legacy namespace is frozen (#167): only an admin role may still write
 * into it, and only while an operator has both configured a legacy name and
 * left the escape hatch off. Every earlier test is a "not applicable" case, so
 * the role check is reached only for a genuine legacy-target write.
 *
 * @param auth The caller's authenticated identity.
 * @param targetNamespace The namespace the write is aimed at.
 * @param names Validated set from the composition root.
 * @returns Whether the write must be refused.
 */
export function shouldRejectLegacySharedWrite(
  auth: AuthInfo,
  targetNamespace: string,
  names?: SharedNamespaceGroup,
): boolean {
  return shouldRejectLegacySharedWriteWith(
    auth,
    targetNamespace,
    asEnv(requireNames(names, "shouldRejectLegacySharedWrite")),
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
  return canonicalNamespaceWith(
    namespace,
    asEnv(requireNames(names, "canonicalNamespace")),
  );
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
  return physicalNamespaceWith(
    namespace,
    asEnv(requireNames(names, "physicalNamespace")),
  );
}
