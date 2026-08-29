import { createHash } from "node:crypto";
import { CONTRACT_PAYLOAD_SECTIONS } from "./contract-payload-sections.ts";
import { TOOL_CONTRACTS } from "./contract-schemas.ts";

// v24 (#678). The v23 string outlived three client-facing shape changes: the
// live Zod schema for `agent_context_pack` gained `repo`, `prior_context`, and
// `continue_from` while `src/contract-schemas.ts` — the hand-maintained mirror
// the schema_hash is computed over — was never touched. So the version AND the
// hash both read identically on either side of a real contract change, and
// docs/downstream-rollout.md's "authoritative drift receipt" recorded nothing.
// Bumping is the client-visible half; the hash moves on its own once the mirror
// is honest, because TOOL_CONTRACTS is inside the hashed payload.
import { CONTRACT_CAPABILITIES } from "./contract-capabilities.ts";
import type { ContractCapability, OpenBrainContract } from "./contract-types.ts";

export type { ContractCapability, OpenBrainContract };
export { CONTRACT_CAPABILITIES };

export const CONTRACT_VERSION = "2026-08-09.memory-tools.v24";
export const CONTRACT_SCHEMA_VERSION = 1;

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => [key, sortValue(val)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function requiredContractHashPayload(
  payload: Omit<OpenBrainContract, "generated_at" | "schema_hash">,
): Omit<OpenBrainContract, "generated_at" | "schema_hash" | "realtime_transport"> {
  const { realtime_transport: _advisoryRealtimeTransport, ...requiredPayload } =
    payload;
  return requiredPayload;
}

export function contractHash(
  payload: Omit<OpenBrainContract, "generated_at" | "schema_hash">,
): string {
  return createHash("sha256")
    .update(stableJson(requiredContractHashPayload(payload)))
    .digest("hex");
}

export function buildContract(
  generatedAt = new Date().toISOString(),
  options: {
    natsAvailability?: "available" | "not_runtime_available";
  } = {},
): OpenBrainContract {
  const natsAvailability = options.natsAvailability ?? "not_runtime_available";
  const payload = {
    service: "open-brain" as const,
    contract_version: CONTRACT_VERSION,
    contract_scope: "required_openbrain_memory_contract" as const,
    schema_version: CONTRACT_SCHEMA_VERSION,
    min_client_versions: {
      "openbrain-memory": "0.1.15",
      "rtech-hermes-runtime": "0.1.0",
      mcp2cli: "0.3.6",
    },
    compatible_client_ranges: {
      "openbrain-memory": ">=0.1.15 <1.0.0",
      "rtech-hermes-runtime": ">=0.1.0 <1.0.0",
      mcp2cli: ">=0.3.6 <1.0.0",
    },
    transport: {
      mcp: "streamable-http" as const,
      auth: "bearer" as const,
      namespace_boundary: "authorization" as const,
      session_required: true as const,
    },
    // ADVISORY: realtime_transport is EXCLUDED from schema_hash
    // (see requiredContractHashPayload — it destructures realtime_transport out
    // before hashing). It is documentation of the NATS foundation, so its
    // contents (subject shape, availability, streams) can change without a
    // schema_hash bump or a contract-version break.
    realtime_transport: {
      nats_jetstream: {
        status:
          natsAvailability === "available"
            ? ("runtime-available" as const)
            : ("planned-transport-foundation" as const),
        availability: natsAvailability,
        parent_issue: 223 as const,
        contract_doc: "docs/nats-jetstream-foundation.md" as const,
        server: {
          planned_host: "production-host" as const,
          client_listen: "127.0.0.1:4222" as const,
          monitoring_listen: "127.0.0.1:8222" as const,
          jetstream_store_dir: "/opt/open-brain/nats/jetstream" as const,
        },
        // Env-prefixed subjects (fleet-bus convention). The advertised strings
        // carry a `{env}.` template placeholder; the runtime substitutes the
        // slugged OPENBRAIN_NATS_ENV value via obContextPackSubject(env).
        subject_convention: "env_prefixed_fleet_bus" as const,
        request_reply_subjects: {
          available:
            natsAvailability === "available"
              ? (["{env}.ob.memory.context_pack"] as const)
              : ([] as const),
          planned: [
            "{env}.ob.memory.session_start",
            "{env}.ob.memory.append_event",
            "{env}.ob.memory.wrap",
            "{env}.ob.memory.resolve",
            "{env}.ob.health",
          ] as const,
        },
        jetstream_streams: [
          "OB_AGENT_TRACE",
          "OB_CONTEXT_PACK_REQUESTS",
          "OB_CONTEXT_PACK_AUDIT",
          "OB_PROMOTION_CANDIDATES",
        ] as const,
        fallback_transport: "http_mcp" as const,
        auth_boundary: "openbrain_server_authority" as const,
        runtime_default: "http_mcp" as const,
      },
    },
    ...CONTRACT_PAYLOAD_SECTIONS,
    capabilities: [...CONTRACT_CAPABILITIES].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    tool_contracts: TOOL_CONTRACTS,
  };

  return {
    ...payload,
    schema_hash: contractHash(payload),
    generated_at: generatedAt,
  };
}
