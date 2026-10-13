/**
 * The ambient-config, legacy-`AuthInfo` call form of read-scope resolution
 * (issue 841).
 *
 * Design authority: `docs/identity-boundary.md`,
 * `docs/decisions/shared-kb-canonical-namespace.md`,
 * `docs/decisions/privilege-isolation-closed-brain.md`.
 *
 * WHY THIS MODULE IS AN ADAPTER AND NOT AN IMPLEMENTATION. Namespace read
 * scoping is an isolation boundary (`docs/sme/security.md`), and until issue 841
 * the same four decisions existed twice: once here over `AuthInfo` and the
 * ambient shared-namespace config, once in `server/domain/read-scope.ts` over
 * `AuthIdentity` and an explicitly-passed name set. Two bodies means a security
 * fix can land in one and not the other -- and one already had: the delegated-
 * `namespace=all` refusal recorded in
 * `docs/sme/entries/2026-08-03-a-wildcard-namespace-value-must-not-erase-the-scope-for-a-delegated-call.md`.
 * There is now exactly ONE implementation, `server/domain/read-scope.ts`, and
 * this file is the call-form bridge. Nothing below decides anything: every
 * function projects its two inputs and forwards, so predicates, verdicts, the
 * emitted SQL clause and parameter placement are unchanged.
 *
 * The two projections, and why each is a projection rather than a decision:
 *
 *   - IDENTITY. `authIdentityFor` (`server/auth/identity.ts`) is the repo's
 *     one `AuthInfo` -> `AuthIdentity` mapping. The scoped-caller sentinel is
 *     spelled `"header"` on the legacy side and `"delegated"` on the server
 *     side; the two name the same condition, and reusing that mapping here is
 *     what keeps the naming difference from becoming a second policy.
 *   - NAME SET. `read-scope.ts` REQUIRES the validated set and throws when it is
 *     omitted, because a call site that forgets it must fail loudly rather than
 *     bind a default. These call sites never had one to pass, so the ambient
 *     bridge supplies it -- the same set, resolved from `server/config.ts`
 *     rather than threaded from the composition root.
 */
import { sharedNamespaceConfig } from "../security/shared-namespace-ambient.ts";
import { authIdentityFor } from "../auth/identity.ts";
import {
  appendReadNamespacePredicate as appendReadNamespacePredicateFor,
  canReadNamespace as canReadNamespaceFor,
  namespaceFilterFor as namespaceFilterForIdentity,
  readableNamespaces as readableNamespacesFor,
} from "./read-scope.ts";
import type { AuthInfo } from "../types.ts";

/** Namespaces this identity may read, or `undefined` for a global read. */
export function readableNamespaces(
  auth: AuthInfo,
  options: { includeLegacySharedFallback?: boolean } = {},
): string[] | undefined {
  return readableNamespacesFor(authIdentityFor(auth), options, sharedNamespaceConfig());
}

/** Whether an explicitly requested namespace is readable by this identity. */
export function canReadNamespace(auth: AuthInfo, namespace: string): boolean {
  return canReadNamespaceFor(authIdentityFor(auth), namespace, sharedNamespaceConfig());
}

/** The namespace value a read arm binds: one namespace, several, or none. */
export function namespaceFilterFor(
  auth: AuthInfo,
  namespace?: string,
  options: { includeLegacySharedFallback?: boolean } = {},
): string | string[] | undefined {
  return namespaceFilterForIdentity(
    authIdentityFor(auth),
    namespace,
    options,
    sharedNamespaceConfig(),
  );
}

/** Append the auth-derived namespace predicate to a parameterized query. */
export function appendReadNamespacePredicate(
  auth: AuthInfo,
  params: unknown[],
  column = "namespace",
  options: { includeLegacySharedFallback?: boolean } = {},
): string {
  return appendReadNamespacePredicateFor(authIdentityFor(auth), params, column, {
    ...options,
    names: sharedNamespaceConfig(),
  });
}
