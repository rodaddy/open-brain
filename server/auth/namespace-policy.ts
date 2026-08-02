/**
 * Server-owned namespace policy and SQL predicates.
 *
 * Design authority: `docs/identity-boundary.md` requires token-derived lane
 * identity and promoter-only shared truth writes; `docs/decisions/
 * shared-kb-canonical-namespace.md` fixes `shared-kb` as canonical and rejects
 * legacy external writes; `docs/decisions/admin-and-promoter-identities.md`
 * grants promoter cross-namespace work but denies the `all` keyword.
 */
import type { AuthIdentity } from "./types.ts";

export type NamespaceOperation = "read" | "write" | "delete";

export interface NamespacePredicate {
  readonly clause: string;
  readonly values: readonly unknown[];
}

const GLOBAL_ROLES = new Set(["admin", "ob-admin"]);
const LEGACY_SHARED_NAMESPACE = "collab";
const SHARED_NAMESPACE = "shared-kb";

function isGlobal(identity: AuthIdentity): boolean {
  return GLOBAL_ROLES.has(identity.role) && identity.namespaceSource === "token";
}

function readNamespaces(identity: AuthIdentity): readonly string[] | undefined {
  if (isGlobal(identity) || identity.role === "promoter") return undefined;
  return [identity.clientId, SHARED_NAMESPACE];
}

function mutationNamespaces(identity: AuthIdentity): readonly string[] | undefined {
  if (isGlobal(identity) || identity.role === "promoter") return undefined;
  return [identity.clientId];
}

/** Build an auth-derived predicate for ID-based reads and mutations. */
export function namespacePredicate(
  identity: AuthIdentity,
  operation: NamespaceOperation,
  startParameter = 1,
): NamespacePredicate {
  const namespaces = operation === "read" ? readNamespaces(identity) : mutationNamespaces(identity);
  if (namespaces === undefined) return { clause: "", values: [] };
  return {
    clause: ` AND namespace = ANY($${startParameter}::text[])`,
    values: [namespaces],
  };
}

/** Decide whether a requested named namespace is allowed for this identity. */
export function canTargetNamespace(
  identity: AuthIdentity,
  operation: NamespaceOperation,
  requestedNamespace: string,
): boolean {
  if (requestedNamespace === "all") return isGlobal(identity) && operation === "read";
  if (requestedNamespace === LEGACY_SHARED_NAMESPACE) return false;
  if (operation === "read") return readNamespaces(identity)?.includes(requestedNamespace) ?? true;
  if (requestedNamespace === SHARED_NAMESPACE) return identity.role === "promoter";
  if (identity.role === "promoter") return true;
  if (isGlobal(identity)) return requestedNamespace !== SHARED_NAMESPACE;
  return requestedNamespace === identity.clientId;
}

/** Apply trusted admin delegation without accepting a caller-supplied identity. */
export function delegateNamespace(
  identity: AuthIdentity,
  requestedNamespace: string,
): AuthIdentity | undefined {
  if (!GLOBAL_ROLES.has(identity.role)) return undefined;
  if (requestedNamespace === "all" || requestedNamespace === LEGACY_SHARED_NAMESPACE) return undefined;
  return { ...identity, clientId: requestedNamespace, namespaceSource: "delegated" };
}
