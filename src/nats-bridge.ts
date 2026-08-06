import type { AuthInfo } from "./types.ts";
import type { ToolDeps } from "./tools/index.ts";
import {
  BackgroundTraceRecorder,
  type BackgroundTraceEmitter,
} from "./background-tracing.ts";
import { z } from "zod";
import { findAuthInfoForToken } from "./auth.ts";
import { logger } from "./logger.ts";
import {
  buildAgentContextPackPayload,
  parseAgentContextPackArgs,
  SECTION_NAMES,
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
  /**
   * The broker's OWN advertised payload figure for this connection, in bytes,
   * as reported by the server in its INFO (`connection.info.max_payload`).
   *
   * REPO LAW for this seam: never substitute a constant of our own here. The
   * figure differs per broker (this fleet's local broker advertises 8 MiB; the
   * NATS protocol default is 1 MiB), so a hardcoded number would either refuse
   * replies the broker would have carried or keep letting undeliverable ones
   * through. `undefined` means the driver could not read it — in that case the
   * bridge does not pre-judge the reply and simply publishes.
   */
  maxPayloadBytes?: number;
  respond(data: Uint8Array): boolean | void | Promise<boolean | void>;
}

export interface NatsSubscriptionHandle {
  close(): Promise<void> | void;
}

export interface NatsBridgeDriver {
  /**
   * Deliver messages under the driver's native acknowledgement contract.
   * A resolved handler means processing completed. A rejected handler must
   * propagate unchanged: the driver must not synthesize an acknowledgement or
   * swallow the rejection, so broker-native error/redelivery behavior remains
   * authoritative.
   */
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
  tracing?: BackgroundTraceEmitter;
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
    const traceStart = {
      name: "nats.message",
      input: { subject: message.subject, bytes: message.data.byteLength },
      tags: ["open-brain-server", "background-job", "nats"],
      metadata: {
        subject: message.subject,
        ...(hasDeclaredSessionKey(message.data)
          ? { declared_session_key_unverified: "[MASKED:unverified]" }
          : {}),
      },
      sessionId: undefined as string | undefined,
    };
    const trace = new BackgroundTraceRecorder(options.tracing, traceStart);
    try {
      const response = await trace.span(
        "nats.handle",
        () =>
          handleNatsContextPackMessage({
            message,
            boundary: options.boundary,
            tokenMap: options.tokenMap,
            deps: options.deps,
            health,
            onResolvedBinding: (binding) => {
              traceStart.sessionId = binding.sessionId;
            },
          }),
        {
          input: { subject: message.subject },
          output: (value) => ({
            outcome: responseOutcome(value),
            correlation_id: value.correlation_id ?? null,
          }),
        },
      );
      const reply = await trace.span(
        "nats.reply",
        () => respondWithinBrokerFigure(message, response),
        {
          input: { subject: message.subject },
          output: (value) => value,
        },
      );
      trace.finish({
        subject: message.subject,
        outcome: responseOutcome(response),
        reply_outcome: reply.outcome,
        ...(reply.error === undefined ? {} : { error: reply.error }),
      });
    } catch (error: unknown) {
      trace.fail(error);
      throw error;
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

function hasDeclaredSessionKey(data: Uint8Array): boolean {
  try {
    const envelope = envelopeFromBytes(data);
    const payload = envelope.payload as { identity?: unknown } | undefined;
    const identity = payload?.identity as { session_key?: unknown } | undefined;
    return typeof identity?.session_key === "string" && identity.session_key.length > 0;
  } catch (error: unknown) {
    logger.debug("NATS trace declared session key unavailable", {
      error_type: safeErrorType(error),
    });
    return false;
  }
}

function responseOutcome(response: FleetEnvelope): string {
  const payload = response.payload as { status?: unknown; error?: unknown };
  const status = typeof payload.status === "string" ? payload.status : "unknown";
  if (status !== "error") return status;
  const error = payload.error as { code?: unknown } | undefined;
  return typeof error?.code === "string" ? `error:${error.code}` : "error";
}

interface NatsReplyResult {
  outcome:
    | "published"
    | "undeliverable_error_published"
    | "error_envelope_exceeded"
    | "no_reply_inbox";
  error?: Record<string, unknown>;
}

/**
 * Publish a reply, answering an undeliverable one with an error envelope.
 *
 * THE DEFECT THIS CLOSES (#549): the handler finishes its work, builds a large
 * pack, and the reply publish cannot be carried. In the real nats.js client
 * that surfaces as a THROW, not a false return: `Msg.respond()` publishes
 * through `protocol.publish()`, which raises `NatsError(MaxPayloadExceeded)`
 * once the encoded length passes `info.max_payload`
 * (`nats-base-client/msg.js` -> `protocol.js`). The old code let that throw
 * escape to `processNatsSubscriptionMessage`, whose catch logged the generic
 * "NATS context-pack bridge request failed" and published NOTHING — so the
 * caller waited out its own timeout with no client-visible reason. A measured
 * live case built a 58.5 MB reply against a broker advertising 8 MiB.
 *
 * `respond()` returns false in exactly ONE case: the request carried no reply
 * inbox at all. That condition is real but unrelated to size, which is why the
 * "no reply inbox" reading is kept for it and only for it, below.
 *
 * The answer is an error envelope, never silence. Three paths reach it:
 *   (a) the encoded reply exceeds the broker's OWN advertised figure, which we
 *       compare against BEFORE publishing so we never spend a doomed publish;
 *   (b) the publish THROWS `MaxPayloadExceeded` anyway — the advertised figure
 *       was unreadable, so the reply was never pre-judged and the broker's own
 *       client rejected it. Matched by error CODE, never by message text, so a
 *       reworded client string cannot silently reopen the defect. Any other
 *       throw is not ours to interpret and is rethrown unchanged;
 *   (c) `respond()` returns false — no reply inbox. We answer with the same
 *       envelope, and if that is refused too the reading below is accurate.
 *
 * The error envelope is CONTENT-FREE: it names what happened, the measured
 * reply bytes, the broker's advertised figure, and which sections were asked
 * for. No pack data crosses into it, so an undeliverable reply cannot leak
 * through the error path.
 *
 * This changes only how an undeliverable reply is ANSWERED. What the handler
 * builds is untouched — the pack is still built in full, and nothing here
 * reshapes, shortens, or withholds any part of it.
 *
 * If the error envelope ITSELF cannot be published there is nothing further the
 * bridge can do on the wire, so it logs accurately and gives up — that case is
 * a genuinely missing reply inbox.
 */
async function respondWithinBrokerFigure(
  message: NatsRequestMessage,
  response: FleetEnvelope,
): Promise<NatsReplyResult> {
  const encoded = envelopeToBytes(response);
  const advertised = message.maxPayloadBytes;
  const exceedsAdvertised =
    typeof advertised === "number" &&
    Number.isFinite(advertised) &&
    advertised > 0 &&
    encoded.byteLength > advertised;

  if (!exceedsAdvertised) {
    // The advertised figure was unreadable or the reply fits it, so the publish
    // is worth attempting. It can still be rejected by the client itself, and
    // the real nats.js client rejects by THROWING rather than returning false —
    // an unguarded call here would let that escape to the handler-error catch
    // and hand the caller silence, which is the whole #549 defect.
    try {
      const responded = await message.respond(encoded);
      if (responded !== false) return { outcome: "published" };
    } catch (err) {
      if (!isMaxPayloadExceededError(err)) throw err;
    }
  }

  const undeliverable = undeliverableReplyEnvelope(
    message,
    response,
    encoded.byteLength,
    advertised,
  );
  let respondedWithError: boolean | void;
  try {
    respondedWithError = await message.respond(envelopeToBytes(undeliverable));
  } catch (err) {
    if (!isMaxPayloadExceededError(err)) throw err;
    // Even the content-free envelope was rejected against the advertised
    // figure. The bridge has nothing further it can put on the wire, so it
    // records what happened and stops.
    logger.error("NATS error envelope exceeded the broker's advertised figure", {
      subject: message.subject,
      reply_bytes: encoded.byteLength,
      broker_advertised_bytes: advertised ?? null,
    });
    return {
      outcome: "error_envelope_exceeded",
      error: {
        code: "payload_too_large",
        reply_bytes: encoded.byteLength,
        broker_advertised_bytes: advertised ?? null,
      },
    };
  }

  if (respondedWithError === false) {
    // Only now is "no reply inbox" the accurate reading: the client returns
    // false for exactly one condition, and it is not about the figure.
    logger.error("NATS reply could not be published to a reply inbox", {
      subject: message.subject,
      reply_bytes: encoded.byteLength,
    });
    return {
      outcome: "no_reply_inbox",
      error: { code: "reply_inbox_missing", reply_bytes: encoded.byteLength },
    };
  }

  logger.warn("NATS reply exceeded the broker's advertised payload figure", {
    subject: message.subject,
    reply_bytes: encoded.byteLength,
    broker_advertised_bytes: advertised ?? null,
    correlation_id: response.correlation_id,
  });
  return {
    outcome: "undeliverable_error_published",
    error: {
      code: "payload_too_large",
      reply_bytes: encoded.byteLength,
      broker_advertised_bytes: advertised ?? null,
    },
  };
}

/**
 * The nats.js client's own code for a publish it will not carry.
 *
 * `ErrorCode.MaxPayloadExceeded` in `nats-base-client/core.js`. Reproduced as a
 * literal rather than imported so this seam stays testable without a live
 * client and so the bridge's own driver interface (which is what the tests
 * drive) does not gain a hard dependency on the client's module shape.
 */
const NATS_MAX_PAYLOAD_EXCEEDED_CODE = "MAX_PAYLOAD_EXCEEDED";

/**
 * Is this the client's refusal to carry a publish of this length?
 *
 * Matched on the error's `code`, NEVER on its message text. `NatsError` carries
 * a stable machine code while its message is prose the client is free to
 * reword; matching prose would reopen #549 silently on a client upgrade.
 */
function isMaxPayloadExceededError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === NATS_MAX_PAYLOAD_EXCEEDED_CODE
  );
}

/**
 * Build the content-free error envelope for a reply the broker will not carry.
 *
 * Reuses the EXISTING wire error shape (`status`/`operation`/`namespace_source`
 * /`error{code,message}`) and the existing `payload_too_large` code, so nothing
 * about the cross-language contract changes — no fixture and no Python mirror
 * edit. It echoes the same `correlation_id` a normal reply would, which is what
 * lets the waiting caller match this to its request instead of timing out.
 *
 * The message states measurements only — what the reply weighed, what the
 * broker advertises, what was asked for. It prescribes nothing about how the
 * caller should react; that is the operator's call, not this envelope's.
 */
function undeliverableReplyEnvelope(
  message: NatsRequestMessage,
  response: FleetEnvelope,
  replyBytes: number,
  advertisedBytes: number | undefined,
): FleetEnvelope {
  const sections = requestedSectionsFromRequest(message.data);
  const advertisedText =
    typeof advertisedBytes === "number"
      ? `${advertisedBytes} bytes`
      : "not advertised by the broker";
  const sectionsText = sections.length > 0 ? sections.join(", ") : "default";
  return buildResponseEnvelope(response.correlation_id ?? response.id, {
    status: "error",
    operation: "agent_context_pack",
    namespace_source: namespaceSourceFromResponse(response),
    error: {
      code: "payload_too_large",
      message:
        "The broker refused to carry this context pack reply. " +
        `Reply was ${replyBytes} bytes; the broker advertises ${advertisedText}. ` +
        `Requested sections: ${sectionsText}.`,
    },
  });
}

/**
 * Read the requested section names back off the INBOUND request bytes.
 *
 * Best-effort and deliberately defensive: this runs on the failure path, where
 * the one thing that must not happen is a second failure. Anything unparseable
 * or unexpected yields an empty list, and the error envelope says "default".
 * Only known section names are echoed, so arbitrary caller text cannot be
 * reflected back into the error message.
 */
function requestedSectionsFromRequest(data: Uint8Array): string[] {
  try {
    const envelope = envelopeFromBytes(data);
    const payload = envelope.payload as { body?: unknown } | undefined;
    const body = payload?.body as { requested_sections?: unknown } | undefined;
    const requested = body?.requested_sections;
    if (!Array.isArray(requested)) return [];
    const known = new Set<string>(SECTION_NAMES);
    return requested.filter(
      (name): name is string => typeof name === "string" && known.has(name),
    );
  } catch {
    return [];
  }
}

function namespaceSourceFromResponse(
  response: FleetEnvelope,
): NamespaceSource | null {
  const source = (response.payload as { namespace_source?: unknown })
    .namespace_source;
  return typeof source === "string" ? (source as NamespaceSource) : null;
}

interface LaneBinding {
  auth: AuthInfo;
  namespaceSource: NamespaceSource;
  sessionId: string;
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
    try {
      input.onResolvedBinding?.(binding);
    } catch (error: unknown) {
      logger.warn("NATS resolved-binding observer failed", {
        error_type: safeErrorType(error),
      });
    }

    const result = await buildAgentContextPackPayload(
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
              await processNatsSubscriptionMessage(
                message,
                handler,
                // Read the figure PER MESSAGE, not once at connect: nats.js
                // refreshes `connection.info` on reconnect, so a failover to a
                // broker advertising a different figure is picked up here
                // instead of being judged against a stale one.
                advertisedMaxPayloadBytes(connection),
              );
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
  maxPayloadBytes?: number,
  onError: (err: unknown, subject: string) => void = logNatsHandlerError,
): Promise<void> {
  try {
    await handler({
      subject: message.subject,
      data: message.data,
      headers: headersToRecord(message.headers),
      maxPayloadBytes,
      respond: (data) => {
        return message.respond(data);
      },
    });
  } catch (err) {
    onError(err, message.subject);
  }
}

/**
 * The broker's own advertised payload figure for this connection, in bytes.
 *
 * Sourced ONLY from the server's INFO (`connection.info.max_payload`) — the
 * bridge never supplies a figure of its own, because the correct value is
 * whatever THIS broker says it is and that differs between deployments. A
 * connection that has not yet reported INFO returns undefined, and the reply is
 * published without being pre-judged.
 */
function advertisedMaxPayloadBytes(connection: {
  info?: { max_payload?: number };
}): number | undefined {
  const advertised = connection.info?.max_payload;
  return typeof advertised === "number" && Number.isFinite(advertised) && advertised > 0
    ? advertised
    : undefined;
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
