import { createHash } from "node:crypto";
import { TOOL_CONTRACTS } from "./contract-schemas.ts";

export const CONTRACT_VERSION = "2026-07-06.memory-tools.v14";
export const CONTRACT_SCHEMA_VERSION = 1;

export interface ContractCapability {
  name: string;
  version: number;
  kind: "tool" | "transport" | "schema";
  description: string;
}

export interface OpenBrainContract {
  service: "open-brain";
  contract_version: string;
  contract_scope: "required_openbrain_memory_contract";
  schema_version: number;
  schema_hash: string;
  generated_at: string;
  min_client_versions: Record<string, string>;
  compatible_client_ranges: Record<string, string>;
  transport: {
    mcp: "streamable-http";
    auth: "bearer";
    namespace_boundary: "authorization";
    session_required: true;
  };
  realtime_transport: {
    nats_jetstream: {
      status: "planned-transport-foundation";
      availability: "not_runtime_available";
      parent_issue: 223;
      contract_doc: "docs/nats-jetstream-foundation.md";
      server: {
        planned_host: "core01";
        client_listen: "127.0.0.1:4222";
        monitoring_listen: "127.0.0.1:8222";
        jetstream_store_dir: "/Volumes/ThunderBolt/open-brain/nats/jetstream";
      };
      request_reply_subjects: readonly [
        "ob.memory.context_pack",
        "ob.memory.session_start",
        "ob.memory.append_event",
        "ob.memory.wrap",
        "ob.memory.resolve",
        "ob.health",
      ];
      jetstream_streams: readonly [
        "OB_AGENT_TRACE",
        "OB_CONTEXT_PACK_REQUESTS",
        "OB_CONTEXT_PACK_AUDIT",
        "OB_PROMOTION_CANDIDATES",
      ];
      fallback_transport: "http_mcp";
      auth_boundary: "openbrain_server_authority";
      runtime_default: "http_mcp";
    };
  };
  interchange_profiles: {
    okf: {
      status: "compatibility-hooks";
      version: "draft";
      role: "edge-export-import-profile";
      metadata_path: "metadata.okf";
      reserved_files: readonly ["index.md", "log.md"];
      required_frontmatter: readonly ["type"];
      recommended_frontmatter: readonly [
        "title",
        "description",
        "resource",
        "tags",
        "timestamp",
      ];
      export_surfaces: readonly ["concept", "index", "log", "citations", "receipts"];
    };
  };
  agent_memory_adapter: {
    status: "draft-local-contract";
    contract_doc: "docs/agent-memory-adapter-contract.md";
    server_authority: readonly [
      "auth",
      "namespace",
      "storage",
      "promotion_policy",
      "contract_discovery",
    ];
    client_authority: readonly [
      "distillation",
      "local_context",
      "retry_spool",
      "receipt_assembly",
      "disclosure_export",
    ];
    methods: Record<
      string,
      {
        maps_to: readonly string[];
        owner: "server" | "client" | "client_and_server";
        status: "available" | "client-wrapper" | "planned";
      }
    >;
  };
  agent_context_pack: {
    status: "planned-contract";
    availability: "not_runtime_available";
    contract_doc: "docs/agent-context-pack-contract.md";
    parent_issue: 220;
    exact_scope_required: true;
    scope_keys: readonly [
      "namespace",
      "agent",
      "platform",
      "server_id",
      "channel_id",
      "thread_id",
      "session_key",
    ];
    sections: readonly [
      "working_set",
      "durable_lane_context",
      "durable_memory",
      "profile_guidance",
      "process_guidance",
      "repo_facts",
      "pointers",
      "candidate_memory",
    ];
    envelope_fields: readonly ["warnings", "budget", "citations"];
    warning_fields: readonly [
      "missing_facts",
      "stale_sources",
      "degraded_sources",
      "scope_denials",
      "truncation",
      "uncertainty",
    ];
  };
  receipt_contract: {
    status: "lightweight-openbrain-receipts";
    event_type: "receipt";
    contract_doc: "docs/agent-memory-adapter-contract.md";
    required_fields: readonly string[];
    recommended_fields: readonly string[];
    closed_brain_strict_fields: readonly string[];
    secret_safe: true;
  };
  capabilities: ContractCapability[];
  tool_contracts: Record<
    string,
    {
      version: number;
      input_schema: unknown;
      output_shape: string;
    }
  >;
}

export const CONTRACT_CAPABILITIES: ContractCapability[] = [
  {
    name: "get_contract",
    version: 1,
    kind: "tool",
    description: "Read the canonical Open Brain public contract manifest.",
  },
  {
    name: "get_entry",
    version: 2,
    kind: "tool",
    description:
      "Fetch one readable memory row by table and UUID. Defaults to full row " +
      "output; compact render returns a bounded exact-UUID preview envelope. " +
      "Server-side auth and namespace predicates remain the security boundary " +
      "for ID reads.",
  },
  {
    name: "resolve_entry",
    version: 1,
    kind: "tool",
    description:
      "Resolve one UUID across readable Open Brain source families to its " +
      "source type, namespace, and get_entry fetch path without semantic search.",
  },
  {
    name: "upsert_repo_fact",
    version: 2,
    kind: "tool",
    description:
      "Record or update one curated, citation-backed fact about a code repository " +
      "(qmd-derived) into graph entity metadata. Use to persist durable repo " +
      "knowledge (how a module works, an invariant, a gotcha) with a source URL " +
      "that proves it; re-upsert with the same key to correct an existing fact.",
  },
  {
    name: "list_repo_facts",
    version: 2,
    kind: "tool",
    description:
      "Read back curated repository facts, scoped to your namespace and filtered " +
      "by repo, collection, path, fact_type, or subject. Use to recall what is " +
      "already known about a repo before re-deriving it.",
  },
  {
    name: "log_thought",
    version: 2,
    kind: "tool",
    description:
      "Write a single durable thought, observation, or note to long-term memory. " +
      "Use for free-form knowledge that is not tied to a session journal; it is " +
      "embedded for later semantic search. For session-scoped events use " +
      "append_session_event instead.",
  },
  {
    name: "search_all",
    version: 2,
    kind: "tool",
    description:
      "Primary recall tool. Semantic + keyword search across Open Brain memory " +
      "(thoughts, session events, facts) and optional qmd-backed code context. " +
      "Call this before answering from assumption to ground yourself in stored " +
      "knowledge.",
  },
  {
    name: "session_start",
    version: 2,
    kind: "tool",
    description:
      "Open or resume a durable session lane and get recent events back. Call " +
      "this at the start of a conversation/task to establish the lane other " +
      "session tools write to, and to rehydrate prior context.",
  },
  {
    name: "session_context",
    version: 2,
    kind: "tool",
    description:
      "Read a session lane's current state and recent events without creating " +
      "one. Use to rehydrate context for an existing session (by session_key or " +
      "channel_id) before continuing work.",
  },
  {
    name: "lane_upsert",
    version: 2,
    kind: "tool",
    description:
      "Create or update the metadata and rolling context of a session lane " +
      "(status, project, agent, topic, current_context_md). Use to set or refresh " +
      "the lane's high-level state; use append_session_event for individual " +
      "journal entries.",
  },
  {
    name: "lane_load",
    version: 2,
    kind: "tool",
    description:
      "List session lanes matching filters (key, project, agent, channel, " +
      "status). Use to discover or pick up existing lanes; defaults to active " +
      "lanes when status is omitted.",
  },
  {
    name: "append_session_event",
    version: 5,
    kind: "tool",
    description:
      "Append one durable, typed event (fact, decision, blocker, action, etc.) " +
      "to a session lane's journal. This is the main way to record what happened " +
      "during a session so it survives and can be recalled later. Supports " +
      "first-write lane creation with create_if_missing for realtime agents.",
  },
  {
    name: "session_wrap",
    version: 2,
    kind: "tool",
    description:
      "Checkpoint a session lane with a durable summary, key decisions, and next " +
      "steps. Call at the end of a work session so the next session can resume " +
      "from a clean handoff.",
  },
  {
    name: "entity_graph",
    version: 2,
    kind: "schema",
    description:
      "Open Brain graph entities and links, including archived entity lifecycle.",
  },
  {
    name: "session_lanes",
    version: 1,
    kind: "schema",
    description: "Durable session lanes, events, context, and wraps.",
  },
  {
    name: "agent_context_pack",
    version: 1,
    kind: "schema",
    description:
      "Planned first-class realtime context-pack contract for Hermes and " +
      "future agents. It is not an available runtime tool until a later " +
      "implementation exposes it explicitly.",
  },
  {
    name: "agent_memory_adapter",
    version: 1,
    kind: "schema",
    description:
      "Draft local adapter contract for agent memory lifecycle clients. " +
      "Defines start, recall, append_event, compact, wrap, record_receipt, " +
      "nominate_shared, and export_disclosure_bundle without moving server " +
      "auth or namespace authority into clients.",
  },
  {
    name: "receipt_contract",
    version: 1,
    kind: "schema",
    description:
      "Lightweight citation-safe receipt metadata model for Open Brain " +
      "session events, with stricter Closed Brain fields marked separately.",
  },
  {
    name: "streamable_http_auth",
    version: 1,
    kind: "transport",
    description:
      "Bearer-token identity establishes namespace boundaries for MCP sessions.",
  },
];

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
): OpenBrainContract {
  const payload = {
    service: "open-brain" as const,
    contract_version: CONTRACT_VERSION,
    contract_scope: "required_openbrain_memory_contract" as const,
    schema_version: CONTRACT_SCHEMA_VERSION,
    min_client_versions: {
      "openbrain-memory": "0.1.4",
      "rtech-hermes-runtime": "0.1.0",
      mcp2cli: "0.3.6",
    },
    compatible_client_ranges: {
      "openbrain-memory": ">=0.1.4 <1.0.0",
      "rtech-hermes-runtime": ">=0.1.0 <1.0.0",
      mcp2cli: ">=0.3.6 <1.0.0",
    },
    transport: {
      mcp: "streamable-http" as const,
      auth: "bearer" as const,
      namespace_boundary: "authorization" as const,
      session_required: true as const,
    },
    realtime_transport: {
      nats_jetstream: {
        status: "planned-transport-foundation" as const,
        availability: "not_runtime_available" as const,
        parent_issue: 223 as const,
        contract_doc: "docs/nats-jetstream-foundation.md" as const,
        server: {
          planned_host: "core01" as const,
          client_listen: "127.0.0.1:4222" as const,
          monitoring_listen: "127.0.0.1:8222" as const,
          jetstream_store_dir:
            "/Volumes/ThunderBolt/open-brain/nats/jetstream" as const,
        },
        request_reply_subjects: [
          "ob.memory.context_pack",
          "ob.memory.session_start",
          "ob.memory.append_event",
          "ob.memory.wrap",
          "ob.memory.resolve",
          "ob.health",
        ] as const,
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
    interchange_profiles: {
      okf: {
        status: "compatibility-hooks" as const,
        version: "draft" as const,
        role: "edge-export-import-profile" as const,
        metadata_path: "metadata.okf" as const,
        reserved_files: ["index.md", "log.md"] as const,
        required_frontmatter: ["type"] as const,
        recommended_frontmatter: [
          "title",
          "description",
          "resource",
          "tags",
          "timestamp",
        ] as const,
        export_surfaces: ["concept", "index", "log", "citations", "receipts"] as const,
      },
    },
    agent_memory_adapter: {
      status: "draft-local-contract" as const,
      contract_doc: "docs/agent-memory-adapter-contract.md" as const,
      server_authority: [
        "auth",
        "namespace",
        "storage",
        "promotion_policy",
        "contract_discovery",
      ] as const,
      client_authority: [
        "distillation",
        "local_context",
        "retry_spool",
        "receipt_assembly",
        "disclosure_export",
      ] as const,
      methods: {
        start: {
          maps_to: ["session_start", "lane_upsert"] as const,
          owner: "client_and_server" as const,
          status: "available" as const,
        },
        recall: {
          maps_to: ["session_context", "search_all", "brain_answer"] as const,
          owner: "client_and_server" as const,
          status: "available" as const,
        },
        append_event: {
          maps_to: ["append_session_event"] as const,
          owner: "client_and_server" as const,
          status: "available" as const,
        },
        compact: {
          maps_to: ["session_context", "session_wrap"] as const,
          owner: "client" as const,
          status: "client-wrapper" as const,
        },
        wrap: {
          maps_to: ["session_wrap"] as const,
          owner: "client_and_server" as const,
          status: "available" as const,
        },
        record_receipt: {
          maps_to: ["append_session_event:event_type=receipt"] as const,
          owner: "client_and_server" as const,
          status: "client-wrapper" as const,
        },
        nominate_shared: {
          maps_to: ["append_session_event:metadata.share_candidate"] as const,
          owner: "client_and_server" as const,
          status: "available" as const,
        },
        export_disclosure_bundle: {
          maps_to: ["interchange_profiles.okf"] as const,
          owner: "client" as const,
          status: "client-wrapper" as const,
        },
      },
    },
    agent_context_pack: {
      status: "planned-contract" as const,
      availability: "not_runtime_available" as const,
      contract_doc: "docs/agent-context-pack-contract.md" as const,
      parent_issue: 220 as const,
      exact_scope_required: true as const,
      scope_keys: [
        "namespace",
        "agent",
        "platform",
        "server_id",
        "channel_id",
        "thread_id",
        "session_key",
      ] as const,
      sections: [
        "working_set",
        "durable_lane_context",
        "durable_memory",
        "profile_guidance",
        "process_guidance",
        "repo_facts",
        "pointers",
        "candidate_memory",
      ] as const,
      envelope_fields: ["warnings", "budget", "citations"] as const,
      warning_fields: [
        "missing_facts",
        "stale_sources",
        "degraded_sources",
        "scope_denials",
        "truncation",
        "uncertainty",
      ] as const,
    },
    receipt_contract: {
      status: "lightweight-openbrain-receipts" as const,
      event_type: "receipt" as const,
      contract_doc: "docs/agent-memory-adapter-contract.md" as const,
      required_fields: [
        "schema",
        "action",
        "agent",
        "session_key",
        "timestamp",
        "sources",
        "outputs",
        "validations",
      ] as const,
      recommended_fields: [
        "namespace",
        "project",
        "commands",
        "external_channels",
        "artifact_hashes",
        "source_refs",
        "residual_risk",
      ] as const,
      closed_brain_strict_fields: [
        "preimage_hashes",
        "postimage_hashes",
        "base_document_hashes",
        "tool_call_ids",
        "approval_chain",
        "redaction_policy",
      ] as const,
      secret_safe: true as const,
    },
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
