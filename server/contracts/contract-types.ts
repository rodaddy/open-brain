/**
 * The declared shape of the Open Brain contract document.
 *
 * Split out of `contract.ts` (issue 864) so the module that builds and hashes
 * the contract stays within the file size rule. Types only; no behavior.
 */
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
      status: "planned-transport-foundation" | "runtime-available";
      availability: "available" | "not_runtime_available";
      parent_issue: 223;
      contract_doc: "docs/nats-jetstream-foundation.md";
      server: {
        planned_host: "production-host";
        client_listen: "127.0.0.1:4222";
        monitoring_listen: "127.0.0.1:8222";
        jetstream_store_dir: "/opt/open-brain/nats/jetstream";
      };
      // Subjects are env-prefixed via the fleet-bus builder convention
      // (src/nats-subjects.ts obContextPackSubject). The `{env}.` template below
      // is a documentation placeholder; the live subject substitutes the slugged
      // OPENBRAIN_NATS_ENV value (default "dev"), e.g. dev.ob.memory.context_pack.
      subject_convention: "env_prefixed_fleet_bus";
      request_reply_subjects: {
        available: readonly ["{env}.ob.memory.context_pack"] | readonly [];
        planned: readonly [
          "{env}.ob.memory.session_start",
          "{env}.ob.memory.append_event",
          "{env}.ob.memory.wrap",
          "{env}.ob.memory.resolve",
          "{env}.ob.health",
        ];
      };
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
    status: "runtime-available";
    availability: "mcp_tool_available";
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
      "recovery",
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
    working_set: {
      status: "local-runtime-boundary";
      parent_issue: 222;
      implementation: "src/realtime/working-set.ts";
      storage: "ram_first_in_process";
      availability: "mcp_tool_available";
      item_label: "working_context";
      not_durable_memory: true;
      exact_scope_required: true;
      budget_defaults: {
        ttl_ms: 1800000;
        max_sessions: 128;
        max_items_per_session: 24;
        max_global_items: 1024;
        max_item_chars: 4000;
        max_metadata_chars: 2000;
      };
      counters: readonly ["dropped", "expired", "trimmed"];
    };
    recovery: {
      status: "local-quarantine-boundary";
      parent_issue: 221;
      implementation: "src/realtime/recovery-wal.ts";
      storage: "env_configured_file_wal_with_in_memory_fallback";
      availability: "mcp_tool_available";
      item_label: "quarantined_recovery";
      not_durable_memory: true;
      not_searchable_recall: true;
      exact_scope_required: true;
      explicit_include_required: true;
      statuses: readonly [
        "active",
        "wrapped",
        "recovery_pending",
        "reviewed",
        "compacted",
        "discarded",
        "expired",
      ];
      actions: readonly [
        "review",
        "use_for_current_session",
        "compact_to_wrap",
        "promote_candidates",
        "discard",
        "defer",
      ];
      budget_defaults: {
        ttl_ms: 86400000;
        max_sessions: 128;
        max_items_per_session: 50;
        max_global_items: 2048;
        max_content_chars: 8000;
        max_metadata_chars: 2000;
        max_preview_chars: 1000;
      };
      counters: readonly ["dropped", "expired", "trimmed", "marked", "purged"];
    };
    durable_lane_context: {
      status: "runtime-available";
      implementation: "src/tools/agent-context-pack.ts";
      storage: "ob_session_lanes_and_events";
      availability: "mcp_tool_available";
      item_label: "durable_memory";
      exact_scope_required: true;
      explicit_include_required: true;
      scope_mismatch_behavior: "generic_scope_denial";
      budget_defaults: {
        max_content_chars: 12000;
        max_context_chars: 6000;
        max_events: 8;
        max_event_chars: 1000;
      };
    };
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
  promotion_lifecycle: {
    status: "explicit-client-owned-lifecycle";
    parent_issue: 224;
    contract_doc: "docs/agent-memory-adapter-contract.md";
    candidate_types: readonly [
      "user_preference",
      "process_rule",
      "channel_server_rule",
      "code_repo_fact",
      "positive_example",
      "negative_example",
      "durable_decision",
      "shared_kb_nomination",
    ];
    actions: readonly [
      "candidate",
      "promote",
      "relegate",
      "discard",
      "nominate_shared",
    ];
    candidate_presence_effect: "no_durable_write_no_shared_write";
    shared_nomination_requires: readonly [
      "explicit_client_action",
      "share_candidate_true",
      "memory_lifecycle_action_nominate_shared",
      "server_auth_scope_safety_provenance_secret_checks",
    ];
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
