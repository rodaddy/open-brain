/**
 * Bearer authentication as an Express boundary.
 *
 * Design authority: `docs/identity-boundary.md` — the bearer token is the
 * identity boundary and caller-supplied text is never identity. The behavior
 * being preserved is `src/auth.ts:96-143`'s `authMiddleware`, including the
 * delegation rules that live there:
 *
 * - `X-Namespace` may be honored ONLY for `admin`/`ob-admin`. `promoter` is a
 *   service identity writing under its own token authority, not a proxy, so a
 *   promoter presenting the header is a 403, not a silent downgrade to its own
 *   namespace. Silently ignoring the header is the dangerous variant: the
 *   caller believes it wrote somewhere it did not.
 * - Both delegated values are shape-validated before they reach `req.auth`,
 *   because everything downstream treats `auth.clientId` as a trusted
 *   namespace string and interpolates it into predicates.
 *
 * WHY THIS IS AN ADAPTER AND NOT A SECOND IMPLEMENTATION. The token comparison
 * itself stays in `./tokens.ts` (constant-time, `resolveBearerToken`). This
 * module owns only the HTTP-shaped part: where the token comes from, which
 * headers may modify identity, and what the refusal looks like. That split is
 * why `resolveBearerToken` is testable without Express and why this file has no
 * knowledge of how a token maps to a role.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AuthTokenConfig } from "../config.ts";
import type { AuthIdentity } from "./types.ts";
import { resolveBearerToken } from "./tokens.ts";

/**
 * Shape a delegated namespace or agent id must satisfy.
 *
 * Copied deliberately from `src/auth.ts:24` rather than loosened: it bounds the
 * length and forbids the punctuation that would let a delegated value read as
 * something structural downstream.
 */
const DELEGATED_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** Identity as it is attached to a request, including delegation provenance. */
export interface RequestAuthInfo extends AuthIdentity {
  readonly agentId?: string;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]?.trim() || undefined;
  return value?.trim() || undefined;
}

/** Read the identity a prior `authenticate` attached, if any. */
export function requestAuth(request: Request): RequestAuthInfo | undefined {
  return (request as Request & { auth?: RequestAuthInfo }).auth;
}

/**
 * Build the Express handler that turns a bearer token into `req.auth`.
 *
 * `req.auth` is the exact property the MCP SDK's streamable-HTTP server reads
 * (`const authInfo = req.auth`) to populate a tool handler's `extra.authInfo`,
 * so this middleware is the only reason a tool can derive a namespace predicate
 * at all. Mounting it is not optional decoration on the MCP routes.
 */
export function createAuthMiddleware(
  configuredTokens: readonly AuthTokenConfig[],
): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      response.status(401).json({ error: "Missing Bearer token" });
      return;
    }
    const identity = resolveBearerToken(
      header.slice("Bearer ".length),
      configuredTokens,
    );
    if (!identity) {
      response.status(401).json({ error: "Invalid token" });
      return;
    }
    const namespace = headerValue(request.headers["x-namespace"]);
    if (namespace && identity.role !== "admin" && identity.role !== "ob-admin") {
      response
        .status(403)
        .json({ error: "Role not permitted to delegate namespace" });
      return;
    }
    if (namespace && !DELEGATED_ID_RE.test(namespace)) {
      response.status(400).json({ error: "Invalid X-Namespace header" });
      return;
    }
    const agentId = headerValue(request.headers["x-agent-id"]);
    if (agentId && !DELEGATED_ID_RE.test(agentId)) {
      response.status(400).json({ error: "Invalid X-Agent-Id header" });
      return;
    }
    (request as Request & { auth?: RequestAuthInfo }).auth = {
      role: identity.role,
      clientId: namespace ?? identity.clientId,
      tokenClientId: identity.clientId,
      namespaceSource: namespace ? "delegated" : "token",
      ...(agentId ? { agentId } : {}),
    };
    next();
  };
}
