import type { AuthInfo } from "../types.ts";
import type { ToolDeps } from "../../src/tools/index.ts";
import { findAuthInfoForToken } from "./auth.ts";
import { logger } from "../../src/logger.ts";
import {
  buildAgentContextPackPayload,
  parseAgentContextPackArgs,
} from "../../src/tools/agent-context-pack.ts";
import type {
  FleetEnvelope,
  NamespaceSource,
  NatsContextPackRequestPayload,
  NatsRuntimeBoundary,
} from "./nats-runtime.ts";
import {
  EnvelopeError,
  mapRequestPayloadToToolArgs,
  REQUEST_KIND,
  requestPayloadSchema,
} from "./nats-runtime.ts";
import type {
  LaneBinding,
  NatsBridgeHealth,
  NatsRequestMessage,
} from "./nats-bridge-types.ts";
import { MAX_NATS_REQUEST_BYTES } from "./nats-bridge-types.ts";
import {
  buildResponseEnvelope,
  errorMessageFromPayload,
  isNatsRequestValidationError,
  logNatsRequestError,
  natsError,
  parseEnvelope,
  safeErrorType,
} from "./nats-bridge-envelope.ts";

// Role for the synthetic auth identity used on the trusted local bus when
// REQUIRE_AUTH is off. `agent` is deliberately non-privileged: it can only read
// its own namespace, so a declared/override namespace maps to exactly that
// namespace and cannot reach "all" or another tenant's data.
const LOCAL_BUS_ROLE = "agent" as const;

// A namespace produced by a wire-declared identity/override must be a plausible
// namespace token, not arbitrary text. Mirrors the delegated-id shape used by
// the HTTP header-namespace path so the local bus cannot mint exotic namespaces.
const NAMESPACE_TOKEN_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * Resolve the auth identity + namespace binding for a request.
 *
 * REPO LAW: namespace is a security boundary. The override path exists ONLY on
 * the trusted local bus with auth off. When REQUIRE_AUTH=true the boundary
 * force-disables the override (require_auth and allow_namespace_override are
 * mutually exclusive in readNatsRuntimeBoundary), so a client-supplied namespace
 * can NEVER override the token-derived one.
 *
 * Resolution order:
 *   (a) require_auth=true  -> a valid bearer is mandatory; the token's AuthInfo
 *       governs; wire namespace is ignored. namespace_source is "token" so a
 *       token-derived binding is distinguishable from a wire-derived one.
 *   (b) explicit payload.namespace AND override allowed -> use it ("override").
 *   (c) else derive namespace from the declared identity -> "declared".
 *   (d) else unroutable -> reject ("rejected"); NEVER fall through to a global
 *       or shared namespace.
 *
 * Returns the rejection source on the error branch so it can still be stamped.
 */
export function resolveLaneBinding(
  payload: NatsContextPackRequestPayload,
  envelope: FleetEnvelope,
  boundary: NatsRuntimeBoundary,
  auth: AuthInfo | null,
): LaneBinding | { rejected: true } {
  if (boundary.nats.require_auth) {
    // Auth ON: the bearer-derived identity is authoritative. Override is already
    // force-disabled at the boundary; we defensively ignore payload.namespace.
    if (!auth) return { rejected: true };
    return {
      auth,
      namespaceSource: "token",
      sessionId: payload.identity.session_key,
    };
  }

  // Auth OFF (trusted local bus). Bind a synthetic non-privileged identity to
  // the resolved namespace so the server-side canReadNamespace check still runs
  // and can only ever grant that one namespace.
  if (payload.namespace && boundary.nats.allow_namespace_override) {
    const ns = normalizeNamespaceToken(payload.namespace);
    if (!ns) return { rejected: true };
    return {
      auth: localBusAuth(ns),
      namespaceSource: "override",
      sessionId: payload.identity.session_key,
    };
  }

  const declared = declaredNamespace(payload, envelope);
  if (declared) {
    return {
      auth: localBusAuth(declared),
      namespaceSource: "declared",
      sessionId: payload.identity.session_key,
    };
  }

  return { rejected: true };
}

function localBusAuth(namespace: string): AuthInfo {
  return { role: LOCAL_BUS_ROLE, clientId: namespace };
}

function normalizeNamespaceToken(value: string): string | null {
  const trimmed = value.trim();
  return NAMESPACE_TOKEN_RE.test(trimmed) ? trimmed : null;
}

/**
 * Derive a namespace from the declared identity. Prefers the envelope `from`
 * (the publisher id), then the payload identity agent, normalised to a valid
 * namespace token. Returns null when nothing usable is declared.
 */
function declaredNamespace(
  payload: NatsContextPackRequestPayload,
  envelope: FleetEnvelope,
): string | null {
  return (
    normalizeNamespaceToken(envelope.from) ??
    normalizeNamespaceToken(payload.identity.agent)
  );
}

/**
 * Read the Authorization header under any of the three casings a NATS producer
 * may have put on the wire. Returns null when none of them is present.
 */
function rawAuthorizationHeader(
  headers: Record<string, string | undefined> | undefined,
): string | null {
  return (
    headers?.authorization ?? headers?.Authorization ?? headers?.AUTHORIZATION ?? null
  );
}

export function authFromHeaders(
  headers: Record<string, string | undefined> | undefined,
  tokenMap: Map<string, AuthInfo>,
): AuthInfo | null {
  const raw = rawAuthorizationHeader(headers);
  const match = /^Bearer\s+(.+)$/i.exec(raw ?? "");
  const token = match?.[1]?.trim();
  return token ? findAuthInfoForToken(token, tokenMap) : null;
}

/**
 * The pre-flight refusals a request can meet before its envelope is parsed:
 * a subject that is not ours, a body over the request figure, and a bridge
 * that has already been marked unavailable. Returns null when the request may
 * proceed to envelope parsing.
 */
function preflightRefusal(input: {
  message: Pick<NatsRequestMessage, "subject" | "data">;
  boundary: NatsRuntimeBoundary;
  health?: NatsBridgeHealth;
}): FleetEnvelope | null {
  if (input.message.subject !== input.boundary.nats.context_pack_subject) {
    throw new Error(
      `Unsupported NATS subject '${input.message.subject}'; expected '${input.boundary.nats.context_pack_subject}'`,
    );
  }

  if (input.message.data.byteLength > MAX_NATS_REQUEST_BYTES) {
    return natsError(null, null, "payload_too_large", "NATS request body is too large");
  }
  if (input.health && input.health.availability !== "available") {
    return natsError(
      null,
      null,
      "temporarily_unavailable",
      "NATS bridge is not available",
    );
  }
  return null;
}

function notifyResolvedBinding(
  binding: LaneBinding,
  observer: ((binding: LaneBinding) => void) | undefined,
): void {
  try {
    observer?.(binding);
  } catch (error: unknown) {
    logger.warn("NATS resolved-binding observer failed", {
      error_type: safeErrorType(error),
    });
  }
}

/**
 * Build the pack for a bound request and shape it into a response envelope.
 */
async function buildBoundResponse(
  payload: NatsContextPackRequestPayload,
  binding: LaneBinding,
  deps: ToolDeps,
  requestId: string | null,
): Promise<FleetEnvelope> {
  const result = await buildAgentContextPackPayload(
    // On the override/declared local-bus path the synthetic auth.clientId IS
    // the namespace, so tool args must NOT also carry a namespace (which would
    // be a second, un-vetted source). On the require_auth path the token's own
    // namespace governs and the wire namespace is dropped for the same reason.
    parseAgentContextPackArgs(mapRequestPayloadToToolArgs(payload)),
    binding.auth,
    deps,
  );

  if (result.isError) {
    return natsError(
      requestId,
      binding.namespaceSource,
      "tool_error",
      errorMessageFromPayload(result.payload),
    );
  }

  return buildResponseEnvelope(requestId, {
    status: "ok",
    operation: "agent_context_pack",
    namespace_source: binding.namespaceSource,
    body: result.payload,
  });
}

export async function handleNatsContextPackMessage(input: {
  message: Pick<NatsRequestMessage, "subject" | "data" | "headers">;
  boundary: NatsRuntimeBoundary;
  tokenMap: Map<string, AuthInfo>;
  deps: ToolDeps;
  health?: NatsBridgeHealth;
  onResolvedBinding?: (binding: LaneBinding) => void;
}): Promise<FleetEnvelope> {
  let requestId: string | null = null;
  let namespaceSource: NamespaceSource | null = null;

  try {
    const refusal = preflightRefusal(input);
    if (refusal) return refusal;

    const envelope = parseEnvelope(input.message.data);
    requestId = envelope.id;

    // Reject any inbound envelope that is not a context_pack_request BEFORE we
    // touch the payload. Without this, a reply envelope (context_pack_response)
    // or an unrelated fleet message that happens to carry an agent_context_pack
    // payload on this subject would be processed as a real request — a
    // request/reply loop poisoning and scope hazard. EnvelopeError classifies as
    // bad_request via isNatsRequestValidationError.
    if (envelope.kind !== REQUEST_KIND) {
      throw new EnvelopeError(
        `NATS envelope kind '${envelope.kind}' is not '${REQUEST_KIND}'`,
      );
    }

    const payload = requestPayloadSchema.parse(envelope.payload);

    const auth = authFromHeaders(input.message.headers, input.tokenMap);
    if (input.boundary.nats.require_auth && !auth) {
      // Auth ON: a valid bearer is mandatory.
      return natsError(
        requestId,
        "rejected",
        "permission_denied",
        "Bearer token is required",
      );
    }

    const binding = resolveLaneBinding(payload, envelope, input.boundary, auth);
    if ("rejected" in binding) {
      namespaceSource = "rejected";
      return natsError(
        requestId,
        "rejected",
        "unroutable",
        "Request could not be bound to a namespace",
      );
    }
    namespaceSource = binding.namespaceSource;
    notifyResolvedBinding(binding, input.onResolvedBinding);

    return await buildBoundResponse(payload, binding, input.deps, requestId);
  } catch (err) {
    if (!isNatsRequestValidationError(err)) {
      logNatsRequestError(err, input.message.subject);
      return natsError(
        requestId,
        namespaceSource,
        "internal_error",
        "NATS context pack request failed",
      );
    }
    return natsError(
      requestId,
      namespaceSource,
      "bad_request",
      "Invalid NATS context pack request",
    );
  }
}
