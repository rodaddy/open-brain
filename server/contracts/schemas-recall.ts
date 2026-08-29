/**
 * Contract entries for recovery WAL handling and the entry/thought/search
 * read surface.
 */
import { SOURCE_REFS_CONTRACT, SOURCE_SCOPE_CONTRACT } from "../../src/source-refs.ts";
import type { ToolContract } from "./tool-contract.ts";

export const RECALL_TOOL_CONTRACTS: Record<string, ToolContract> = {
  recovery_wal_append: {
    version: 1,
    input_schema: {
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Namespace for isolation. Defaults to auth-derived clientId; the " +
          "server enforces write authority before accepting recovery WAL records.",
      },
      agent: { type: "string", required: true, minLength: 1, maxLength: 200 },
      platform: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 200,
      },
      server_id: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      channel_id: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      thread_id: { type: "string", required: false, maxLength: 500 },
      session_key: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      content: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 8000,
        description:
          "Bounded quarantined recovery content. This does not create durable " +
          "memory, shared-kb, or searchable recall rows.",
      },
      status: {
        type: "enum",
        required: false,
        values: [
          "active",
          "wrapped",
          "recovery_pending",
          "reviewed",
          "compacted",
          "discarded",
          "expired",
        ],
        default: "active",
      },
      trace_id: { type: "string", required: false, maxLength: 500 },
      source_ref: { type: "string", required: false, maxLength: 1000 },
      metadata: {
        type: "object",
        required: false,
        maxSerializedChars: 2000,
      },
    },
    output_shape:
      "quarantined recovery WAL append receipt with accepted/reason/item/counters/not_durable_memory/not_searchable_recall",
  },
  recovery_wal_mark: {
    version: 1,
    input_schema: {
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Namespace for isolation. Defaults to auth-derived clientId; the " +
          "server enforces write authority before marking recovery WAL records.",
      },
      agent: { type: "string", required: true, minLength: 1, maxLength: 200 },
      platform: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 200,
      },
      server_id: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      channel_id: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      thread_id: { type: "string", required: false, maxLength: 500 },
      session_key: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      id: { type: "string", required: true, minLength: 1, maxLength: 200 },
      action: {
        type: "enum",
        required: true,
        values: [
          "review",
          "use_for_current_session",
          "compact_to_wrap",
          "promote_candidates",
          "discard",
          "defer",
        ],
      },
      status: {
        type: "enum",
        required: true,
        values: [
          "active",
          "wrapped",
          "recovery_pending",
          "reviewed",
          "compacted",
          "discarded",
          "expired",
        ],
      },
      purge: {
        type: "boolean",
        required: false,
        default: false,
        description: "Remove the exact recovery record after review.",
      },
    },
    output_shape:
      "quarantined recovery WAL mark receipt with accepted/reason/item/purged/counters/not_durable_memory/not_searchable_recall",
  },
  get_entry: {
    version: 2,
    input_schema: {
      table: {
        type: "enum",
        required: true,
        values: ["thoughts", "decisions", "relationships", "projects", "sessions"],
        description:
          "Readable table containing the target row. Use the plural table " +
          "name derived from search result source_type.",
      },
      id: {
        type: "string",
        required: true,
        format: "uuid",
        description:
          "Entry UUID to fetch. The server applies auth-derived namespace " +
          "predicates before returning any row.",
      },
      render: {
        type: "enum",
        required: false,
        values: ["full", "compact"],
        default: "full",
        description:
          "Response shape. full returns the complete readable row; compact " +
          "returns a bounded exact-UUID preview envelope for cheap recall.",
      },
      max_chars: {
        type: "integer",
        required: false,
        min: 80,
        max: 2000,
        default: 500,
        description:
          "Maximum compact content_preview length in characters. Applies only " +
          "when render is compact.",
      },
      source_scope: SOURCE_SCOPE_CONTRACT,
    },
    output_shape:
      "full readable entry row JSON text payload with source_refs redacted unless source_scope is supplied, or compact envelope with content_preview/content_length/content_truncated/source_ref/fetch_path; compact source_scope filters visibility only and carries source_scope in fetch_path for full ref retrieval",
  },
  decompose_entry: {
    version: 1,
    input_schema: {
      table: {
        type: "enum",
        required: true,
        values: ["thoughts", "decisions", "relationships", "projects", "sessions"],
        description: "Readable source table containing the oversized row to decompose.",
      },
      id: {
        type: "string",
        required: true,
        format: "uuid",
        description:
          "Source entry UUID. The server applies auth-derived namespace " +
          "predicates before reading any row.",
      },
      max_chunk_chars: {
        type: "integer",
        required: false,
        min: 500,
        max: 8000,
        default: 2000,
        description: "Must be greater than overlap_chars.",
      },
      overlap_chars: {
        type: "integer",
        required: false,
        min: 0,
        max: 1000,
        default: 200,
        description: "Must be less than max_chunk_chars.",
      },
      dry_run: {
        type: "boolean",
        required: false,
        default: true,
        description: "Defaults true. false requires apply_mode=write_replacements.",
      },
      apply_mode: {
        type: "enum",
        required: false,
        values: ["write_replacements"],
        description:
          "Required with dry_run=false to write replacement thoughts. Source " +
          "rows are never archived, demoted, promoted, or tier-mutated.",
      },
    },
    output_shape:
      "dry-run decomposition plan with source_ref/proposed_replacements/proposed_links/would_write plus raw_source_text/source_length and trimmed_chunk_text/content_length bases; explicit apply adds written_ids/skipped_duplicates/intra_batch_duplicates/fully_written/apply_summary without source-row mutation, and preserves not_oversized as a no-op when nothing would be written",
  },
  resolve_entry: {
    version: 1,
    input_schema: {
      id: {
        type: "string",
        required: true,
        format: "uuid",
        description:
          "Entry UUID to resolve across readable source families. The server " +
          "applies auth-derived namespace predicates before disclosing source metadata.",
      },
      namespace: {
        type: "string",
        required: false,
        minLength: 1,
        maxLength: 500,
        description:
          "Optional namespace to constrain resolution. The server checks this " +
          "against auth-derived read policy.",
      },
    },
    output_shape:
      "resolver JSON text payload with resolved/status/id/source_type/table/namespace/fetch_path/checked_sources/checked_tables",
  },
  log_thought: {
    version: 2,
    input_schema: {
      content: {
        type: "string",
        required: true,
        minLength: 1,
        description:
          "The thought text to store. Write a complete, self-contained " +
          "statement that will still make sense out of context later — this " +
          "is what gets embedded and returned by future searches.",
      },
      tags: {
        type: "array",
        required: false,
        items: "string",
        description:
          "Optional freeform labels for grouping and filtering (e.g. topic, " +
          "project, or category). Use consistent tag names so related " +
          "thoughts cluster together.",
      },
      namespace: {
        type: "string",
        required: false,
        minLength: 1,
        maxLength: 500,
        description:
          "Memory partition to write into. Defaults to your own " +
          "auth-derived namespace; leave unset unless a global/admin token " +
          "is intentionally writing into another namespace (e.g. shared-kb).",
      },
      source_refs: SOURCE_REFS_CONTRACT,
    },
    output_shape: "thought id/namespace/embedded/merged/source_refs JSON text payload",
  },
  search_all: {
    version: 2,
    input_schema: {
      query: {
        type: "string",
        required: true,
        minLength: 1,
        description:
          "What you are looking for, in natural language. Phrase it as the " +
          "concept or question you want to recall; hybrid/vector modes match " +
          "on meaning, not just exact words.",
      },
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Which memory partition to search. Defaults to your own " +
          "auth-derived namespace; override only to read another namespace " +
          "you are authorized for (e.g. shared-kb for shared knowledge).",
      },
      limit: {
        type: "integer",
        required: false,
        min: 1,
        max: 250,
        description:
          "Maximum number of results to return (1-250). Start small (e.g. " +
          "10-20) for focused recall; raise it when you need broad coverage.",
      },
      offset: {
        type: "integer",
        required: false,
        min: 0,
        description:
          "Number of results to skip before returning, for paging through a " +
          "large result set. Leave at 0 for the first page.",
      },
      sources: {
        type: "enum",
        required: false,
        values: ["all", "brain", "qmd"],
        description:
          "Which corpora to search: all (default, both), brain (only stored " +
          "memory — thoughts, session events, facts), qmd (only indexed code " +
          "context). Narrow this when you know which corpus you need.",
      },
      collection: {
        type: "string",
        required: false,
        minLength: 1,
        description:
          "Optional qmd collection filter. Use with sources='qmd' or " +
          "sources='all' when you need code/document context from one indexed " +
          "collection such as open-brain-runtime.",
      },
      search_mode: {
        type: "enum",
        required: false,
        values: ["hybrid", "vector", "keyword"],
        description:
          "How to match: hybrid (default, blends vector + keyword — use " +
          "unless you have a reason not to), vector (semantic similarity " +
          "only — best for fuzzy/conceptual recall), keyword (exact-term " +
          "only — best for identifiers, error strings, or exact phrases).",
      },
      tier: {
        type: "enum",
        required: false,
        values: ["hot", "warm", "cold"],
        description:
          "Optional importance/recency tier filter: hot (most recent/most " +
          "important), warm (mid), cold (archival). Omit to search all " +
          "tiers; set only when you want to restrict by significance.",
      },
      source_scope: SOURCE_SCOPE_CONTRACT,
    },
    output_shape:
      "unified search results JSON text payload; source_scope filters Open Brain results and suppresses qmd results",
  },
};
