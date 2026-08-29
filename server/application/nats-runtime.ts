import { z } from "zod";
import { SECTION_NAMES } from "../../src/tools/agent-context-pack.ts";
import { obContextPackSubject } from "../../src/nats-subjects.ts";
import { logger } from "../../src/logger.ts";

// ============================================================================
// CROSS-LANGUAGE WIRE CONTRACT (source of truth for the Python client lane)
// ============================================================================
//
// Open Brain's NATS wire format is reconciled to the fleet-bus Envelope
// (rodaddy/fleet-bus, `packages/fleet-nats/src/fleet_nats/envelope.py`). Any
// client that speaks to the Open Brain NATS worker — including the separate
// `python/openbrain-memory` lane — MUST match the shapes below.
//
// ENVELOPE (compact UTF-8 JSON; key order is not significant):
//   {
//     "id":             string  (required, non-empty) — unique message id
//     "ts":             string  (required, non-empty) — ISO-8601 UTC timestamp
//     "from":           string  (required, non-empty) — publisher id. Wire key
//                               is "from" (NOT "sender"). Requests: the caller's
//                               agent/client id. Responses: "open-brain".
//     "kind":           string  (required, non-empty) — dispatch discriminator.
//                               Requests:  "context_pack_request"  — the bridge
//                               REJECTS any inbound envelope whose kind is not
//                               "context_pack_request" as bad_request, before it
//                               inspects the payload (so a reply or unrelated
//                               fleet message on the subject is never processed).
//                               Responses: "context_pack_response"
//     "payload":        object  (required to be a JSON object; missing => {})
//     "to":             string | null  (optional)
//     "task_id":        string | null  (optional)
//     "channel":        string | null  (optional)
//     "topic":          string | null  (optional)
//     "correlation_id": string | null  (optional) — on a RESPONSE this ECHOES
//                               the request envelope's "id".
//     "version":        int     (default 1). version > 1 is accepted with a
//                               warning (forward-compat), never silently.
//   }
//
// REQUEST payload (validated by requestPayloadSchema, strict where noted):
//   {
//     "operation":  "agent_context_pack",
//     "identity":   { agent, platform, server_id, channel_id, thread_id?,
//                     session_key }  — same strictness as the HTTP MCP tool,
//     "body":       { query?, requested_sections?, include_unreviewed_recovery?,
//                     budget? }  (STRICT — unknown keys rejected),
//     "namespace":  string?  — OPTIONAL client-declared namespace override. Only
//                     honoured on the trusted local bus with auth off; ignored
//                     (never overrides the token-derived namespace) once
//                     OPENBRAIN_NATS_REQUIRE_AUTH=true. namespace IS a security
//                     boundary — see nats-bridge.ts lane binding.
//                     namespace_source is a RESPONSE-ONLY stamp; it MUST NOT
//                     appear in the request wire.
//   }
//
// RESPONSE payload:
//   ok:    { "status": "ok",    "operation": "agent_context_pack",
//            "namespace_source": "token"|"override"|"declared", "body": <pack> }
//   error: { "status": "error", "operation": "agent_context_pack",
//            "namespace_source": "token"|"override"|"declared"|"rejected"|null,
//            "error": { "code": string, "message": string } }
//   namespace_source values:
//     "token"    — REQUIRE_AUTH=true: namespace derived from the bearer token.
//     "override" — auth off: explicit payload.namespace override was used.
//     "declared" — auth off: namespace derived from declared identity (from /
//                  payload.identity.agent).
//     "rejected" — request could not be bound to a namespace (or auth missing).
//
// SUBJECT: `{env}.ob.memory.context_pack`, built by obContextPackSubject(env)
//   with env from OPENBRAIN_NATS_ENV (default "dev"). Env token is slugged
//   (lowercase, spaces/dots -> hyphens, empty throws). The
//   OPENBRAIN_NATS_CONTEXT_PACK_SUBJECT env var remains as an explicit escape
//   hatch that overrides the builder output.
// ============================================================================

export const ENVELOPE_VERSION = 1;
export const REQUEST_KIND = "context_pack_request";
export const RESPONSE_KIND = "context_pack_response";
export const RESPONSE_FROM = "open-brain";

/**
 * How the response's namespace was bound. RESPONSE-ONLY stamp — never present in
 * the request wire.
 *   "token"    — REQUIRE_AUTH=true: namespace derived from the bearer token.
 *   "override" — auth off: explicit payload.namespace override was used.
 *   "declared" — auth off: namespace derived from the declared identity.
 *   "rejected" — request could not be bound to a namespace (or auth missing).
 */
export type NamespaceSource = "token" | "override" | "declared" | "rejected";

const NATS_CONTEXT_PACK_OPERATION = "agent_context_pack";
const DEFAULT_NATS_ENV = "dev";
const MAX_CONTEXT_PACK_QUERY_CHARS = 4000;
const LOCAL_NATS_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const requestedSectionsSchema = z.array(z.enum(SECTION_NAMES));

// Identity as declared by the caller. Kept exactly as strict as the pre-fleet
// envelope identity, minus namespace_source (that is now derived server-side and
// stamped on the response, not accepted from the wire).
const identitySchema = z.object({
  agent: z.string().min(1).max(200),
  platform: z.string().min(1).max(200),
  server_id: z.string().min(1).max(500),
  channel_id: z.string().min(1).max(500),
  thread_id: z.string().max(500).nullable().optional(),
  session_key: z.string().min(1).max(500),
});

const requestBodySchema = z
  .object({
    query: z.string().max(MAX_CONTEXT_PACK_QUERY_CHARS).optional(),
    requested_sections: requestedSectionsSchema.optional(),
    include_unreviewed_recovery: z.boolean().optional(),
    budget: z
      .object({
        max_tokens: z.number().int().min(100).max(20_000).optional(),
        max_latency_ms: z.number().int().min(1).max(10_000).optional(),
      })
      .optional(),
  })
  .strict();

// The request payload that lives INSIDE the fleet envelope's `payload` field.
export const requestPayloadSchema = z.object({
  operation: z.literal(NATS_CONTEXT_PACK_OPERATION),
  identity: identitySchema,
  body: requestBodySchema,
  namespace: z.string().min(1).max(500).optional(),
});

export type NatsContextPackRequestPayload = z.infer<typeof requestPayloadSchema>;

// The fleet envelope wire codec lives in nats-envelope.ts (issue 864); it is
// re-exported here so every existing importer of this module keeps its line.
export {
  EnvelopeError,
  buildEnvelope,
  envelopeToBytes,
  envelopeFromBytes,
  type FleetEnvelope,
  type BuildEnvelopeInput,
} from "./nats-envelope.ts";
import { envelopeFromBytes, type FleetEnvelope } from "./nats-envelope.ts";

export interface NatsRuntimeBoundary {
  requested_transport: "http" | "nats";
  fallback_transport: "http_mcp";
  nats: {
    availability: "available" | "not_runtime_available";
    url: string | null;
    context_pack_subject: string;
    fallback_http: boolean;
    require_auth: boolean;
    allow_namespace_override: boolean;
  };
}

export interface NatsUrlLogSummary {
  configured: boolean;
  protocol: string | null;
  contains_credentials: boolean;
  local: boolean | null;
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
      query?: string;
      requested_sections?: string[];
      include_unreviewed_recovery?: boolean;
      budget?: {
        max_tokens?: number;
        max_latency_ms?: number;
      };
    };
  };
}

/**
 * Map a validated request payload to agent_context_pack tool arguments.
 * `namespace` is intentionally NOT mapped here — lane binding (nats-bridge.ts)
 * decides whether a client-declared namespace may be used and passes it via the
 * resolved AuthInfo/args, never straight from the wire.
 */
export function mapRequestPayloadToToolArgs(
  payload: NatsContextPackRequestPayload,
): NatsBridgePlan["mcpToolCall"]["arguments"] {
  const toolArgs: NatsBridgePlan["mcpToolCall"]["arguments"] = {
    agent: payload.identity.agent,
    platform: payload.identity.platform,
    server_id: payload.identity.server_id,
    channel_id: payload.identity.channel_id,
    session_key: payload.identity.session_key,
  };

  if (payload.body.query !== undefined) {
    toolArgs.query = payload.body.query;
  }
  if (payload.identity.thread_id !== null && payload.identity.thread_id !== undefined) {
    toolArgs.thread_id = payload.identity.thread_id;
  }
  if (payload.body.requested_sections) {
    toolArgs.requested_sections = payload.body.requested_sections;
  }
  if (payload.body.include_unreviewed_recovery !== undefined) {
    toolArgs.include_unreviewed_recovery = payload.body.include_unreviewed_recovery;
  }
  if (payload.body.budget) toolArgs.budget = payload.body.budget;

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
      local: null,
    };
  }

  try {
    const parsed = new URL(url);
    return {
      configured: true,
      protocol: parsed.protocol.replace(/:$/, "") || null,
      contains_credentials: Boolean(parsed.username || parsed.password),
      local: LOCAL_NATS_HOSTS.has(normalizeNatsHostname(parsed.hostname)),
    };
  } catch {
    // Deliberately unlogged: this function exists to make a possibly
    // credential-bearing URL safe to log, so reporting its own failure is the
    // one place that could leak the very string being sanitized. The returned
    // shape is already the honest answer -- null protocol and null locality
    // mean "unknown", not "fine" -- and `contains_credentials` still errs
    // toward true on a bare `@`.
    return {
      configured: true,
      protocol: null,
      contains_credentials: url.includes("@"),
      local: null,
    };
  }
}

function isNatsUrlAllowedForRuntime(
  url: string | null,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (LOCAL_NATS_HOSTS.has(normalizeNatsHostname(parsed.hostname))) return true;
    return env.OPENBRAIN_NATS_ALLOW_INSECURE_REMOTE?.trim().toLowerCase() === "true";
  } catch (error) {
    // Fail closed, per docs/sme/security.md:285 -- an auth-bearing plaintext
    // transport allows only local endpoints unless the remote override is
    // explicitly set. But a MALFORMED NATS_URL and a deliberately remote one
    // both produced this same silent "not available", so a typo in the broker
    // URL was indistinguishable from a configuration choice. The error class
    // only: the URL may carry credentials and is never logged.
    logger.warn("nats_url_unparseable", {
      error_name: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
}

function normalizeNatsHostname(hostname: string): string {
  return hostname.toLowerCase();
}

// Shared "requested transport is degraded" predicate. Consumed by both
// GET /health and the operator doctor so their degradation logic cannot
// diverge: degraded means NATS was explicitly requested but the runtime
// bridge is not available.
export function isRequestedTransportDegraded(
  boundary: NatsRuntimeBoundary,
  availability: NatsRuntimeBoundary["nats"]["availability"],
): boolean {
  return boundary.requested_transport === "nats" && availability !== "available";
}

/**
 * Resolve the default env-prefixed context-pack subject from OPENBRAIN_NATS_ENV,
 * or the explicit OPENBRAIN_NATS_CONTEXT_PACK_SUBJECT escape hatch when set.
 */
export function resolveContextPackSubject(env: NodeJS.ProcessEnv): string {
  const override = trimEnv(env.OPENBRAIN_NATS_CONTEXT_PACK_SUBJECT);
  if (override) return override;
  const natsEnv = trimEnv(env.OPENBRAIN_NATS_ENV) ?? DEFAULT_NATS_ENV;
  return obContextPackSubject(natsEnv);
}

// Auth is OFF by default (trusted local bus). When REQUIRE_AUTH=true the
// bearer gate is re-enabled AND the namespace override is force-disabled:
// they are mutually exclusive. The override is a local-trust affordance only.
function readNatsAuthFlags(env: NodeJS.ProcessEnv): {
  requireAuth: boolean;
  allowNamespaceOverride: boolean;
} {
  const requireAuth = env.OPENBRAIN_NATS_REQUIRE_AUTH?.trim().toLowerCase() === "true";
  return {
    requireAuth,
    allowNamespaceOverride:
      !requireAuth &&
      env.OPENBRAIN_NATS_ALLOW_NAMESPACE_OVERRIDE?.trim().toLowerCase() !== "false",
  };
}

export function readNatsRuntimeBoundary(env: NodeJS.ProcessEnv): NatsRuntimeBoundary {
  const requestedTransport =
    env.OPENBRAIN_TRANSPORT?.trim().toLowerCase() === "nats" ? "nats" : "http";
  const url = trimEnv(env.OPENBRAIN_NATS_URL);
  const bridgeEnabled =
    env.OPENBRAIN_NATS_ENABLE_BRIDGE?.trim().toLowerCase() === "true";
  const runtimeAvailable =
    requestedTransport === "nats" &&
    bridgeEnabled &&
    isNatsUrlAllowedForRuntime(url, env);

  const { requireAuth, allowNamespaceOverride } = readNatsAuthFlags(env);

  return {
    requested_transport: requestedTransport,
    fallback_transport: "http_mcp",
    nats: {
      availability: runtimeAvailable ? "available" : "not_runtime_available",
      url,
      context_pack_subject: resolveContextPackSubject(env),
      fallback_http: env.OPENBRAIN_NATS_FALLBACK_HTTP?.trim().toLowerCase() !== "false",
      require_auth: requireAuth,
      allow_namespace_override: allowNamespaceOverride,
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

  const envelope = envelopeFromEnvelopeInput(input.envelope);
  const payload = requestPayloadSchema.parse(envelope.payload);
  const toolArgs = mapRequestPayloadToToolArgs(payload);

  return {
    status: "http_mcp_fallback",
    request_id: envelope.id,
    subject: input.subject,
    operation: NATS_CONTEXT_PACK_OPERATION,
    bearerToken,
    mcpToolCall: {
      name: "agent_context_pack",
      arguments: toolArgs,
    },
  };
}

/**
 * Coerce a plain-object envelope (as passed to planNatsContextPackBridge) into a
 * validated FleetEnvelope. Round-trips through the wire codec so plan-time
 * validation is byte-identical to what the live bridge does with raw bytes.
 */
function envelopeFromEnvelopeInput(input: unknown): FleetEnvelope {
  return envelopeFromBytes(new TextEncoder().encode(JSON.stringify(input)));
}
