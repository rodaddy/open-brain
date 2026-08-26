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

/** A refusal the handler should send instead of continuing the chain. */
interface AuthRefusal {
  readonly status: number;
  readonly error: string;
}

/**
 * Resolve the bearer token in the `Authorization` header to a token identity.
 *
 * Both failure modes stay distinct on purpose: a missing header and a header
 * carrying an unknown token are different operator problems, and collapsing
 * them into one message is what makes a misconfigured client unreadable.
 */
function authenticateBearerHeader(
  header: string | undefined,
  configuredTokens: readonly AuthTokenConfig[],
): AuthIdentity | AuthRefusal {
  if (!header?.startsWith("Bearer ")) {
    return { status: 401, error: "Missing Bearer token" };
  }
  const identity = resolveBearerToken(
    header.slice("Bearer ".length),
    configuredTokens,
  );
  if (!identity) return { status: 401, error: "Invalid token" };
  return identity;
}

function isRefusal(value: AuthIdentity | AuthRefusal): value is AuthRefusal {
  return "status" in value;
}

/**
 * Check that this role may delegate a namespace at all, then that the value
 * presented has the delegated-id shape.
 *
 * A role that may not delegate is refused rather than downgraded: silently
 * ignoring the header leaves the caller believing it wrote somewhere it did not.
 */
function checkDelegatedNamespace(
  namespace: string | undefined,
  role: AuthIdentity["role"],
): AuthRefusal | undefined {
  if (!namespace) return undefined;
  if (role !== "admin" && role !== "ob-admin") {
    return { status: 403, error: "Role not permitted to delegate namespace" };
  }
  if (!DELEGATED_ID_RE.test(namespace)) {
    return { status: 400, error: "Invalid X-Namespace header" };
  }
  return undefined;
}

/** Check the delegated agent id has the delegated-id shape. */
function checkDelegatedAgentId(
  agentId: string | undefined,
): AuthRefusal | undefined {
  if (agentId && !DELEGATED_ID_RE.test(agentId)) {
    return { status: 400, error: "Invalid X-Agent-Id header" };
  }
  return undefined;
}

/** Compose the token identity and the validated delegated values into `req.auth`. */
function buildRequestAuthInfo(
  identity: AuthIdentity,
  namespace: string | undefined,
  agentId: string | undefined,
): RequestAuthInfo {
  return {
    role: identity.role,
    clientId: namespace ?? identity.clientId,
    tokenClientId: identity.clientId,
    namespaceSource: namespace ? "delegated" : "token",
    ...(agentId ? { agentId } : {}),
  };
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
    const authenticated = authenticateBearerHeader(
      request.headers.authorization,
      configuredTokens,
    );
    if (isRefusal(authenticated)) {
      response
        .status(authenticated.status)
        .json({ error: authenticated.error });
      return;
    }
    const namespace = headerValue(request.headers["x-namespace"]);
    const agentId = headerValue(request.headers["x-agent-id"]);
    const refusal =
      checkDelegatedNamespace(namespace, authenticated.role) ??
      checkDelegatedAgentId(agentId);
    if (refusal) {
      response.status(refusal.status).json({ error: refusal.error });
      return;
    }
    (request as Request & { auth?: RequestAuthInfo }).auth =
      buildRequestAuthInfo(authenticated, namespace, agentId);
    next();
  };
}
