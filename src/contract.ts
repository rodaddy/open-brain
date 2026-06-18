import { createHash } from "node:crypto";
import { REPO_FACT_METADATA_CONTRACT } from "./tools/repo-facts.ts";

export const CONTRACT_VERSION = "2026-06-18.repo-facts.v1";
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

export function contractHash(payload: Omit<OpenBrainContract, "generated_at" | "schema_hash">): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

export function buildContract(generatedAt = new Date().toISOString()): OpenBrainContract {
  const payload = {
    service: "open-brain" as const,
    contract_version: CONTRACT_VERSION,
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
      upsert_repo_fact: {
        version: 1,
        input_schema: {
          namespace: { type: "string", required: false, maxLength: 500 },
          metadata: REPO_FACT_METADATA_CONTRACT,
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
