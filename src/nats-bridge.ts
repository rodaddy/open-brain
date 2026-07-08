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
  NatsBridgePlan,
  NatsContextPackEnvelope,
  NatsRuntimeBoundary,
} from "./nats-runtime.ts";
import {
  contextPackEnvelopeSchema,
  mapNatsEnvelopeToToolArgs,
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_NATS_REQUEST_BYTES = 64 * 1024;
const NATS_RESUBSCRIBE_INITIAL_DELAY_MS = 25;
const NATS_RESUBSCRIBE_MAX_DELAY_MS = 1_000;
const NATS_EMPTY_SUBSCRIPTION_DEGRADE_THRESHOLD = 2;

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
    const responded = await message.respond(encoder.encode(JSON.stringify(response)));
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

export function handleNatsContextPackMessage(input: {
  message: Pick<NatsRequestMessage, "subject" | "data" | "headers">;
  boundary: NatsRuntimeBoundary;
  tokenMap: Map<string, AuthInfo>;
  deps: ToolDeps;
  health?: NatsBridgeHealth;
}): unknown {
  let requestId: string | null = null;

  try {
    if (input.message.subject !== input.boundary.nats.context_pack_subject) {
      throw new Error(
        `Unsupported NATS subject '${input.message.subject}'; expected '${input.boundary.nats.context_pack_subject}'`,
      );
    }

    const auth = authFromHeaders(input.message.headers, input.tokenMap);
    if (!auth) {
      return natsError(requestId, "permission_denied", "Bearer token is required");
    }
    if (input.message.data.byteLength > MAX_NATS_REQUEST_BYTES) {
      return natsError(requestId, "payload_too_large", "NATS request body is too large");
    }
    if (input.health && input.health.availability !== "available") {
      return natsError(
        requestId,
        "temporarily_unavailable",
        "NATS bridge is not available",
      );
    }

    const envelope = parseEnvelope(input.message.data);
    requestId = envelope.request_id;

    const result = buildAgentContextPackPayload(
      parseAgentContextPackArgs(mapNatsEnvelopeToToolArgs(envelope)),
      auth,
      input.deps,
    );

    if (result.isError) {
      return natsError(
        requestId,
        "tool_error",
        errorMessageFromPayload(result.payload),
      );
    }

    return {
      schema: "openbrain.nats.response.v1",
      request_id: requestId,
      status: "ok",
      operation: "agent_context_pack",
      body: result.payload,
    };
  } catch (err) {
    if (!isNatsRequestValidationError(err)) {
      logNatsRequestError(err, input.message.subject);
      return natsError(
        requestId,
        "internal_error",
        "NATS context pack request failed",
      );
    }
    return natsError(requestId, "bad_request", "Invalid NATS context pack request");
  }
}

function parseEnvelope(data: Uint8Array): NatsContextPackEnvelope {
  return contextPackEnvelopeSchema.parse(JSON.parse(decoder.decode(data)));
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

function natsError(
  requestId: string | null,
  code: string,
  message: string,
): unknown {
  return {
    schema: "openbrain.nats.response.v1",
    request_id: requestId,
    status: "error",
    operation: "agent_context_pack",
    error: { code, message },
  };
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

function safeErrorType(err: unknown): string {
  if (err instanceof SyntaxError) return "SyntaxError";
  if (err instanceof z.ZodError) return "ZodError";
  if (err instanceof Error) return "Error";
  return typeof err;
}

function isNatsRequestValidationError(err: unknown): boolean {
  return err instanceof SyntaxError || err instanceof z.ZodError;
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
