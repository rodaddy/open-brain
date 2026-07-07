import type { AuthInfo } from "./types.ts";
import type { ToolDeps } from "./tools/index.ts";
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
  respond(data: Uint8Array): void | Promise<void>;
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

export interface StartNatsContextPackBridgeOptions {
  boundary: NatsRuntimeBoundary;
  tokenMap: Map<string, AuthInfo>;
  deps: ToolDeps;
  driver?: NatsBridgeDriver;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
    await message.respond(encoder.encode(JSON.stringify(response)));
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

    const envelope = parseEnvelope(input.message.data);
    requestId = envelope.request_id;
    const auth = authFromHeaders(input.message.headers, input.tokenMap);
    if (!auth) {
      return natsError(requestId, "permission_denied", "Bearer token is required");
    }

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
    return natsError(
      requestId,
      "bad_request",
      err instanceof Error ? err.message : String(err),
    );
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
        for await (const message of subscription) {
          if (closed) break;
          await handler({
            subject: message.subject,
            data: message.data,
            headers: headersToRecord(message.headers),
            respond: (data) => {
              void message.respond(data);
            },
          });
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

function headersToRecord(
  headers: { keys(): string[]; get(key: string): string } | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const record: Record<string, string> = {};
  for (const key of headers.keys()) {
    record[key] = headers.get(key);
  }
  return record;
}
