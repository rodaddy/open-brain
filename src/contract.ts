import { createHash } from "node:crypto";
import { TOOL_CONTRACTS } from "./contract-schemas.ts";

export const CONTRACT_VERSION = "2026-06-26.memory-tools.v8";
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
  interchange_profiles: {
    okf: {
      status: "compatibility-hooks";
      version: "draft";
      role: "edge-export-import-profile";
      metadata_path: "metadata.okf";
      reserved_files: ["index.md", "log.md"];
      required_frontmatter: ["type"];
      recommended_frontmatter: [
        "title",
        "description",
        "resource",
        "tags",
        "timestamp",
      ];
      export_surfaces: ["concept", "index", "log", "citations"];
    };
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
    version: 1,
    kind: "tool",
    description:
      "Fetch one full readable memory row by table and UUID. Server-side auth " +
      "and namespace predicates remain the security boundary for ID reads.",
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
    version: 4,
    kind: "tool",
    description:
      "Append one durable, typed event (fact, decision, blocker, action, etc.) " +
      "to a session lane's journal. This is the main way to record what happened " +
      "during a session so it survives and can be recalled later.",
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

export function contractHash(
  payload: Omit<OpenBrainContract, "generated_at" | "schema_hash">,
): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
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
      "openbrain-memory": "0.1.0",
      "rtech-hermes-runtime": "0.1.0",
      mcp2cli: "0.3.6",
    },
    compatible_client_ranges: {
      "openbrain-memory": ">=0.1.0 <1.0.0",
      "rtech-hermes-runtime": ">=0.1.0 <1.0.0",
      mcp2cli: ">=0.3.6 <1.0.0",
    },
    transport: {
      mcp: "streamable-http" as const,
      auth: "bearer" as const,
      namespace_boundary: "authorization" as const,
      session_required: true as const,
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
        export_surfaces: ["concept", "index", "log", "citations"] as const,
      },
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
