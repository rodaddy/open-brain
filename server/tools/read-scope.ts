/**
 * Read-scope resolution for the search and recall arms.
 *
 * Design authority: `docs/identity-boundary.md` (identity comes from the bearer
 * token, never from caller text), `docs/decisions/shared-kb-canonical-namespace.md`
 * (`shared-kb` is the canonical shared namespace and the legacy `collab` name is
 * frozen), and `docs/decisions/privilege-isolation-closed-brain.md` (isolation is
 * enforced server-side).
 *
 * This module answers ONE question — which namespaces may this identity read —
 * and it answers it in three shapes because the callers genuinely need three:
 *
 *   - {@link readableNamespaces} the list itself, or `undefined` for a role whose
 *     reads are intentionally global.
 *   - {@link namespaceFilterFor} the value the search arms bind: a single
 *     namespace when the caller named one, the readable list when it did not,
 *     `undefined` when the read is global.
 *   - {@link canReadNamespace} the yes/no gate a handler runs BEFORE it queries.
 *
 * `undefined` means "no predicate" in all three, and that is the sharp edge here:
 * a global role legitimately reads every namespace, so an accidental `undefined`
 * for a scoped role is a silent isolation failure rather than an error. Every
 * arm that binds one of these values has a test asserting the emitted SQL and
 * bound parameters (`server/tools/search-read-scope.test.ts`), because a
 * predicate that is silently WRONG still returns rows.
 */
import type { AuthIdentity } from "../auth/types.ts";
import { sharedNamespaceConfig, physicalNamespace } from "./shared-namespace.ts";

/** Namespace value bound by a search arm: one namespace, several, or none. */
export type NamespaceFilter = string | string[];

const GLOBAL_ROLES = new Set(["admin", "ob-admin"]);

/**
 * Roles whose reads are global by design.
 *
 * `promoter` is here with the two admin roles because promotion has to SOURCE
 * candidates from the namespaces it promotes out of (#147); it is not a
 * privilege escalation, it is the job. `namespaceSource === "delegated"` is
 * excluded: a delegated identity is acting for one namespace and must stay
 * inside it even when the underlying role is global.
 */
function isGlobalReader(identity: AuthIdentity): boolean {
  if (identity.namespaceSource === "delegated") return false;
  return GLOBAL_ROLES.has(identity.role) || identity.role === "promoter";
}

/**
 * Namespaces this identity may read.
 *
 * @param identity Token-derived identity.
 * @param options `includeLegacySharedFallback` adds the configured legacy shared
 *   namespace when the operator has explicitly set one. It is empty by default
 *   (#167 retired `collab`), so this normally changes nothing.
 * @returns The readable namespaces, or `undefined` when the read is global.
 */
export function readableNamespaces(
  identity: AuthIdentity,
  options: { includeLegacySharedFallback?: boolean } = {},
): string[] | undefined {
  const config = sharedNamespaceConfig();
  const shared = [config.physicalSharedNamespace];
  if (
    options.includeLegacySharedFallback === true &&
    config.legacySharedNamespace !== ""
  ) {
    shared.push(config.legacySharedNamespace);
  }
  // A delegated identity is scoped to the namespace it was delegated for, even
  // when the underlying role would otherwise read globally.
  if (identity.namespaceSource === "delegated") {
    return [identity.clientId, ...shared];
  }
  if (isGlobalReader(identity)) return undefined;
  return [identity.clientId, ...shared];
}

/**
 * Decide whether an explicitly requested namespace is readable.
 *
 * Run this BEFORE querying: it is the gate that turns an unauthorized namespace
 * argument into a denial instead of an empty result set, which is what makes the
 * denial observable rather than indistinguishable from "nothing matched".
 *
 * @param identity Token-derived identity.
 * @param namespace The caller-supplied namespace argument.
 * @returns Whether the identity may read that namespace.
 */
export function canReadNamespace(
  identity: AuthIdentity,
  namespace: string,
): boolean {
  const config = sharedNamespaceConfig();
  // The `all` keyword is a global-role-only read; it is never a way for a scoped
  // identity to widen itself, and a delegated identity cannot use it at all.
  if (namespace === "all") {
    return (
      identity.namespaceSource !== "delegated" && GLOBAL_ROLES.has(identity.role)
    );
  }
  // The legacy shared name stays reachable only for break-glass admin roles; a
  // scoped caller reads the canonical name and gets the migrated rows.
  if (
    config.legacySharedNamespace !== "" &&
    namespace === config.legacySharedNamespace &&
    !GLOBAL_ROLES.has(identity.role)
  ) {
    return false;
  }
  const allowed = readableNamespaces(identity);
  return allowed === undefined || allowed.includes(physicalNamespace(namespace));
}

/**
 * Resolve the namespace value a search arm binds.
 *
 * @param identity Token-derived identity.
 * @param namespace The caller-supplied namespace argument, already authorized by
 *   {@link canReadNamespace}. Passing an unauthorized namespace here would bind
 *   it, which is exactly why the gate runs first at every call site.
 * @param options Forwarded to {@link readableNamespaces}.
 * @returns One namespace, the readable list, or `undefined` for a global read.
 */
export function namespaceFilterFor(
  identity: AuthIdentity,
  namespace?: string,
  options: { includeLegacySharedFallback?: boolean } = {},
): NamespaceFilter | undefined {
  if (
    namespace === "all" &&
    identity.namespaceSource !== "delegated" &&
    GLOBAL_ROLES.has(identity.role)
  ) {
    return undefined;
  }
  if (namespace !== undefined) return physicalNamespace(namespace);
  return readableNamespaces(identity, options);
}

/**
 * Append an auth-derived namespace predicate to a parameterized query.
 *
 * The namespace VALUES are always bound, never interpolated. Only the column
 * name is inlined, and it is a compile-time literal chosen by the caller — never
 * caller-supplied text.
 *
 * @param identity Token-derived identity.
 * @param params Parameter array, mutated in place with the bound namespaces.
 * @param column Qualified column to constrain, e.g. `t.namespace`.
 * @param options Forwarded to {@link readableNamespaces}.
 * @returns The SQL fragment, or `""` when the read is global.
 */
export function appendReadNamespacePredicate(
  identity: AuthIdentity,
  params: unknown[],
  column = "namespace",
  options: { includeLegacySharedFallback?: boolean } = {},
): string {
  const namespaces = readableNamespaces(identity, options);
  if (namespaces === undefined) return "";
  params.push(namespaces);
  return ` AND ${column} = ANY($${params.length}::text[])`;
}
