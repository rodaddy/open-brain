import {
  REPO_FACT_METADATA_CONTRACT,
  REPO_FACT_VALIDATION_CONTRACT,
} from "./tools/repo-facts.ts";
import { SOURCE_REFS_CONTRACT, SOURCE_SCOPE_CONTRACT } from "./source-refs.ts";

export interface ToolContract {
  version: number;
  input_schema: unknown;
  output_shape: string;
}

export const TOOL_CONTRACTS: Record<string, ToolContract> = {
  get_contract: {
    version: 1,
    input_schema: {},
    output_shape: "OpenBrainContract JSON text payload",
  },
  operator_doctor: {
    version: 1,
    input_schema: {},
    output_shape:
      "privileged operator doctor/status JSON text payload with stable " +
      "runtime, database, migrations, optional provider, transport, and " +
      "log/audit health fields; secrets and raw paths are redacted/omitted",
  },
  working_set_append: {
    version: 1,
    input_schema: {
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Namespace for isolation. Defaults to the auth-derived clientId; " +
          "the server enforces write authority before accepting RAM working context.",
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
      thread_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description: "Optional thread id. Missing means unthreaded scope only.",
      },
      session_key: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      kind: {
        type: "enum",
        required: true,
        values: [
          "recent_event",
          "structured_event",
          "current_intent",
          "active_correction",
          "task_state",
          "linked_durable_ref",
          "next_turn_guidance",
        ],
      },
      content: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 4000,
        description:
          "Bounded RAM-only working context. This does not create durable " +
          "memory, shared-kb, or searchable recall rows.",
      },
      confidence: { type: "number", required: false, min: 0, max: 1 },
      stale_at: { type: "string", required: false, maxLength: 100 },
      trace_id: { type: "string", required: false, maxLength: 500 },
      source_ref: { type: "string", required: false, maxLength: 1000 },
      durable_ref: {
        type: "object",
        required: false,
        fields: {
          table: {
            type: "string",
            required: true,
            minLength: 1,
            maxLength: 100,
          },
          id: { type: "string", required: true, minLength: 1, maxLength: 200 },
        },
      },
      metadata: {
        type: "object",
        required: false,
        maxSerializedChars: 2000,
        description:
          "Optional bounded JSON metadata. Serialized metadata larger than " +
          "2000 characters is rejected before retention.",
      },
    },
    output_shape:
      "RAM-only working-set append receipt with accepted/reason/item/counters/not_durable_memory",
  },
  agent_context_pack: {
    version: 2,
    input_schema: {
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Namespace for isolation. Defaults to auth-derived clientId; the " +
          "server enforces read authority before returning any scoped context.",
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
      query: { type: "string", required: false, maxLength: 4000 },
      requested_sections: {
        type: "array",
        required: false,
        description:
          "Sections to assemble. durable_lane_context is opt-in and returns " +
          "bounded lane checkpoint/event data only after all seven exact scope " +
          "coordinates match; omitted sections are not queried.",
        items: {
          type: "enum",
          values: [
            "working_set",
            "recovery",
            "durable_lane_context",
            "durable_memory",
            "profile_guidance",
            "process_guidance",
            "repo_facts",
            "pointers",
            "candidate_memory",
          ],
        },
      },
      include_unreviewed_recovery: {
        type: "boolean",
        required: false,
        default: false,
        description:
          "Explicit opt-in to include exact-scope quarantined recovery " +
          "summary. Recovery records are not durable memory or searchable recall.",
      },
      budget: {
        type: "object",
        required: false,
        fields: {
          max_tokens: {
            type: "integer",
            required: false,
            min: 100,
            max: 20000,
          },
          max_latency_ms: {
            type: "integer",
            required: false,
            min: 1,
            max: 10000,
          },
        },
      },
    },
    output_shape:
      "agent_context_pack envelope with exact-scope working_set, explicitly opted-in recovery, and explicitly requested bounded durable_lane_context sections; warnings include generic exact-scope denials/degraded sources/truncation, budget declares per-source bounds, and citations identify returned durable lane/events",
  },
  agent_reflex_pointers: {
    version: 1,
    input_schema: {
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Namespace for isolation. Defaults to auth-derived clientId; the " +
          "server enforces read authority before returning any scoped pointers.",
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
      query: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 4000,
        description:
          "Current-turn query that drives the single durable_memory hybrid " +
          "recall the pointer pool is derived from. Required — a reflex with " +
          "no query has no pool to point at.",
      },
      prior_context: {
        type: "array",
        required: false,
        maxItems: 200,
        description:
          "Explicit identifiers/source refs already supplied to the model this " +
          "turn. The shared recall removes records already represented by these " +
          "references before any pointer is emitted, so the reflex points only " +
          "at net-new durable records. Raw prior-context text is never accepted; " +
          "each reference carries resolvable identity only (citation_id or " +
          "source_ref).",
        items: {
          type: "object",
          fields: {
            citation_id: {
              type: "string",
              required: "citation_id_or_source_ref",
              minLength: 1,
              maxLength: 500,
            },
            source_ref: {
              type: "union",
              required: "citation_id_or_source_ref",
              description:
                "The recalled item's own resolvable source ref: either the " +
                "string form (<=1000) or the structural {source,type,id," +
                "namespace?} form. At least one of citation_id/source_ref is " +
                "required per reference.",
              variants: [
                { type: "string", minLength: 1, maxLength: 1000 },
                {
                  type: "object",
                  additionalProperties: true,
                  fields: {
                    source: {
                      type: "string",
                      required: true,
                      minLength: 1,
                      maxLength: 200,
                    },
                    type: {
                      type: "string",
                      required: true,
                      minLength: 1,
                      maxLength: 200,
                    },
                    id: {
                      type: "string",
                      required: true,
                      minLength: 1,
                      maxLength: 500,
                    },
                    namespace: {
                      type: "string",
                      required: false,
                      minLength: 1,
                      maxLength: 200,
                    },
                  },
                },
              ],
            },
          },
        },
      },
      budget: {
        type: "object",
        required: false,
        fields: {
          max_tokens: {
            type: "integer",
            required: false,
            min: 100,
            max: 20000,
          },
          max_latency_ms: {
            type: "integer",
            required: false,
            min: 1,
            max: 10000,
          },
        },
      },
    },
    output_shape:
      "ordinary agent_reflex_pointers.v1 result envelope (schema/status/scope/query, placement=client_owned, resolvable_reference_only=true) carrying a single body-free pointers section: namespace-scoped resolvable pointers with identity/source_ref/structural metadata only and NO memory bodies, deduped against retained durable identities with prior-context suppression applied and whole-pack budget bounded; citations are a bijection with the emitted pointers (kind=pointer), and warnings/budget are carried through from the shared pack so budget starvation and degraded/denied shared recall stay honest",
  },
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
        values: [
          "thoughts",
          "decisions",
          "relationships",
          "projects",
          "sessions",
        ],
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
        values: [
          "thoughts",
          "decisions",
          "relationships",
          "projects",
          "sessions",
        ],
        description:
          "Readable source table containing the oversized row to decompose.",
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
        description:
          "Defaults true. false requires apply_mode=write_replacements.",
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
    output_shape:
      "thought id/namespace/embedded/merged/source_refs JSON text payload",
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
  session_start: {
    version: 2,
    input_schema: {
      session_key: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
        description:
          "Stable identifier for this session lane. Reuse the same key to " +
          "resume an existing lane; pick a new one to start a fresh lane. " +
          "Use a deterministic value you can reconstruct later (e.g. a " +
          "channel/thread id or task slug), not a random string.",
      },
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition for the lane. Defaults to your own auth-derived " +
          "namespace; override only when authorized to operate in another.",
      },
      project: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Project this session belongs to. Set it to scope and later " +
          "filter lanes by project (e.g. in lane_load).",
      },
      agent: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Which agent owns this session (e.g. hermes, bilby, skippy). Set " +
          "so lanes can be attributed and filtered by agent.",
      },
      platform: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Platform/source identity for exact-scope lanes, such as discord. " +
          "A supplied value is attached only when unasserted and mismatches fail closed.",
      },
      server_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Server/guild/workspace identity for exact-scope lanes. Stored in lane metadata; " +
          "a supplied mismatch fails closed.",
      },
      channel_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Originating channel id (e.g. Discord/Slack channel). Set for " +
          "chat-driven sessions so the lane can later be looked up by channel.",
      },
      thread_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Originating thread id within the channel, if the conversation is " +
          "threaded. Set to distinguish parallel threads in one channel.",
      },
      topic: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Short human-readable subject for the session. Helps identify the " +
          "lane at a glance when listing or resuming.",
      },
    },
    output_shape:
      "session lane plus recent events JSON text payload; when all exact-scope fields are supplied, previously unasserted coordinates are attached and asserted mismatches fail closed; null thread is unthreaded rather than wildcard",
  },
  session_context: {
    version: 3,
    input_schema: {
      session_key: {
        type: "string",
        required: "session_key_or_channel_id",
        maxLength: 500,
        description:
          "Identifier of the lane to read. Either session_key OR channel_id " +
          "is required — provide session_key when you know the lane's key; " +
          "otherwise resolve by channel_id.",
      },
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition to read from. Defaults to your own auth-derived " +
          "namespace; override only when authorized for another.",
      },
      channel_id: {
        type: "string",
        required: "session_key_or_channel_id",
        maxLength: 500,
        description:
          "Originating channel id to resolve the lane by. Either " +
          "channel_id OR session_key is required — use this when you have " +
          "the chat channel but not the lane's session_key.",
      },
      thread_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Thread id to disambiguate when a single channel_id maps to " +
          "multiple threaded lanes.",
      },
      include_events: {
        type: "boolean",
        required: false,
        default: true,
        description:
          "Whether to include the lane's recent journal events (default " +
          "true). Set false for a lightweight read of just lane metadata.",
      },
      event_limit: {
        type: "integer",
        required: false,
        min: 1,
        max: 200,
        default: 50,
        description:
          "Maximum recent events to return (1-200, default 50). Lower it " +
          "for a quick peek; raise it to rehydrate more history.",
      },
      event_types: {
        type: "array",
        required: false,
        items: "session_event_type",
        description:
          "Optional filter to only these event types (e.g. decision, " +
          "blocker). Omit to return all types; set to focus on a category.",
      },
      importance: {
        type: "enum",
        required: false,
        values: ["hot", "warm", "cold"],
        description:
          "Optional filter by event importance tier: hot (most important), " +
          "warm, cold. Omit to include all tiers.",
      },
    },
    output_shape:
      "session lane plus recent events JSON text payload; events may include " +
      "transcript_ref, transcript, and occurred_at citation fields",
  },
  citation_recall: {
    version: 1,
    input_schema: {
      event_id: {
        type: "string",
        required: true,
        format: "uuid",
        description: "Readable session event UUID to cite.",
      },
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition to read. Defaults to the auth-derived namespace and is enforced server-side.",
      },
      context_limit: {
        type: "integer",
        required: false,
        min: 0,
        max: 10,
        default: 2,
        description:
          "Neighboring transcript exchanges returned before and after the cited event.",
      },
      max_transcript_chars: {
        type: "integer",
        required: false,
        min: 100,
        max: 50000,
        default: 2000,
        description:
          "Maximum characters from each returned source exchange; raise explicitly to expand context.",
      },
    },
    output_shape:
      "citation JSON text payload with fact and either citation.status=stored " +
      "(host-neutral conversation_ref, speaker, date, optional transcript, bounded before/after context) " +
      "or citation.status=source_not_stored for legacy evidence-less events",
  },
  lane_upsert: {
    version: 2,
    input_schema: {
      session_key: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
        description:
          "Identifier of the lane to create or update. Reuse an existing " +
          "key to update that lane in place; a new key creates a new lane.",
      },
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition for the lane. Defaults to your own auth-derived " +
          "namespace; override only when authorized for another.",
      },
      status: {
        type: "enum",
        required: false,
        values: ["active", "wrapped", "archived"],
        description:
          "Lifecycle state: active (in progress, default for new lanes), " +
          "wrapped (checkpointed/handed off), archived (closed out). Set to " +
          "transition a lane; usually session_wrap manages this for you.",
      },
      agent: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Owning agent for the lane (e.g. hermes, bilby, skippy). Set so " +
          "lanes can be attributed and filtered by agent.",
      },
      source: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Where the lane originated (e.g. cli, discord, cron). Set for " +
          "provenance when a lane can come from multiple entry points.",
      },
      channel_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Originating channel id, for chat-driven lanes. Set so the lane " +
          "can later be resolved by channel.",
      },
      thread_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description: "Originating thread id within the channel, when threaded.",
      },
      project: {
        type: "string",
        required: false,
        maxLength: 500,
        description: "Project the lane belongs to, for scoping and filtering.",
      },
      topic: {
        type: "string",
        required: false,
        maxLength: 500,
        description: "Short human-readable subject for the lane.",
      },
      current_context_md: {
        type: "string",
        required: false,
        maxLength: 100000,
        description:
          "Rolling working-context summary in Markdown — the lane's " +
          '"where we are right now" scratchpad. Overwrite it as the session ' +
          "evolves so a resuming agent gets the current picture without " +
          "replaying every event.",
      },
      metadata: {
        type: "object",
        required: false,
        propertyNames: { type: "string", maxLength: 100 },
        maxKeys: 50,
        maxJsonBytes: 100000,
        description:
          "Arbitrary structured key/value metadata for the lane (max 50 " +
          "keys, 100KB JSON). Use for machine-readable tags or pointers; " +
          "keep human narrative in current_context_md.",
      },
    },
    output_shape: "session lane JSON text payload",
  },
  lane_load: {
    version: 2,
    input_schema: {
      session_key: {
        type: "string",
        required: false,
        description:
          "Filter to a single lane by its exact key. Omit to list by other " +
          "filters instead.",
      },
      namespace: {
        type: "string",
        required: false,
        description:
          "Memory partition to list lanes from. Defaults to your own " +
          "auth-derived namespace; override only when authorized for another.",
      },
      project: {
        type: "string",
        required: false,
        description:
          "Filter to lanes for this project. Combine with status to find " +
          "active work on a given project.",
      },
      agent: {
        type: "string",
        required: false,
        description:
          "Filter to lanes owned by this agent (e.g. hermes, bilby).",
      },
      channel_id: {
        type: "string",
        required: false,
        description: "Filter to lanes from this originating chat channel.",
      },
      status: {
        type: "enum",
        required: false,
        default: "active",
        values: ["active", "wrapped", "archived"],
        description:
          "Lifecycle filter (default active). Use active to find in-progress " +
          "lanes to resume, wrapped/archived to review past sessions.",
      },
      limit: {
        type: "integer",
        required: false,
        min: 1,
        max: 50,
        description:
          "Maximum lanes to return (1-50). Lanes come back most-recent " +
          "first, so a small limit gives you the latest activity.",
      },
    },
    output_shape: "session lane array JSON text payload",
  },
  append_session_event: {
    version: 8,
    input_schema: {
      session_key: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
        description:
          "Identifier of the lane to append to. With create_if_missing=true, " +
          "a missing lane is created first and the event is journaled under it.",
      },
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition for the event. Defaults to your own " +
          "auth-derived namespace; override only when authorized for another.",
      },
      create_if_missing: {
        type: "boolean",
        required: false,
        description:
          "Create the session lane when it is missing, then append the event. " +
          "Use for first-write realtime agent scopes so callers do not have to " +
          "pre-provision lanes manually. Repeated calls with the same " +
          "namespace/session_key return or reuse the same lane.",
      },
      agent: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Agent identity to bind when create_if_missing creates a lane. On an " +
          "existing legacy lane, a previously null agent is atomically attached; " +
          "an asserted mismatch fails closed.",
      },
      platform: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Platform/source identity to bind when create_if_missing creates a " +
          "lane, such as discord. Stored as lane source; a previously null legacy " +
          "value is atomically attached and an asserted mismatch fails closed.",
      },
      server_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Server/guild identity for exact realtime scope. Stored in lane metadata; " +
          "a previously absent legacy value is atomically attached and an asserted " +
          "mismatch fails closed.",
      },
      channel_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Channel identity to bind when create_if_missing creates a lane. On an " +
          "existing legacy lane, a previously null channel is atomically attached; " +
          "an asserted mismatch fails closed.",
      },
      thread_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Thread identity to bind when create_if_missing creates a lane. On an " +
          "incompletely scoped legacy lane, a non-null thread may be atomically " +
          "attached; once the lane is otherwise exact, null means unthreaded and " +
          "an asserted mismatch fails closed.",
      },
      project: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Project name to set if create_if_missing creates the lane.",
      },
      topic: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Human-readable topic to set if create_if_missing creates the lane.",
      },
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
        description:
          "What kind of event this is — choose the closest: fact (something " +
          "learned/true), decision (a choice made), blocker (something " +
          "stopping progress), action (a step taken), artifact (a file/output " +
          "produced), receipt (proof/result of an action), question (an open " +
          "unknown), correction (fixes a prior event), handoff (context " +
          "passed to the next session/agent). Pick accurately — type drives " +
          "filtering and recall.",
      },
      content: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 50000,
        description:
          "The event text. Write a complete, self-contained statement that " +
          "will make sense when recalled later without surrounding context.",
      },
      source: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Where this event came from (e.g. tool name, user, agent). Set " +
          "for provenance when it aids later attribution.",
      },
      artifact_path: {
        type: "string",
        required: false,
        maxLength: 2000,
        description:
          "Path or URI to a produced/referenced artifact (file, doc, URL). " +
          "Set especially for artifact events so the output can be located.",
      },
      transcript_ref: {
        type: "string",
        required: false,
        minLength: 1,
        maxLength: 2000,
        description:
          "Host-neutral source conversation reference. Must use collab/... and must not contain /Volumes/ or /mnt/ host paths.",
      },
      transcript: {
        type: "string",
        required: false,
        maxLength: 50000,
        description:
          "Optional inline exchange from transcript_ref. transcript_ref is required when this is supplied.",
      },
      occurred_at: {
        type: "string",
        required: false,
        format: "date-time",
        description:
          "ISO 8601 timestamp with timezone for the cited exchange. transcript_ref is required when this is supplied.",
      },
      importance: {
        type: "enum",
        required: false,
        values: ["hot", "warm", "cold"],
        description:
          "Significance tier: hot (high — surfaces first in recall), warm " +
          "(normal), cold (low/archival). Use hot for pivotal " +
          "facts/decisions, cold for routine noise.",
      },
      metadata: {
        type: "object",
        required: false,
        maxKeys: 50,
        maxJsonBytes: 100000,
        description:
          "Arbitrary structured key/value metadata for the event (max 50 " +
          "keys, 100KB JSON), plus the recognized explicit memory lifecycle " +
          "fields below.",
        fields: {
          memory_lifecycle_action: {
            type: "enum",
            required: false,
            values: [
              "candidate",
              "promote",
              "relegate",
              "discard",
              "nominate_shared",
            ],
            description:
              "Client-owned lifecycle action for memory extracted from this " +
              "event. candidate marks review-only material; promote/relegate/" +
              "discard record explicit client handling; nominate_shared is the " +
              "only action eligible for the shared-kb promoter, and still " +
              "requires share_candidate=true plus server safety checks.",
          },
          candidate_type: {
            type: "enum",
            required: false,
            values: [
              "user_preference",
              "process_rule",
              "channel_server_rule",
              "code_repo_fact",
              "positive_example",
              "negative_example",
              "durable_decision",
              "shared_kb_nomination",
            ],
            description:
              "Candidate classification chosen by the client/runtime. User " +
              "corrections that should teach future behavior without immediate " +
              "durable promotion should use negative_example.",
          },
          candidate_reason: {
            type: "string",
            required: false,
            maxLength: 2000,
            description:
              "Explicit client reason for creating, promoting, relegating, " +
              "discarding, or nominating the candidate.",
          },
          candidate_confidence: {
            type: "number",
            required: false,
            min: 0,
            max: 1,
            description:
              "Client confidence that the candidate is useful and correctly " +
              "scoped. This is advisory; Open Brain still enforces auth and " +
              "safety.",
          },
          candidate_scope: {
            type: "object",
            required: false,
            description:
              "Client-declared scope for the candidate, such as repo, project, " +
              "agent, server_id, channel_id, thread_id, or session_key. It is " +
              "provenance, not an authorization override.",
          },
          candidate_staleness_policy: {
            type: "string",
            required: false,
            maxLength: 1000,
            description:
              "When the candidate should expire, be revalidated, or be treated " +
              "as historical context only.",
          },
          evidence_refs: {
            type: "array",
            required: false,
            items: "object",
            maxItems: 20,
            maxItemJsonBytes: 2000,
            maxTotalJsonBytes: 10000,
            description:
              "Citation-safe evidence references for the candidate, such as " +
              "event ids, issue URLs, repo paths, commit SHAs, or source refs. " +
              "The server bounds serialized evidence metadata and rejects " +
              "secret-like evidence refs. Do not include raw private transcripts " +
              "or secrets.",
          },
          share_candidate: {
            type: "boolean",
            required: false,
            description:
              "Shared-kb nomination marker. By itself this is candidate " +
              "metadata only and must not create a shared-kb write. The " +
              "promoter only considers rows where share_candidate=true AND " +
              "memory_lifecycle_action=nominate_shared. SYNCHRONOUSLY the " +
              "server refuses and strips the nomination if content looks like " +
              "a secret or person-private data; the event still saves and the " +
              "response carries share_candidate_rejected with the reason. Do " +
              "NOT set true for secrets, credentials, or private/personal content.",
          },
          sanitized_resubmit_of: {
            type: "string",
            required: false,
            description:
              "When resubmitting a sanitized replacement after a synchronous " +
              "share_candidate rejection, set this to reject_detail.resubmit_metadata." +
              "sanitized_resubmit_of from a resubmittable rejected event response.",
          },
          sanitized_resubmit_attempt: {
            type: "integer",
            required: false,
            min: 1,
            max: 2,
            description:
              "Bounded sanitized resend attempt count. Set this to " +
              "reject_detail.resubmit_metadata.sanitized_resubmit_attempt when " +
              "re-nominating a sanitized replacement. The server derives an " +
              "observed attempt from prior same-lane rejections and marks further " +
              "sync rejections non-resubmittable after the maximum attempt.",
          },
          okf: {
            type: "object",
            required: false,
            description:
              "Optional Open Knowledge Format compatibility metadata for future " +
              "edge export/import. Open Brain remains authoritative; this object " +
              "is only a disclosure/interchange hook. Use OKF-like keys such as " +
              "type, title, description, resource, tags, timestamp, citations, " +
              "and links. Unknown keys should be preserved by clients/exporters.",
          },
        },
      },
    },
    output_shape:
      "session event JSON text payload with lane_created, transcript_ref when supplied, " +
      "writer_identity, token_identity, delegated_agent_id, and namespace_source provenance " +
      "fields; sync share_candidate rejections include share_candidate_rejected " +
      "and reject_detail {category, matched_kind, span_count, redaction_hint, " +
      "resubmittable, resubmit_attempt, max_resubmit_attempts, optional " +
      "resubmit_blocked_reason, and resubmit_metadata only when resubmittable}; " +
      "reject_detail never echoes offending content; supplied exact-scope coordinates on an existing legacy lane " +
      "are atomically attached only where unasserted before the event insert, while any asserted scope conflict " +
      "returns scope_validation; other error classes are retryable_outage, auth_denied, unsupported_operation, " +
      "or conflict_retry",
  },
  session_wrap: {
    version: 2,
    input_schema: {
      session_key: {
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
        description:
          "Identifier of the lane to checkpoint. Must match the lane you " +
          "have been working in.",
      },
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition for the lane. Defaults to your own auth-derived " +
          "namespace; override only when authorized for another.",
      },
      agent: {
        type: "string",
        required: false,
        maxLength: 500,
        description: "Agent identity for exact-scope checkpoint validation.",
      },
      platform: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Platform/source identity for exact-scope checkpoint validation.",
      },
      server_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Server/guild/workspace identity for exact-scope checkpoint validation.",
      },
      channel_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description: "Channel identity for exact-scope checkpoint validation.",
      },
      thread_id: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Thread identity. When channel_id is supplied and thread_id is omitted, " +
          "the request asserts an unthreaded lane rather than a wildcard.",
      },
      summary: {
        type: "string",
        required: true,
        maxLength: 100000,
        description:
          "Narrative recap of what happened this session — enough that a " +
          "fresh agent could resume without replaying the journal. Cover " +
          "what was done, current state, and anything important learned.",
      },
      key_decisions: {
        type: "array",
        required: false,
        items: "string",
        maxItems: 20,
        maxItemLength: 2000,
        description:
          "The notable decisions made this session, one per item (max 20). " +
          "Capture choices a future session must respect or might revisit.",
      },
      next_steps: {
        type: "array",
        required: false,
        items: "string",
        maxItems: 20,
        maxItemLength: 2000,
        description:
          "Concrete follow-up actions for the next session, one per item " +
          "(max 20). Write them as actionable items so a resuming agent " +
          "knows exactly what to pick up.",
      },
      project: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Project this wrap belongs to, for scoping and later filtering.",
      },
      source_refs: SOURCE_REFS_CONTRACT,
    },
    output_shape:
      "session wrap checkpoint/source_refs JSON text payload; supplied exact scope is established and validated before the transactional session/current_context_md write; duplicate content_hash checkpoints do not merge later source_refs but still materialize the scoped lane summary",
  },
  upsert_repo_fact: {
    version: 2,
    input_schema: {
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition to write the fact into. Defaults to your own " +
          "auth-derived namespace; override only when authorized (e.g. " +
          "promoting into shared-kb).",
      },
      metadata: REPO_FACT_METADATA_CONTRACT,
      validation: REPO_FACT_VALIDATION_CONTRACT,
    },
    output_shape: "ob_entities repo_fact row JSON text payload",
  },
  list_repo_facts: {
    version: 2,
    input_schema: {
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition to read facts from. Defaults to your own " +
          "auth-derived namespace; override only when authorized for another.",
      },
      repo: {
        type: "string",
        required: false,
        maxLength: 300,
        description:
          "Filter to facts about this repository slug (e.g. owner/repo).",
      },
      collection: {
        type: "string",
        required: false,
        maxLength: 300,
        description: "Filter to facts derived from this qmd collection.",
      },
      path: {
        type: "string",
        required: false,
        maxLength: 1000,
        description: "Filter to facts about this repo-relative file path.",
      },
      fact_type: {
        type: "enum",
        required: false,
        values: REPO_FACT_METADATA_CONTRACT.fact_type.values,
        description: "Filter to one fact category. Omit to return all types.",
      },
      subject: {
        type: "string",
        required: false,
        maxLength: 500,
        description: "Filter to facts whose subject/symbol matches this value.",
      },
      limit: {
        type: "integer",
        required: false,
        min: 1,
        max: 250,
        description:
          "Maximum facts to return (1-250). Keep small for focused recall.",
      },
      offset: {
        type: "integer",
        required: false,
        min: 0,
        description:
          "Number of facts to skip, for paging. Leave at 0 for the first " +
          "page.",
      },
    },
    output_shape: "repo_fact ob_entities row array JSON text payload",
  },
};
