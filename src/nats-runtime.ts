import { z } from "zod";
import { SECTION_NAMES } from "./tools/agent-context-pack.ts";

const NATS_CONTEXT_PACK_OPERATION = "agent_context_pack";
const DEFAULT_NATS_SUBJECT = "ob.memory.context_pack";
const MAX_CONTEXT_PACK_QUERY_CHARS = 4000;

const requestedSectionsSchema = z.array(z.enum(SECTION_NAMES));

const identitySchema = z.object({
  namespace_source: z.literal("authorization"),
  agent: z.string().min(1).max(200),
  platform: z.string().min(1).max(200),
  server_id: z.string().min(1).max(500),
  channel_id: z.string().min(1).max(500),
  thread_id: z.string().max(500).nullable().optional(),
  session_key: z.string().min(1).max(500),
});

export const contextPackEnvelopeSchema = z.object({
  schema: z.literal("openbrain.nats.request.v1"),
  operation: z.literal(NATS_CONTEXT_PACK_OPERATION),
  request_id: z.string().min(1).max(500),
  identity: identitySchema,
  body: z
    .object({
      query: z.string().min(1).max(MAX_CONTEXT_PACK_QUERY_CHARS),
      requested_sections: requestedSectionsSchema.optional(),
      include_unreviewed_recovery: z.boolean().optional(),
      budget: z
        .object({
          max_tokens: z.number().int().min(100).max(20_000).optional(),
          max_latency_ms: z.number().int().min(1).max(10_000).optional(),
        })
        .optional(),
    })
    .strict(),
  metadata: z.object({
    client: z.string().min(1).max(200),
    client_version: z.string().min(1).max(200),
    transport: z.literal("nats"),
    trace_id: z.string().max(500).optional(),
    route_name: z.string().max(200).optional(),
  }),
});

export type NatsContextPackEnvelope = z.infer<typeof contextPackEnvelopeSchema>;

export interface NatsRuntimeBoundary {
  requested_transport: "http" | "nats";
  fallback_transport: "http_mcp";
  nats: {
    availability: "available" | "not_runtime_available";
    url: string | null;
    context_pack_subject: string;
    fallback_http: boolean;
  };
}

export interface NatsUrlLogSummary {
  configured: boolean;
  protocol: string | null;
  contains_credentials: boolean;
}

export interface NatsBridgePlanInput {
  subject: string;
  envelope: unknown;
  bearerToken: string | null | undefined;
}

export interface NatsBridgePlan {
  status: "http_mcp_fallback";
  request_id: string;
  subject: string;
  operation: "agent_context_pack";
  bearerToken: string;
  mcpToolCall: {
    name: "agent_context_pack";
    arguments: {
      agent: string;
      platform: string;
      server_id: string;
      channel_id: string;
      thread_id?: string;
      session_key: string;
      query: string;
      requested_sections?: string[];
      include_unreviewed_recovery?: boolean;
      budget?: {
        max_tokens?: number;
        max_latency_ms?: number;
      };
    };
  };
}

export function mapNatsEnvelopeToToolArgs(
  envelope: NatsContextPackEnvelope,
): NatsBridgePlan["mcpToolCall"]["arguments"] {
  const toolArgs: NatsBridgePlan["mcpToolCall"]["arguments"] = {
    agent: envelope.identity.agent,
    platform: envelope.identity.platform,
    server_id: envelope.identity.server_id,
    channel_id: envelope.identity.channel_id,
    session_key: envelope.identity.session_key,
    query: envelope.body.query,
  };

  if (
    envelope.identity.thread_id !== null &&
    envelope.identity.thread_id !== undefined
  ) {
    toolArgs.thread_id = envelope.identity.thread_id;
  }
  if (envelope.body.requested_sections) {
    toolArgs.requested_sections = envelope.body.requested_sections;
  }
  if (envelope.body.include_unreviewed_recovery !== undefined) {
    toolArgs.include_unreviewed_recovery =
      envelope.body.include_unreviewed_recovery;
  }
  if (envelope.body.budget) toolArgs.budget = envelope.body.budget;

  return toolArgs;
}

function trimEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function summarizeNatsUrlForLog(url: string | null): NatsUrlLogSummary {
  if (!url) {
    return {
      configured: false,
      protocol: null,
      contains_credentials: false,
    };
  }

  try {
    const parsed = new URL(url);
    return {
      configured: true,
      protocol: parsed.protocol.replace(/:$/, "") || null,
      contains_credentials: Boolean(parsed.username || parsed.password),
    };
  } catch {
    return {
      configured: true,
      protocol: null,
      contains_credentials: url.includes("@"),
    };
  }
}

export function readNatsRuntimeBoundary(
  env: NodeJS.ProcessEnv,
): NatsRuntimeBoundary {
  const requestedTransport =
    env.OPENBRAIN_TRANSPORT?.trim().toLowerCase() === "nats"
      ? "nats"
      : "http";
  const url = trimEnv(env.OPENBRAIN_NATS_URL);
  const bridgeEnabled =
    env.OPENBRAIN_NATS_ENABLE_BRIDGE?.trim().toLowerCase() === "true";

  return {
    requested_transport: requestedTransport,
    fallback_transport: "http_mcp",
    nats: {
      availability: bridgeEnabled && url ? "available" : "not_runtime_available",
      url,
      context_pack_subject:
        trimEnv(env.OPENBRAIN_NATS_CONTEXT_PACK_SUBJECT) ?? DEFAULT_NATS_SUBJECT,
      fallback_http: env.OPENBRAIN_NATS_FALLBACK_HTTP?.trim().toLowerCase() !== "false",
    },
  };
}

export function planNatsContextPackBridge(
  boundary: NatsRuntimeBoundary,
  input: NatsBridgePlanInput,
): NatsBridgePlan {
  if (boundary.nats.availability !== "not_runtime_available") {
    throw new Error("NATS runtime is available; HTTP/MCP fallback plan is not used");
  }

  if (!boundary.nats.fallback_http) {
    throw new Error("NATS runtime is unavailable and HTTP/MCP fallback is disabled");
  }

  if (input.subject !== boundary.nats.context_pack_subject) {
    throw new Error(
      `Unsupported NATS subject '${input.subject}'; expected '${boundary.nats.context_pack_subject}'`,
    );
  }

  const bearerToken = input.bearerToken?.trim();
  if (!bearerToken) {
    throw new Error("Bearer token is required for NATS bridge fallback");
  }

  const envelope = contextPackEnvelopeSchema.parse(input.envelope);
  const toolArgs = mapNatsEnvelopeToToolArgs(envelope);

  return {
    status: "http_mcp_fallback",
    request_id: envelope.request_id,
    subject: input.subject,
    operation: NATS_CONTEXT_PACK_OPERATION,
    bearerToken,
    mcpToolCall: {
      name: "agent_context_pack",
      arguments: toolArgs,
    },
  };
}
