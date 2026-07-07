import type { AuthInfo } from "./types.ts";
import type { ToolDeps } from "./tools/index.ts";
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
  close(): Promise<void>;
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
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_NATS_REQUEST_BYTES = 64 * 1024;

export async function startNatsContextPackBridge(
  options: StartNatsContextPackBridgeOptions,
): Promise<NatsBridgeRuntime | null> {
  if (
    options.boundary.requested_transport !== "nats" ||
    options.boundary.nats.availability !== "available"
  ) {
    return null;
  }

  const driver =
    options.driver ??
    (await createNatsJsDriver(options.boundary.nats.url));
  const subject = options.boundary.nats.context_pack_subject;
  const subscription = await driver.subscribe(subject, async (message) => {
    const response = handleNatsContextPackMessage({
      message,
      boundary: options.boundary,
      tokenMap: options.tokenMap,
      deps: options.deps,
    });
    const responded = await message.respond(encoder.encode(JSON.stringify(response)));
    if (responded === false) {
      throw new Error("NATS request did not include a reply inbox");
    }
  });

  return {
    subject,
    availability: "available",
    close: async () => {
      await subscription.close();
      await driver.close();
    },
  };
}

export function handleNatsContextPackMessage(input: {
  message: Pick<NatsRequestMessage, "subject" | "data" | "headers">;
  boundary: NatsRuntimeBoundary;
  tokenMap: Map<string, AuthInfo>;
  deps: ToolDeps;
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
  return token ? tokenMap.get(token) ?? null : null;
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

async function createNatsJsDriver(url: string | null): Promise<NatsBridgeDriver> {
  if (!url) {
    throw new Error("OPENBRAIN_NATS_URL is required when NATS bridge is enabled");
  }

  const nats = await import("nats");
  const connection = await nats.connect({ servers: url });

  return {
    subscribe: async (subject, handler) => {
      const subscription = connection.subscribe(subject);
      let closed = false;

      void (async () => {
        try {
          for await (const message of subscription) {
            if (closed) break;
            await processNatsSubscriptionMessage(message, handler);
          }
        } catch (err) {
          if (!closed) {
            logNatsSubscriptionError(err, subject);
          }
        }
      })();

      return {
        close: () => {
          closed = true;
          subscription.unsubscribe();
        },
      };
    },
    close: async () => {
      await connection.drain();
    },
  };
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
    error: err instanceof Error ? err.message : String(err),
  });
}

function logNatsSubscriptionError(err: unknown, subject: string): void {
  logger.error("NATS context-pack bridge subscription failed", {
    subject,
    error: err instanceof Error ? err.message : String(err),
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
