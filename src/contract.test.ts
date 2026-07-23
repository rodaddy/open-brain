import { describe, expect, it } from "bun:test";
import type { OpenBrainContract } from "./contract.ts";
import { buildContract, contractHash } from "./contract.ts";

type ContractPayload = Omit<OpenBrainContract, "generated_at" | "schema_hash">;

describe("Open Brain contract manifest", () => {
  it("builds a manifest with required compatibility fields", () => {
    const contract = buildContract("2026-06-18T00:00:00.000Z");

    expect(contract.service).toBe("open-brain");
    expect(contract.contract_version).toContain("memory-tools");
    expect(contract.contract_scope).toBe("required_openbrain_memory_contract");
    expect(contract.schema_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(contract.schema_hash).toBe(
      "e60ea54f0797548b69722adc205377f100b685721fc69aa9b3a045ffb05bea82",
    );
    expect(contract.min_client_versions.mcp2cli).toBe("0.3.6");
    expect(contract.min_client_versions["openbrain-memory"]).toBe("0.1.15");
    expect(contract.compatible_client_ranges["openbrain-memory"]).toBe(
      ">=0.1.15 <1.0.0",
    );
    expect(contract.transport.namespace_boundary).toBe("authorization");
    expect(contract.realtime_transport.nats_jetstream).toMatchObject({
      status: "planned-transport-foundation",
      availability: "not_runtime_available",
      parent_issue: 223,
      contract_doc: "docs/nats-jetstream-foundation.md",
      fallback_transport: "http_mcp",
      auth_boundary: "openbrain_server_authority",
      runtime_default: "http_mcp",
    });
    expect(
      contract.realtime_transport.nats_jetstream.request_reply_subjects,
    ).toEqual({
      available: [],
      planned: [
        "{env}.ob.memory.session_start",
        "{env}.ob.memory.append_event",
        "{env}.ob.memory.wrap",
        "{env}.ob.memory.resolve",
        "{env}.ob.health",
      ],
    });
    expect(
      contract.realtime_transport.nats_jetstream.jetstream_streams,
    ).toEqual([
      "OB_AGENT_TRACE",
      "OB_CONTEXT_PACK_REQUESTS",
      "OB_CONTEXT_PACK_AUDIT",
      "OB_PROMOTION_CANDIDATES",
    ]);
    expect(contract.realtime_transport.nats_jetstream.server).toMatchObject({
      planned_host: "core01",
      client_listen: "127.0.0.1:4222",
      monitoring_listen: "127.0.0.1:8222",
      jetstream_store_dir: "/Volumes/ThunderBolt/open-brain/nats/jetstream",
    });
    expect(contract.interchange_profiles.okf.status).toBe(
      "compatibility-hooks",
    );
    expect(contract.interchange_profiles.okf.metadata_path).toBe(
      "metadata.okf",
    );
    expect(contract.interchange_profiles.okf.reserved_files).toEqual([
      "index.md",
      "log.md",
    ]);
    expect(contract.interchange_profiles.okf.required_frontmatter).toEqual([
      "type",
    ]);
    expect(contract.interchange_profiles.okf.export_surfaces).toEqual([
      "concept",
      "index",
      "log",
      "citations",
      "receipts",
    ]);
    expect(contract.agent_memory_adapter.status).toBe("draft-local-contract");
    expect(contract.agent_memory_adapter.contract_doc).toBe(
      "docs/agent-memory-adapter-contract.md",
    );
    expect(contract.agent_memory_adapter.server_authority).toEqual([
      "auth",
      "namespace",
      "storage",
      "promotion_policy",
      "contract_discovery",
    ]);
    expect(contract.agent_memory_adapter.client_authority).toContain(
      "receipt_assembly",
    );
    expect(Object.keys(contract.agent_memory_adapter.methods).sort()).toEqual([
      "append_event",
      "candidate_memory",
      "compact",
      "discard_candidate",
      "export_disclosure_bundle",
      "nominate_shared",
      "promote_candidate",
      "recall",
      "record_receipt",
      "relegate_candidate",
      "start",
      "wrap",
    ]);
    const adapterMethods = contract.agent_memory_adapter.methods;
    expect(adapterMethods.start!.maps_to).toEqual([
      "session_start",
      "lane_upsert",
    ]);
    expect(adapterMethods.compact!.owner).toBe("client");
    expect(adapterMethods.record_receipt!.maps_to).toEqual([
      "append_session_event:event_type=receipt",
    ]);
    expect(adapterMethods.nominate_shared!.maps_to).toEqual([
      "append_session_event:metadata.share_candidate",
      "append_session_event:metadata.memory_lifecycle_action=nominate_shared",
    ]);
    expect(adapterMethods.candidate_memory).toEqual({
      maps_to: [
        "append_session_event:metadata.memory_lifecycle_action=candidate",
      ],
      owner: "client",
      status: "client-wrapper",
    });
    expect(adapterMethods.promote_candidate).toEqual({
      maps_to: [
        "append_session_event:metadata.memory_lifecycle_action=promote",
      ],
      owner: "client",
      status: "client-wrapper",
    });
    expect(adapterMethods.export_disclosure_bundle).toEqual({
      maps_to: ["interchange_profiles.okf"],
      owner: "client",
      status: "client-wrapper",
    });
    expect(contract.agent_context_pack).toMatchObject({
      status: "runtime-available",
      availability: "mcp_tool_available",
      contract_doc: "docs/agent-context-pack-contract.md",
      parent_issue: 220,
      exact_scope_required: true,
    });
    expect(contract.agent_context_pack.scope_keys).toEqual([
      "namespace",
      "agent",
      "platform",
      "server_id",
      "channel_id",
      "thread_id",
      "session_key",
    ]);
    expect(contract.agent_context_pack.sections).toEqual([
      "working_set",
      "recovery",
      "durable_lane_context",
      "durable_memory",
      "profile_guidance",
      "process_guidance",
      "repo_facts",
      "pointers",
      "candidate_memory",
    ]);
    // candidate_memory carries the candidate-only / not-a-durable-write label,
    // so it must appear in the machine-readable section enumeration.
    expect(contract.agent_context_pack.sections).toContain("candidate_memory");
    // Envelope fields are top-level response keys, not section members; keep
    // them distinct so requested_sections stays a true subset of sections.
    expect(contract.agent_context_pack.envelope_fields).toEqual([
      "warnings",
      "budget",
      "citations",
    ]);
    expect(contract.agent_context_pack.warning_fields).toContain(
      "scope_denials",
    );
    expect(contract.agent_context_pack.working_set).toEqual({
      status: "local-runtime-boundary",
      parent_issue: 222,
      implementation: "src/realtime/working-set.ts",
      storage: "ram_first_in_process",
      availability: "mcp_tool_available",
      item_label: "working_context",
      not_durable_memory: true,
      exact_scope_required: true,
      budget_defaults: {
        ttl_ms: 1800000,
        max_sessions: 128,
        max_items_per_session: 24,
        max_global_items: 1024,
        max_item_chars: 4000,
        max_metadata_chars: 2000,
      },
      counters: ["dropped", "expired", "trimmed"],
    });
    expect(contract.agent_context_pack.recovery).toEqual({
      status: "local-quarantine-boundary",
      parent_issue: 221,
      implementation: "src/realtime/recovery-wal.ts",
      storage: "env_configured_file_wal_with_in_memory_fallback",
      availability: "mcp_tool_available",
      item_label: "quarantined_recovery",
      not_durable_memory: true,
      not_searchable_recall: true,
      exact_scope_required: true,
      explicit_include_required: true,
      statuses: [
        "active",
        "wrapped",
        "recovery_pending",
        "reviewed",
        "compacted",
        "discarded",
        "expired",
      ],
      actions: [
        "review",
        "use_for_current_session",
        "compact_to_wrap",
        "promote_candidates",
        "discard",
        "defer",
      ],
      budget_defaults: {
        ttl_ms: 86400000,
        max_sessions: 128,
        max_items_per_session: 50,
        max_global_items: 2048,
        max_content_chars: 8000,
        max_metadata_chars: 2000,
        max_preview_chars: 1000,
      },
      counters: ["dropped", "expired", "trimmed", "marked", "purged"],
    });
    expect(contract.agent_context_pack.durable_lane_context).toEqual({
      status: "runtime-available",
      implementation: "src/tools/agent-context-pack.ts",
      storage: "ob_session_lanes_and_events",
      availability: "mcp_tool_available",
      item_label: "durable_memory",
      exact_scope_required: true,
      explicit_include_required: true,
      scope_mismatch_behavior: "generic_scope_denial",
      budget_defaults: {
        max_content_chars: 12000,
        max_context_chars: 6000,
        max_events: 8,
        max_event_chars: 1000,
      },
    });
    expect(contract.receipt_contract).toMatchObject({
      status: "lightweight-openbrain-receipts",
      event_type: "receipt",
      contract_doc: "docs/agent-memory-adapter-contract.md",
      secret_safe: true,
    });
    expect(contract.receipt_contract.required_fields).toEqual([
      "schema",
      "action",
      "agent",
      "session_key",
      "timestamp",
      "sources",
      "outputs",
      "validations",
    ]);
    expect(contract.receipt_contract.recommended_fields).toContain(
      "residual_risk",
    );
    expect(contract.receipt_contract.closed_brain_strict_fields).toEqual([
      "preimage_hashes",
      "postimage_hashes",
      "base_document_hashes",
      "tool_call_ids",
      "approval_chain",
      "redaction_policy",
    ]);
    expect(contract.promotion_lifecycle).toMatchObject({
      status: "explicit-client-owned-lifecycle",
      parent_issue: 224,
      contract_doc: "docs/agent-memory-adapter-contract.md",
      candidate_presence_effect: "no_durable_write_no_shared_write",
    });
    expect(contract.promotion_lifecycle.candidate_types).toContain(
      "negative_example",
    );
    expect(contract.promotion_lifecycle.actions).toEqual([
      "candidate",
      "promote",
      "relegate",
      "discard",
      "nominate_shared",
    ]);
    expect(contract.promotion_lifecycle.shared_nomination_requires).toContain(
      "memory_lifecycle_action_nominate_shared",
    );
    expect(contract.capabilities.map((c) => c.name)).toContain(
      "upsert_repo_fact",
    );
    expect(contract.capabilities.map((c) => c.name)).toContain(
      "agent_memory_adapter",
    );
    expect(contract.capabilities.map((c) => c.name)).toContain(
      "agent_context_pack",
    );
    // The new public reflex tool must be discoverable/compatibility-gateable via
    // the curated manifest, not only via tools/list.
    expect(contract.capabilities.map((c) => c.name)).toContain(
      "agent_reflex_pointers",
    );
    expect(
      contract.capabilities.find(
        (item) => item.name === "agent_reflex_pointers",
      ),
    ).toMatchObject({ version: 1, kind: "tool" });
    expect(contract.capabilities.map((c) => c.name)).toContain(
      "receipt_contract",
    );
    expect(contract.capabilities.map((c) => c.name)).toContain(
      "memory_promotion_lifecycle",
    );
    expect(
      contract.capabilities.find((item) => item.name === "agent_context_pack")
        ?.version,
    ).toBe(2);
    expect(
      contract.capabilities.find((item) => item.name === "append_session_event")
        ?.version,
    ).toBe(8);
    for (const tool of [
      "get_contract",
      "get_entry",
      "resolve_entry",
      "log_thought",
      "search_all",
      "session_start",
      "session_context",
      "lane_upsert",
      "lane_load",
      "append_session_event",
      "session_wrap",
      "working_set_append",
      "recovery_wal_append",
      "recovery_wal_mark",
      "agent_context_pack",
      "list_repo_facts",
      "upsert_repo_fact",
    ]) {
      expect(contract.tool_contracts[tool]).toBeDefined();
    }
    const workingSetAppend = contract.tool_contracts.working_set_append;
    const recoveryWalAppend = contract.tool_contracts.recovery_wal_append;
    const recoveryWalMark = contract.tool_contracts.recovery_wal_mark;
    const agentContextPack = contract.tool_contracts.agent_context_pack;
    expect(workingSetAppend).toBeDefined();
    expect(recoveryWalAppend).toBeDefined();
    expect(recoveryWalMark).toBeDefined();
    expect(agentContextPack).toBeDefined();
    expect(workingSetAppend?.output_shape).toContain("RAM-only");
    expect(agentContextPack?.version).toBe(2);
    expect(agentContextPack?.output_shape).toContain("durable_lane_context");
    expect(agentContextPack?.output_shape).toContain("exact-scope denials");
    expect(recoveryWalAppend?.output_shape).toContain("not_searchable_recall");
    expect(recoveryWalMark?.output_shape).toContain("not_searchable_recall");
    expect((workingSetAppend?.input_schema as any).durable_ref).toEqual({
      type: "object",
      required: false,
      fields: {
        table: { type: "string", required: true, minLength: 1, maxLength: 100 },
        id: { type: "string", required: true, minLength: 1, maxLength: 200 },
      },
    });
    expect((workingSetAppend?.input_schema as any).metadata).toMatchObject({
      type: "object",
      required: false,
      maxSerializedChars: 2000,
    });
    expect((agentContextPack?.input_schema as any).budget).toEqual({
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
    });
    const upsertRepoFact = contract.tool_contracts.upsert_repo_fact;
    expect(upsertRepoFact).toBeDefined();
    const getEntry = contract.tool_contracts.get_entry;
    expect(getEntry).toBeDefined();
    expect(getEntry?.version).toBe(2);
    expect((getEntry?.input_schema as any).table).toEqual({
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
    });
    expect((getEntry?.input_schema as any).id.type).toBe("string");
    expect((getEntry?.input_schema as any).id.required).toBe(true);
    expect((getEntry?.input_schema as any).id.format).toBe("uuid");
    expect((getEntry?.input_schema as any).render).toMatchObject({
      type: "enum",
      required: false,
      values: ["full", "compact"],
      default: "full",
    });
    expect((getEntry?.input_schema as any).max_chars).toMatchObject({
      type: "integer",
      required: false,
      min: 80,
      max: 2000,
      default: 500,
    });
    expect((getEntry?.input_schema as any).source_scope.fields).toMatchObject({
      client_id: {
        type: "string",
        required: false,
        minLength: 1,
        maxLength: 300,
      },
      matter_id: {
        type: "string",
        required: false,
        minLength: 1,
        maxLength: 300,
      },
      document_id: {
        type: "string",
        required: false,
        minLength: 1,
        maxLength: 500,
      },
      path: { type: "string", required: false, minLength: 1, maxLength: 1000 },
      dms_id: { type: "string", required: false, minLength: 1, maxLength: 500 },
    });
    expect(getEntry?.output_shape).toContain("compact envelope");
    expect(getEntry?.output_shape).toContain("source_refs redacted");
    expect(getEntry?.output_shape).toContain(
      "compact source_scope filters visibility only",
    );
    expect((getEntry?.input_schema as any).namespace).toBeUndefined();
    const logThought = contract.tool_contracts.log_thought;
    expect((logThought?.input_schema as any).source_refs).toMatchObject({
      type: "array",
      required: false,
      maxItems: 25,
    });
    expect(logThought?.output_shape).toContain("source_refs");
    const decomposeEntry = contract.tool_contracts.decompose_entry;
    expect(decomposeEntry).toBeDefined();
    expect(decomposeEntry?.version).toBe(1);
    expect((decomposeEntry?.input_schema as any).dry_run).toMatchObject({
      type: "boolean",
      required: false,
      default: true,
    });
    expect((decomposeEntry?.input_schema as any).apply_mode).toMatchObject({
      type: "enum",
      required: false,
      values: ["write_replacements"],
    });
    expect(decomposeEntry?.output_shape).toContain(
      "without source-row mutation",
    );
    const resolveEntry = contract.tool_contracts.resolve_entry;
    expect(resolveEntry).toBeDefined();
    expect(resolveEntry?.version).toBe(1);
    expect((resolveEntry?.input_schema as any).id.type).toBe("string");
    expect((resolveEntry?.input_schema as any).id.required).toBe(true);
    expect((resolveEntry?.input_schema as any).id.format).toBe("uuid");
    expect((resolveEntry?.input_schema as any).namespace.type).toBe("string");
    expect((resolveEntry?.input_schema as any).namespace.required).toBe(false);
    expect(resolveEntry?.output_shape).toContain("fetch_path");
    const searchAll = contract.tool_contracts.search_all;
    expect(searchAll).toBeDefined();
    expect((searchAll?.input_schema as any).namespace.type).toBe("string");
    expect((searchAll?.input_schema as any).limit.max).toBe(250);
    expect((searchAll?.input_schema as any).offset.min).toBe(0);
    expect((searchAll?.input_schema as any).sources.values).toEqual([
      "all",
      "brain",
      "qmd",
    ]);
    expect((searchAll?.input_schema as any).search_mode.values).toEqual([
      "hybrid",
      "vector",
      "keyword",
    ]);
    expect((searchAll?.input_schema as any).tier.values).toEqual([
      "hot",
      "warm",
      "cold",
    ]);
    expect(
      (searchAll?.input_schema as any).source_scope.fields.path,
    ).toMatchObject({
      type: "string",
      required: false,
      minLength: 1,
      maxLength: 1000,
    });
    expect(searchAll?.output_shape).toContain("suppresses qmd");
    const laneUpsert = contract.tool_contracts.lane_upsert;
    expect(laneUpsert).toBeDefined();
    expect((laneUpsert?.input_schema as any).current_context_md.maxLength).toBe(
      100000,
    );
    expect(
      (laneUpsert?.input_schema as any).metadata.propertyNames.maxLength,
    ).toBe(100);
    const laneLoad = contract.tool_contracts.lane_load;
    expect(laneLoad).toBeDefined();
    expect((laneLoad?.input_schema as any).status.default).toBe("active");
    expect((laneLoad?.input_schema as any).limit.max).toBe(50);
    expect(
      (upsertRepoFact?.input_schema as any).metadata.source_url.required,
    ).toBe(true);
    expect(
      (upsertRepoFact?.input_schema as any).validation.source_url.repo_match,
    ).toContain("metadata.repo");
    const sessionWrap = contract.tool_contracts.session_wrap;
    expect((sessionWrap?.input_schema as any).source_refs).toMatchObject({
      type: "array",
      required: false,
      maxItems: 25,
    });
    expect(sessionWrap?.output_shape).toContain("source_refs");
    expect(sessionWrap?.output_shape).toContain(
      "duplicate content_hash checkpoints do not merge later source_refs",
    );
    expect(sessionWrap?.output_shape).toContain(
      "still materialize the scoped lane summary",
    );
  });

  it("pins the contract version and append_session_event nomination contract", () => {
    // The Python client pins CURRENT_CONTRACT_VERSION and cross-checks it
    // against this source, but nothing on the TS side caught a forgotten bump.
    // Pin the version string and the append_session_event nomination/provenance
    // contract so a future TS/Python divergence fails here, in lockstep with
    // python/openbrain-memory CURRENT_CONTRACT_VERSION.
    const contract = buildContract("2026-06-18T00:00:00.000Z");
    expect(contract.contract_version).toBe("2026-07-23.memory-tools.v23");

    const appendEvent = contract.tool_contracts.append_session_event;
    expect(appendEvent).toBeDefined();
    expect(appendEvent?.version).toBe(8);
    expect(appendEvent?.output_shape).toContain("writer_identity");
    expect(appendEvent?.output_shape).toContain("token_identity");
    expect(appendEvent?.output_shape).toContain("delegated_agent_id");
    expect(appendEvent?.output_shape).toContain("namespace_source");
    expect(appendEvent?.output_shape).toContain("lane_created");
    expect(appendEvent?.output_shape).toContain("retryable_outage");
    expect(appendEvent?.output_shape).toContain("reject_detail");
    expect(appendEvent?.output_shape).toContain("matched_kind");
    expect(appendEvent?.output_shape).toContain("resubmit_metadata");
    const appendInput = appendEvent?.input_schema as any;
    expect(appendInput.create_if_missing.type).toBe("boolean");
    expect(appendInput.create_if_missing.description).toContain(
      "first-write realtime agent scopes",
    );
    expect(appendInput.agent.description).toContain("atomically attached");
    expect(appendInput.platform.description).toContain("atomically attached");
    expect(appendInput.server_id.description).toContain("atomically attached");
    expect(appendInput.channel_id.description).toContain("atomically attached");
    expect(appendInput.thread_id.description).toContain("atomically");
    expect(appendEvent?.output_shape).toContain("legacy lane");
    expect(appendEvent?.output_shape).toContain("asserted scope conflict");
    const shareCandidate = (appendEvent?.input_schema as any).metadata.fields
      .share_candidate;
    expect(shareCandidate.type).toBe("boolean");
    const lifecycleAction = (appendEvent?.input_schema as any).metadata.fields
      .memory_lifecycle_action;
    expect(lifecycleAction.values).toEqual([
      "candidate",
      "promote",
      "relegate",
      "discard",
      "nominate_shared",
    ]);
    expect(lifecycleAction.description).toContain(
      "only action eligible for the shared-kb promoter",
    );
    const candidateType = (appendEvent?.input_schema as any).metadata.fields
      .candidate_type;
    expect(candidateType.values).toContain("negative_example");
    expect(
      (appendEvent?.input_schema as any).metadata.fields.candidate_confidence,
    ).toMatchObject({ type: "number", min: 0, max: 1 });
    expect(
      (appendEvent?.input_schema as any).metadata.fields.evidence_refs,
    ).toMatchObject({ type: "array", maxItems: 20 });
    // The help must document explicit nomination and sync rejection so a
    // contract-driven agent learns the behavior, not just the type.
    expect(shareCandidate.description).toContain("share_candidate_rejected");
    expect(shareCandidate.description).toContain(
      "memory_lifecycle_action=nominate_shared",
    );
    expect(shareCandidate.description.toLowerCase()).toContain("secret");
    expect(appendInput.metadata.fields.sanitized_resubmit_of.type).toBe(
      "string",
    );
    expect(
      appendInput.metadata.fields.sanitized_resubmit_of.description,
    ).toContain("reject_detail.resubmit_metadata");
    expect(appendInput.metadata.fields.sanitized_resubmit_attempt.type).toBe(
      "integer",
    );
    expect(appendInput.metadata.fields.sanitized_resubmit_attempt.max).toBe(2);
    const okf = (appendEvent?.input_schema as any).metadata.fields.okf;
    expect(okf.type).toBe("object");
    expect(okf.description).toContain("edge export/import");
    expect(okf.description).toContain("Unknown keys should be preserved");
  });

  it("keeps the schema hash stable when only generated_at changes", () => {
    const first = buildContract("2026-06-18T00:00:00.000Z");
    const second = buildContract("2026-06-18T01:00:00.000Z");

    expect(first.generated_at).not.toBe(second.generated_at);
    expect(first.schema_hash).toBe(second.schema_hash);
  });

  it("keeps planned realtime metadata outside the required schema hash", () => {
    const base = buildContract("2026-06-18T00:00:00.000Z");
    const changedPayload: ContractPayload = {
      service: base.service,
      contract_version: base.contract_version,
      contract_scope: base.contract_scope,
      schema_version: base.schema_version,
      min_client_versions: base.min_client_versions,
      compatible_client_ranges: base.compatible_client_ranges,
      transport: base.transport,
      realtime_transport: {
        nats_jetstream: {
          ...base.realtime_transport.nats_jetstream,
          request_reply_subjects: {
            ...base.realtime_transport.nats_jetstream.request_reply_subjects,
            planned: [
              ...base.realtime_transport.nats_jetstream.request_reply_subjects
                .planned,
              "ob.memory.experimental",
            ],
          } as unknown as typeof base.realtime_transport.nats_jetstream.request_reply_subjects,
        },
      },
      interchange_profiles: base.interchange_profiles,
      agent_memory_adapter: base.agent_memory_adapter,
      agent_context_pack: base.agent_context_pack,
      receipt_contract: base.receipt_contract,
      promotion_lifecycle: base.promotion_lifecycle,
      capabilities: base.capabilities,
      tool_contracts: base.tool_contracts,
    };

    expect(contractHash(changedPayload)).toBe(base.schema_hash);
  });

  it("can advertise NATS runtime availability without changing the required schema hash", () => {
    const base = buildContract("2026-06-18T00:00:00.000Z");
    const available = buildContract("2026-06-18T00:00:00.000Z", {
      natsAvailability: "available",
    });

    expect(available.realtime_transport.nats_jetstream).toMatchObject({
      status: "runtime-available",
      availability: "available",
      request_reply_subjects: {
        available: ["{env}.ob.memory.context_pack"],
        planned: [
          "{env}.ob.memory.session_start",
          "{env}.ob.memory.append_event",
          "{env}.ob.memory.wrap",
          "{env}.ob.memory.resolve",
          "{env}.ob.health",
        ],
      },
    });
    expect(available.schema_hash).toBe(base.schema_hash);
  });

  it("changes the schema hash when public capabilities change", () => {
    const base = buildContract("2026-06-18T00:00:00.000Z");
    const changedPayload: ContractPayload = {
      service: base.service,
      contract_version: base.contract_version,
      contract_scope: base.contract_scope,
      schema_version: base.schema_version,
      min_client_versions: base.min_client_versions,
      compatible_client_ranges: base.compatible_client_ranges,
      transport: base.transport,
      realtime_transport: base.realtime_transport,
      interchange_profiles: base.interchange_profiles,
      agent_memory_adapter: base.agent_memory_adapter,
      agent_context_pack: base.agent_context_pack,
      receipt_contract: base.receipt_contract,
      promotion_lifecycle: base.promotion_lifecycle,
      capabilities: [
        ...base.capabilities,
        {
          name: "example_new_public_tool",
          version: 1,
          kind: "tool" as const,
          description: "Fixture capability used to prove hash drift.",
        },
      ],
      tool_contracts: base.tool_contracts,
    };

    expect(contractHash(changedPayload)).not.toBe(base.schema_hash);
  });

  it("changes the schema hash when repo fact metadata contract changes", () => {
    const base = buildContract("2026-06-18T00:00:00.000Z");
    const upsertRepoFact = base.tool_contracts.upsert_repo_fact;
    expect(upsertRepoFact).toBeDefined();

    const changedPayload: ContractPayload = {
      service: base.service,
      contract_version: base.contract_version,
      contract_scope: base.contract_scope,
      schema_version: base.schema_version,
      min_client_versions: base.min_client_versions,
      compatible_client_ranges: base.compatible_client_ranges,
      transport: base.transport,
      realtime_transport: base.realtime_transport,
      interchange_profiles: base.interchange_profiles,
      agent_memory_adapter: base.agent_memory_adapter,
      agent_context_pack: base.agent_context_pack,
      receipt_contract: base.receipt_contract,
      promotion_lifecycle: base.promotion_lifecycle,
      capabilities: base.capabilities,
      tool_contracts: {
        ...base.tool_contracts,
        upsert_repo_fact: {
          ...upsertRepoFact!,
          input_schema: {
            ...(upsertRepoFact!.input_schema as any),
            metadata: {
              ...((upsertRepoFact!.input_schema as any).metadata as any),
              fact: { type: "string", required: true, maxLength: 1000 },
            },
          },
        },
      },
    };

    expect(contractHash(changedPayload)).not.toBe(base.schema_hash);
  });

  it("changes the schema hash when repo fact validation semantics change", () => {
    const base = buildContract("2026-06-18T00:00:00.000Z");
    const upsertRepoFact = base.tool_contracts.upsert_repo_fact;
    expect(upsertRepoFact).toBeDefined();

    const changedPayload: ContractPayload = {
      service: base.service,
      contract_version: base.contract_version,
      contract_scope: base.contract_scope,
      schema_version: base.schema_version,
      min_client_versions: base.min_client_versions,
      compatible_client_ranges: base.compatible_client_ranges,
      transport: base.transport,
      realtime_transport: base.realtime_transport,
      interchange_profiles: base.interchange_profiles,
      agent_memory_adapter: base.agent_memory_adapter,
      agent_context_pack: base.agent_context_pack,
      receipt_contract: base.receipt_contract,
      promotion_lifecycle: base.promotion_lifecycle,
      capabilities: base.capabilities,
      tool_contracts: {
        ...base.tool_contracts,
        upsert_repo_fact: {
          ...upsertRepoFact!,
          input_schema: {
            ...(upsertRepoFact!.input_schema as any),
            validation: {
              ...((upsertRepoFact!.input_schema as any).validation as any),
              fact_body: {
                ...((upsertRepoFact!.input_schema as any).validation as any)
                  .fact_body,
                max_lines: 20,
              },
            },
          },
        },
      },
    };

    expect(contractHash(changedPayload)).not.toBe(base.schema_hash);
  });
});
