import { z } from "zod";
import { logger } from "../../src/logger.ts";
import { SECTION_NAMES } from "../../src/tools/agent-context-pack.ts";
import type { FleetEnvelope, NamespaceSource } from "./nats-runtime.ts";
import {
  buildEnvelope,
  envelopeFromBytes,
  EnvelopeError,
  RESPONSE_FROM,
  RESPONSE_KIND,
} from "./nats-runtime.ts";
import type { NatsRequestMessage } from "./nats-bridge-types.ts";

export function parseEnvelope(data: Uint8Array): FleetEnvelope {
  return envelopeFromBytes(data, (version) => {
    // Forward-compat: a newer producer's envelope is accepted but never silently.
    logger.warn("NATS context-pack envelope version ahead of supported", {
      version,
    });
  });
}

export function buildResponseEnvelope(
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

export function natsError(
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

export function errorMessageFromPayload(payload: unknown): string {
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
export function undeliverableReplyEnvelope(
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
export function requestedSectionsFromRequest(data: Uint8Array): string[] {
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

export function namespaceSourceFromResponse(
  response: FleetEnvelope,
): NamespaceSource | null {
  const source = (response.payload as { namespace_source?: unknown }).namespace_source;
  return typeof source === "string" ? (source as NamespaceSource) : null;
}

export function responseOutcome(response: FleetEnvelope): string {
  const payload = response.payload as { status?: unknown; error?: unknown };
  const status = typeof payload.status === "string" ? payload.status : "unknown";
  if (status !== "error") return status;
  const error = payload.error as { code?: unknown } | undefined;
  return typeof error?.code === "string" ? `error:${error.code}` : "error";
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Redaction: return a STATIC allowlisted string, never err.name (mutable and
// attacker-influenced) or err.message (may embed a NATS url with credentials).
export function safeErrorType(err: unknown): string {
  if (err instanceof SyntaxError) return "SyntaxError";
  if (err instanceof z.ZodError) return "ZodError";
  if (err instanceof EnvelopeError) return "EnvelopeError";
  if (err instanceof Error) return "Error";
  return typeof err;
}

export function isNatsRequestValidationError(err: unknown): boolean {
  return (
    err instanceof SyntaxError ||
    err instanceof z.ZodError ||
    err instanceof EnvelopeError
  );
}

export function logNatsHandlerError(err: unknown, subject: string): void {
  logger.error("NATS context-pack bridge request failed", {
    subject,
    error_type: safeErrorType(err),
  });
}

export function logNatsRequestError(err: unknown, subject: string): void {
  logger.error("NATS context-pack bridge request failed", {
    subject,
    error_type: safeErrorType(err),
  });
}

export function logNatsSubscriptionError(err: unknown, subject: string): void {
  logger.error("NATS context-pack bridge subscription failed", {
    subject,
    error_type: safeErrorType(err),
  });
}
