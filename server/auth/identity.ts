/**
 * The `AuthInfo` -> `AuthIdentity` projection.
 *
 * It lives in the auth tier because both ends of it do: `AuthInfo`
 * (`server/types.ts`) is the legacy request identity and `AuthIdentity`
 * (`./types.ts`) is the server one. It sat in `server/tools/legacy-deps.ts`,
 * a translation barrel that also carries the legacy logger, `ToolDeps`, and
 * the shared-namespace config -- so `server/domain/read-policy.ts`, which
 * wants nothing but this field map, took an edge onto the whole tools tier to
 * get it. `legacy-deps` re-exports the name, so callers that reach it through
 * the barrel are unaffected.
 */
import type { AuthIdentity } from "./types.ts";
import type { AuthInfo } from "../types.ts";

/**
 * Map the legacy `AuthInfo` onto the server `AuthIdentity`.
 *
 * `tokenClientId` is optional on the legacy side and required on the server
 * side, so it falls back to `clientId`, which is what every legacy read of an
 * absent `tokenClientId` already resolved to. `namespaceSource` spells the
 * non-token case `"header"` on the legacy side and `"delegated"` on the server
 * side; the two name the same condition.
 */
export function authIdentityFor(auth: AuthInfo): AuthIdentity {
  return {
    role: auth.role,
    clientId: auth.clientId,
    tokenClientId: auth.tokenClientId ?? auth.clientId,
    namespaceSource: auth.namespaceSource === "token" ? "token" : "delegated",
  };
}
