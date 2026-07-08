import type { AuthInfo } from "./types.ts";
import type { ToolDeps } from "./tools/index.ts";
import { z } from "zod";
import { findAuthInfoForToken } from "./auth.ts";
import { logger } from "./logger.ts";
import {
  buildAgentContextPackPayload,
  parseAgentContextPackArgs,
} from "./tools/agent-context-pack.ts";
import type {
  FleetEnvelope,
  NamespaceSource,
  NatsContextPackRequestPayload,
  NatsRuntimeBoundary,
} from "./nats-runtime.ts";
import {
  buildEnvelope,
  envelopeFromBytes,
  envelopeToBytes,
  EnvelopeError,
  mapRequestPayloadToToolArgs,
  REQUEST_KIND,
  requestPayloadSchema,
  RESPONSE_FROM,
  RESPONSE_KIND,
} from "./nats-runtime.ts";

export interface NatsRequestMessage {
  subject: string;
  data: Uint8Array;
  headers?: Record<string, string | undefined>;
  respond(data: Uint8Array): boolean | void | Promise<boolean | void>;
}

export interface NatsSubscriptionHandle {
  close(): Promise<void> | void;
}

export interface NatsBridgeDriver {
  subscribe(
    subject: string,
    handler: (message: NatsRequestMessage) => Promise<void>,
  ): Promise<NatsSubscriptionHandle>;
  close(): Promise<void> | void;
}

export interface NatsBridgeRuntime {
  subject: string;
  availability: "available";
  health: NatsBridgeHealth;
  close(): Promise<void>;
}

export interface NatsBridgeHealth {
  availability: "available" | "not_runtime_available";
  consecutiveFailures: number;
  lastError: string | null;
}

interface NatsSubscriptionHeaders {
  keys(): string[];
  get(key: string): string;
}

interface NatsSubscriptionMessage {
  subject: string;
  data: Uint8Array;
  headers?: NatsSubscriptionHeaders;
  respond(data: Uint8Array): boolean | void | Promise<boolean | void>;
}

export interface StartNatsContextPackBridgeOptions {
  boundary: NatsRuntimeBoundary;
  tokenMap: Map<string, AuthInfo>;
  deps: ToolDeps;
  driver?: NatsBridgeDriver;
  health?: NatsBridgeHealth;
}

const MAX_NATS_REQUEST_BYTES = 64 * 1024;
const NATS_RESUBSCRIBE_INITIAL_DELAY_MS = 25;
const NATS_RESUBSCRIBE_MAX_DELAY_MS = 1_000;
const NATS_EMPTY_SUBSCRIPTION_DEGRADE_THRESHOLD = 2;

// Role for the synthetic auth identity used on the trusted local bus when
// REQUIRE_AUTH is off. `agent` is deliberately non-privileged: it can only read
// its own namespace, so a declared/override namespace maps to exactly that
// namespace and cannot reach "all" or another tenant's data.
const LOCAL_BUS_ROLE = "agent" as const;

// NamespaceSource (the response-contract type) is owned by nats-runtime.ts; keep
// a re-export so existing importers of it from this module still resolve.
export type { NamespaceSource } from "./nats-runtime.ts";

// A namespace produced by a wire-declared identity/override must be a plausible
// namespace token, not arbitrary text. Mirrors the delegated-id shape used by
// the HTTP header-namespace path so the local bus cannot mint exotic namespaces.
const NAMESPACE_TOKEN_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function createNatsBridgeHealth(
  availability: NatsBridgeHealth["availability"] = "not_runtime_available",
): NatsBridgeHealth {
  return {
    availability,
    consecutiveFailures: 0,
    lastError: null,
  };
}

export async function startNatsContextPackBridge(
  options: StartNatsContextPackBridgeOptions,
): Promise<NatsBridgeRuntime | null> {
  if (
    options.boundary.requested_transport !== "nats" ||
    options.boundary.nats.availability !== "available"
  ) {
    return null;
  }

  const health = options.health ?? createNatsBridgeHealth("available");
  const driver =
    options.driver ??
    (await createNatsJsDriver(options.boundary.nats.url, health));
  markNatsBridgeAvailable(health);
  const subject = options.boundary.nats.context_pack_subject;
  const subscription = await driver.subscribe(subject, async (message) => {
    const response = handleNatsContextPackMessage({
      message,
      boundary: options.boundary,
      tokenMap: options.tokenMap,
      deps: options.deps,
      health,
    });
    const responded = await message.respond(envelopeToBytes(response));
    if (responded === false) {
      throw new Error("NATS request did not include a reply inbox");
    }
  });

  return {
    subject,
    availability: "available",
    health,
    close: async () => {
      markNatsBridgeUnavailable(health, "NATS bridge closed");
      const closeErrors: unknown[] = [];
      try {
        await subscription.close();
      } catch (err) {
        closeErrors.push(err);
      }
      try {
        await driver.close();
      } catch (err) {
        closeErrors.push(err);
      }
      if (closeErrors.length === 1) throw closeErrors[0];
      if (closeErrors.length > 1) {
        throw new AggregateError(closeErrors, "NATS bridge close failed");
      }
    },
  };
}

interface LaneBinding {
  auth: AuthInfo;
  namespaceSource: NamespaceSource;
}

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
function resolveLaneBinding(
  payload: NatsContextPackRequestPayload,
  envelope: FleetEnvelope,
  boundary: NatsRuntimeBoundary,
  auth: AuthInfo | null,
): LaneBinding | { rejected: true } {
  if (boundary.nats.require_auth) {
    // Auth ON: the bearer-derived identity is authoritative. Override is already
    // force-disabled at the boundary; we defensively ignore payload.namespace.
    if (!auth) return { rejected: true };
    return { auth, namespaceSource: "token" };
  }

  // Auth OFF (trusted local bus). Bind a synthetic non-privileged identity to
  // the resolved namespace so the server-side canReadNamespace check still runs
  // and can only ever grant that one namespace.
  if (payload.namespace && boundary.nats.allow_namespace_override) {
    const ns = normalizeNamespaceToken(payload.namespace);
    if (!ns) return { rejected: true };
    return { auth: localBusAuth(ns), namespaceSource: "override" };
  }

  const declared = declaredNamespace(payload, envelope);
  if (declared) {
    return { auth: localBusAuth(declared), namespaceSource: "declared" };
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

export function handleNatsContextPackMessage(input: {
  message: Pick<NatsRequestMessage, "subject" | "data" | "headers">;
  boundary: NatsRuntimeBoundary;
  tokenMap: Map<string, AuthInfo>;
  deps: ToolDeps;
  health?: NatsBridgeHealth;
}): FleetEnvelope {
  let requestId: string | null = null;
  let namespaceSource: NamespaceSource | null = null;

  try {
    if (input.message.subject !== input.boundary.nats.context_pack_subject) {
      throw new Error(
        `Unsupported NATS subject '${input.message.subject}'; expected '${input.boundary.nats.context_pack_subject}'`,
      );
    }

    if (input.message.data.byteLength > MAX_NATS_REQUEST_BYTES) {
      return natsError(requestId, null, "payload_too_large", "NATS request body is too large");
    }
    if (input.health && input.health.availability !== "available") {
      return natsError(
        requestId,
        null,
        "temporarily_unavailable",
        "NATS bridge is not available",
      );
    }

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
      return natsError(requestId, "rejected", "permission_denied", "Bearer token is required");
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

    const result = buildAgentContextPackPayload(
      // On the override/declared local-bus path the synthetic auth.clientId IS
      // the namespace, so tool args must NOT also carry a namespace (which would
      // be a second, un-vetted source). On the require_auth path the token's own
      // namespace governs and the wire namespace is dropped for the same reason.
      parseAgentContextPackArgs(mapRequestPayloadToToolArgs(payload)),
      binding.auth,
      input.deps,
    );

    if (result.isError) {
      return natsError(
        requestId,
        namespaceSource,
        "tool_error",
        errorMessageFromPayload(result.payload),
      );
    }

    return buildResponseEnvelope(requestId, {
      status: "ok",
      operation: "agent_context_pack",
      namespace_source: namespaceSource,
      body: result.payload,
    });
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

function parseEnvelope(data: Uint8Array): FleetEnvelope {
  return envelopeFromBytes(data, (version) => {
    // Forward-compat: a newer producer's envelope is accepted but never silently.
    logger.warn("NATS context-pack envelope version ahead of supported", {
      version,
    });
  });
}

function authFromHeaders(
  headers: Record<string, string | undefined> | undefined,
  tokenMap: Map<string, AuthInfo>,
): AuthInfo | null {
  const raw =
    headers?.authorization ??
    headers?.Authorization ??
    headers?.AUTHORIZATION ??
    null;
  const match = /^Bearer\s+(.+)$/i.exec(raw ?? "");
  const token = match?.[1]?.trim();
  return token ? findAuthInfoForToken(token, tokenMap) : null;
}

function errorMessageFromPayload(payload: unknown): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error?: unknown }).error === "string"
  ) {
    return (payload as { error: string }).error;
  }
  return "NATS context pack request failed";
}

function buildResponseEnvelope(
  requestId: string | null,
  payload: Record<string, unknown>,
): FleetEnvelope {
  return buildEnvelope({
    // A response to an unparseable request has no request id; use a stable
    // placeholder so the envelope's non-empty id/from/kind invariant holds.
    id: requestId ?? "unknown",
    ts: new Date().toISOString(),
    from: RESPONSE_FROM,
    kind: RESPONSE_KIND,
    // correlation_id echoes the request id so the caller can match reply->request.
    correlation_id: requestId,
    payload,
  });
}

function natsError(
  requestId: string | null,
  namespaceSource: NamespaceSource | null,
  code: string,
  message: string,
): FleetEnvelope {
  return buildResponseEnvelope(requestId, {
    status: "error",
    operation: "agent_context_pack",
    namespace_source: namespaceSource,
    error: { code, message },
  });
}

async function createNatsJsDriver(
  url: string | null,
  health: NatsBridgeHealth,
): Promise<NatsBridgeDriver> {
  if (!url) {
    throw new Error("OPENBRAIN_NATS_URL is required when NATS bridge is enabled");
  }

  const nats = await import("nats");
  const connection = await nats.connect({ servers: url });

  return {
    subscribe: async (subject, handler) => {
      let subscription = connection.subscribe(subject);
      let closed = false;
      let resubscribeDelayMs = NATS_RESUBSCRIBE_INITIAL_DELAY_MS;
      let needsSubscription = false;
      let consecutiveEmptySubscriptions = 0;

      void (async () => {
        while (!closed) {
          if (needsSubscription) {
            try {
              subscription = connection.subscribe(subject);
              needsSubscription = false;
            } catch (err) {
              markNatsBridgeUnavailable(health, errorMessage(err));
              logNatsSubscriptionError(err, subject);
              resubscribeDelayMs = nextNatsResubscribeDelay(resubscribeDelayMs);
              await delay(resubscribeDelayMs);
              continue;
            }
          }

          let processedMessage = false;
          try {
            for await (const message of subscription) {
              if (closed) break;
              processedMessage = true;
              consecutiveEmptySubscriptions = 0;
              markNatsBridgeAvailable(health);
              resubscribeDelayMs = NATS_RESUBSCRIBE_INITIAL_DELAY_MS;
              await processNatsSubscriptionMessage(message, handler);
            }
            if (!closed && !processedMessage) {
              consecutiveEmptySubscriptions += 1;
              if (
                consecutiveEmptySubscriptions >=
                NATS_EMPTY_SUBSCRIPTION_DEGRADE_THRESHOLD
              ) {
                markNatsBridgeUnavailable(
                  health,
                  "NATS subscription ended without messages",
                );
              }
            }
          } catch (err) {
            if (!closed) {
              consecutiveEmptySubscriptions = 0;
              markNatsBridgeUnavailable(health, errorMessage(err));
              logNatsSubscriptionError(err, subject);
            }
          }
          needsSubscription = true;
          if (!closed && !processedMessage) {
            resubscribeDelayMs = nextNatsResubscribeDelay(resubscribeDelayMs);
          }

          if (!closed) {
            await delay(resubscribeDelayMs);
          }
        }
      })();

      return {
        close: () => {
          closed = true;
          markNatsBridgeUnavailable(health, "NATS bridge closed");
          subscription.unsubscribe();
        },
      };
    },
    close: async () => {
      await connection.drain();
    },
  };
}

function nextNatsResubscribeDelay(currentMs: number): number {
  return Math.min(currentMs * 2, NATS_RESUBSCRIBE_MAX_DELAY_MS);
}

function markNatsBridgeAvailable(health: NatsBridgeHealth): void {
  health.availability = "available";
  health.consecutiveFailures = 0;
  health.lastError = null;
}

function markNatsBridgeUnavailable(
  health: NatsBridgeHealth,
  message: string,
): void {
  health.availability = "not_runtime_available";
  health.consecutiveFailures += 1;
  health.lastError = message;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Redaction: return a STATIC allowlisted string, never err.name (mutable and
// attacker-influenced) or err.message (may embed a NATS url with credentials).
function safeErrorType(err: unknown): string {
  if (err instanceof SyntaxError) return "SyntaxError";
  if (err instanceof z.ZodError) return "ZodError";
  if (err instanceof EnvelopeError) return "EnvelopeError";
  if (err instanceof Error) return "Error";
  return typeof err;
}

function isNatsRequestValidationError(err: unknown): boolean {
  return (
    err instanceof SyntaxError ||
    err instanceof z.ZodError ||
    err instanceof EnvelopeError
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processNatsSubscriptionMessage(
  message: NatsSubscriptionMessage,
  handler: (message: NatsRequestMessage) => Promise<void>,
  onError: (err: unknown, subject: string) => void = logNatsHandlerError,
): Promise<void> {
  try {
    await handler({
      subject: message.subject,
      data: message.data,
      headers: headersToRecord(message.headers),
      respond: (data) => {
        return message.respond(data);
      },
    });
  } catch (err) {
    onError(err, message.subject);
  }
}

function logNatsHandlerError(err: unknown, subject: string): void {
  logger.error("NATS context-pack bridge request failed", {
    subject,
    error_type: safeErrorType(err),
  });
}

function logNatsRequestError(err: unknown, subject: string): void {
  logger.error("NATS context-pack bridge request failed", {
    subject,
    error_type: safeErrorType(err),
  });
}

function logNatsSubscriptionError(err: unknown, subject: string): void {
  logger.error("NATS context-pack bridge subscription failed", {
    subject,
    error_type: safeErrorType(err),
  });
}

function headersToRecord(
  headers: NatsSubscriptionHeaders | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const record: Record<string, string> = {};
  for (const key of headers.keys()) {
    record[key] = headers.get(key);
  }
  return record;
}
