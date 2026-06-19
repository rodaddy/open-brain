import { createHash } from "node:crypto";
import {
  REPO_FACT_METADATA_CONTRACT,
  REPO_FACT_VALIDATION_CONTRACT,
} from "./tools/repo-facts.ts";

export const CONTRACT_VERSION = "2026-06-19.memory-tools.v4";
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
    name: "upsert_repo_fact",
    version: 1,
    kind: "tool",
    description:
      "Upsert a curated qmd-derived repository fact into graph entity metadata.",
  },
  {
    name: "list_repo_facts",
    version: 1,
    kind: "tool",
    description:
      "Read curated qmd-derived repository facts with namespace scoping.",
  },
  {
    name: "log_thought",
    version: 1,
    kind: "tool",
    description: "Write a durable thought or observation to Open Brain.",
  },
  {
    name: "search_all",
    version: 1,
    kind: "tool",
    description:
      "Search Open Brain memory and optional qmd-backed code context.",
  },
  {
    name: "session_start",
    version: 1,
    kind: "tool",
    description:
      "Find or create a durable session lane and return recent events.",
  },
  {
    name: "session_context",
    version: 1,
    kind: "tool",
    description: "Read durable session lane state and recent events.",
  },
  {
    name: "lane_upsert",
    version: 1,
    kind: "tool",
    description:
      "Create or update durable session lane metadata and current context.",
  },
  {
    name: "lane_load",
    version: 1,
    kind: "tool",
    description:
      "Load durable session lanes by key, project, agent, channel, or status.",
  },
  {
    name: "append_session_event",
    version: 2,
    kind: "tool",
    description: "Append a durable event to a session lane journal.",
  },
  {
    name: "session_wrap",
    version: 1,
    kind: "tool",
    description: "Checkpoint a session lane with a durable summary.",
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
    capabilities: [...CONTRACT_CAPABILITIES].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    tool_contracts: {
      get_contract: {
        version: 1,
        input_schema: {},
        output_shape: "OpenBrainContract JSON text payload",
      },
      log_thought: {
        version: 1,
        input_schema: {
          content: { type: "string", required: true, minLength: 1 },
          tags: { type: "array", required: false, items: "string" },
          namespace: {
            type: "string",
            required: false,
            minLength: 1,
            maxLength: 500,
          },
        },
        output_shape: "thought id/namespace/embedded/merged JSON text payload",
      },
      search_all: {
        version: 1,
        input_schema: {
          query: { type: "string", required: true, minLength: 1 },
          namespace: {
            type: "string",
            required: false,
            maxLength: 500,
          },
          limit: { type: "integer", required: false, min: 1, max: 250 },
          offset: { type: "integer", required: false, min: 0 },
          sources: {
            type: "enum",
            required: false,
            values: ["all", "brain", "qmd"],
          },
          search_mode: {
            type: "enum",
            required: false,
            values: ["hybrid", "vector", "keyword"],
          },
          tier: {
            type: "enum",
            required: false,
            values: ["hot", "warm", "cold"],
          },
        },
        output_shape: "unified search results JSON text payload",
      },
      session_start: {
        version: 1,
        input_schema: {
          session_key: {
            type: "string",
            required: true,
            minLength: 1,
            maxLength: 500,
          },
          namespace: { type: "string", required: false, maxLength: 500 },
          project: { type: "string", required: false, maxLength: 500 },
          agent: { type: "string", required: false, maxLength: 500 },
          channel_id: { type: "string", required: false, maxLength: 500 },
          thread_id: { type: "string", required: false, maxLength: 500 },
          topic: { type: "string", required: false, maxLength: 500 },
        },
        output_shape: "session lane plus recent events JSON text payload",
      },
      session_context: {
        version: 1,
        input_schema: {
          session_key: {
            type: "string",
            required: "session_key_or_channel_id",
            maxLength: 500,
          },
          namespace: { type: "string", required: false, maxLength: 500 },
          channel_id: {
            type: "string",
            required: "session_key_or_channel_id",
            maxLength: 500,
          },
          thread_id: { type: "string", required: false, maxLength: 500 },
          include_events: { type: "boolean", required: false, default: true },
          event_limit: {
            type: "integer",
            required: false,
            min: 1,
            max: 200,
            default: 50,
          },
          event_types: {
            type: "array",
            required: false,
            items: "session_event_type",
          },
          importance: {
            type: "enum",
            required: false,
            values: ["hot", "warm", "cold"],
          },
        },
        output_shape: "session lane plus recent events JSON text payload",
      },
      lane_upsert: {
        version: 1,
        input_schema: {
          session_key: {
            type: "string",
            required: true,
            minLength: 1,
            maxLength: 500,
          },
          namespace: { type: "string", required: false, maxLength: 500 },
          status: {
            type: "enum",
            required: false,
            values: ["active", "wrapped", "archived"],
          },
          agent: { type: "string", required: false, maxLength: 500 },
          source: { type: "string", required: false, maxLength: 500 },
          channel_id: { type: "string", required: false, maxLength: 500 },
          thread_id: { type: "string", required: false, maxLength: 500 },
          project: { type: "string", required: false, maxLength: 500 },
          topic: { type: "string", required: false, maxLength: 500 },
          current_context_md: {
            type: "string",
            required: false,
            maxLength: 100000,
          },
          metadata: {
            type: "object",
            required: false,
            propertyNames: { type: "string", maxLength: 100 },
            maxKeys: 50,
            maxJsonBytes: 100000,
          },
        },
        output_shape: "session lane JSON text payload",
      },
      lane_load: {
        version: 1,
        input_schema: {
          session_key: { type: "string", required: false },
          namespace: { type: "string", required: false },
          project: { type: "string", required: false },
          agent: { type: "string", required: false },
          channel_id: { type: "string", required: false },
          status: {
            type: "enum",
            required: false,
            default: "active",
            values: ["active", "wrapped", "archived"],
          },
          limit: { type: "integer", required: false, min: 1, max: 50 },
        },
        output_shape: "session lane array JSON text payload",
      },
      append_session_event: {
        version: 2,
        input_schema: {
          session_key: {
            type: "string",
            required: true,
            minLength: 1,
            maxLength: 500,
          },
          namespace: { type: "string", required: false, maxLength: 500 },
          event_type: {
            type: "enum",
            required: true,
            values: [
              "fact",
              "decision",
              "blocker",
              "action",
              "artifact",
              "receipt",
              "question",
              "correction",
              "handoff",
            ],
          },
          content: {
            type: "string",
            required: true,
            minLength: 1,
            maxLength: 50000,
          },
          source: { type: "string", required: false, maxLength: 500 },
          artifact_path: { type: "string", required: false, maxLength: 2000 },
          importance: {
            type: "enum",
            required: false,
            values: ["hot", "warm", "cold"],
          },
          metadata: {
            type: "object",
            required: false,
            maxKeys: 50,
            maxJsonBytes: 100000,
            fields: {
              share_candidate: {
                type: "boolean",
                required: false,
                description:
                  "Nominate this event for shared-kb promotion (shared truth every " +
                  "agent reads). Set true on a substantive fact/decision/handoff worth " +
                  "sharing. Adjudication is two-stage: SYNCHRONOUSLY the server refuses " +
                  "and strips the nomination if the content looks like a secret or " +
                  "person-private data — when that happens the event still saves but the " +
                  "response carries share_candidate_rejected with the reason. " +
                  "ASYNCHRONOUSLY a promoter-gated sweep re-classifies worthiness, " +
                  "de-duplicates against shared-kb, and promotes survivors. Do NOT set " +
                  "true for secrets, credentials, or private/personal content.",
              },
            },
          },
        },
        output_shape: "session event JSON text payload",
      },
      session_wrap: {
        version: 1,
        input_schema: {
          session_key: {
            type: "string",
            required: true,
            minLength: 1,
            maxLength: 500,
          },
          namespace: { type: "string", required: false, maxLength: 500 },
          summary: { type: "string", required: true, maxLength: 100000 },
          key_decisions: {
            type: "array",
            required: false,
            items: "string",
            maxItems: 20,
            maxItemLength: 2000,
          },
          next_steps: {
            type: "array",
            required: false,
            items: "string",
            maxItems: 20,
            maxItemLength: 2000,
          },
          project: { type: "string", required: false, maxLength: 500 },
        },
        output_shape: "session wrap checkpoint JSON text payload",
      },
      upsert_repo_fact: {
        version: 1,
        input_schema: {
          namespace: { type: "string", required: false, maxLength: 500 },
          metadata: REPO_FACT_METADATA_CONTRACT,
          validation: REPO_FACT_VALIDATION_CONTRACT,
        },
        output_shape: "ob_entities repo_fact row JSON text payload",
      },
      list_repo_facts: {
        version: 1,
        input_schema: {
          namespace: { type: "string", required: false, maxLength: 500 },
          repo: { type: "string", required: false, maxLength: 300 },
          collection: { type: "string", required: false, maxLength: 300 },
          path: { type: "string", required: false, maxLength: 1000 },
          fact_type: {
            type: "enum",
            required: false,
            values: REPO_FACT_METADATA_CONTRACT.fact_type.values,
          },
          subject: { type: "string", required: false, maxLength: 500 },
          limit: { type: "integer", required: false, min: 1, max: 250 },
          offset: { type: "integer", required: false, min: 0 },
        },
        output_shape: "repo_fact ob_entities row array JSON text payload",
      },
    },
  };

  return {
    ...payload,
    schema_hash: contractHash(payload),
    generated_at: generatedAt,
  };
}
