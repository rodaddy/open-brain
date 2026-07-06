import { z } from "zod";

const NATS_CONTEXT_PACK_OPERATION = "agent_context_pack";
const DEFAULT_NATS_SUBJECT = "ob.memory.context_pack";

const requestedSectionsSchema = z.array(z.string().min(1).max(200)).max(32);

const identitySchema = z.object({
  namespace_source: z.literal("authorization"),
  agent: z.string().min(1).max(200),
  platform: z.string().min(1).max(200),
  server_id: z.string().min(1).max(500),
  channel_id: z.string().min(1).max(500),
  thread_id: z.string().max(500).nullable().optional(),
  session_key: z.string().min(1).max(500),
});

const requestEnvelopeSchema = z.object({
  schema: z.literal("openbrain.nats.request.v1"),
  operation: z.literal(NATS_CONTEXT_PACK_OPERATION),
  request_id: z.string().min(1).max(500),
  identity: identitySchema,
  body: z.object({
    query: z.string().min(1).max(20_000),
    requested_sections: requestedSectionsSchema.optional(),
    include_unreviewed_recovery: z.boolean().optional(),
    user_id: z.string().max(500).optional(),
    repo: z.string().max(500).optional(),
    task: z.string().max(500).optional(),
    client_context_refs: z.array(z.record(z.string(), z.unknown())).max(64).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    budget: z.object({
      max_tokens: z.number().int().positive().max(200_000).optional(),
      max_latency_ms: z.number().int().positive().max(120_000).optional(),
    }).optional(),
  }),
  metadata: z.object({
    client: z.string().min(1).max(200),
    client_version: z.string().min(1).max(200),
    transport: z.literal("nats"),
  }).passthrough(),
});

export type NatsContextPackEnvelope = z.infer<typeof requestEnvelopeSchema>;

export interface NatsRuntimeBoundary {
  requested_transport: "http" | "nats";
  fallback_transport: "http_mcp";
  nats: {
    availability: "not_runtime_available";
    url: string | null;
    context_pack_subject: string;
    fallback_http: boolean;
  };
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
      user_id?: string;
      repo?: string;
      task?: string;
      client_context_refs?: Array<Record<string, unknown>>;
      metadata?: Record<string, unknown>;
      budget?: {
        max_tokens?: number;
        max_latency_ms?: number;
      };
    };
  };
}

function trimEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function readNatsRuntimeBoundary(
  env: NodeJS.ProcessEnv,
): NatsRuntimeBoundary {
  const requestedTransport =
    env.OPENBRAIN_TRANSPORT?.trim().toLowerCase() === "nats"
      ? "nats"
      : "http";

  return {
    requested_transport: requestedTransport,
    fallback_transport: "http_mcp",
    nats: {
      availability: "not_runtime_available",
      url: trimEnv(env.OPENBRAIN_NATS_URL),
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
    throw new Error("Unexpected runtime availability state");
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

  const envelope = requestEnvelopeSchema.parse(input.envelope);
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
  if (envelope.body.user_id) toolArgs.user_id = envelope.body.user_id;
  if (envelope.body.repo) toolArgs.repo = envelope.body.repo;
  if (envelope.body.task) toolArgs.task = envelope.body.task;
  if (envelope.body.client_context_refs) {
    toolArgs.client_context_refs = envelope.body.client_context_refs;
  }
  if (envelope.body.metadata) toolArgs.metadata = envelope.body.metadata;
  if (envelope.body.budget) toolArgs.budget = envelope.body.budget;

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
