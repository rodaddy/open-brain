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
    expect(contract.min_client_versions.mcp2cli).toBe("0.3.6");
    expect(contract.transport.namespace_boundary).toBe("authorization");
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
      "compact",
      "export_disclosure_bundle",
      "nominate_shared",
      "recall",
      "record_receipt",
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
    ]);
    expect(adapterMethods.export_disclosure_bundle).toEqual({
      maps_to: ["interchange_profiles.okf"],
      owner: "client",
      status: "client-wrapper",
    });
    expect(contract.agent_context_pack).toMatchObject({
      status: "planned-contract",
      availability: "not_runtime_available",
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
    expect(contract.capabilities.map((c) => c.name)).toContain(
      "upsert_repo_fact",
    );
    expect(contract.capabilities.map((c) => c.name)).toContain(
      "agent_memory_adapter",
    );
    expect(contract.capabilities.map((c) => c.name)).toContain(
      "agent_context_pack",
    );
    expect(contract.capabilities.map((c) => c.name)).toContain(
      "receipt_contract",
    );
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
      "list_repo_facts",
      "upsert_repo_fact",
    ]) {
      expect(contract.tool_contracts[tool]).toBeDefined();
    }
    expect(contract.tool_contracts.agent_context_pack).toBeUndefined();
    const upsertRepoFact = contract.tool_contracts.upsert_repo_fact;
    expect(upsertRepoFact).toBeDefined();
    const getEntry = contract.tool_contracts.get_entry;
    expect(getEntry).toBeDefined();
    expect(getEntry?.version).toBe(1);
    expect((getEntry?.input_schema as any).table).toEqual({
      type: "enum",
      required: true,
      values: ["thoughts", "decisions", "relationships", "projects", "sessions"],
      description:
        "Readable table containing the target row. Use the plural table " +
        "name derived from search result source_type.",
    });
    expect((getEntry?.input_schema as any).id.type).toBe("string");
    expect((getEntry?.input_schema as any).id.required).toBe(true);
    expect((getEntry?.input_schema as any).id.format).toBe("uuid");
    expect((getEntry?.input_schema as any).namespace).toBeUndefined();
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
    const laneUpsert = contract.tool_contracts.lane_upsert;
    expect(laneUpsert).toBeDefined();
    expect((laneUpsert?.input_schema as any).current_context_md.maxLength).toBe(
      100000,
    );
    expect((laneUpsert?.input_schema as any).metadata.propertyNames.maxLength).toBe(
      100,
    );
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
  });

  it("pins the contract version and append_session_event nomination contract", () => {
    // The Python client pins CURRENT_CONTRACT_VERSION and cross-checks it
    // against this source, but nothing on the TS side caught a forgotten bump.
    // Pin the version string and the append_session_event nomination/provenance
    // contract so a future TS/Python divergence fails here, in lockstep with
    // python/openbrain-memory CURRENT_CONTRACT_VERSION.
    const contract = buildContract("2026-06-18T00:00:00.000Z");
    expect(contract.contract_version).toBe("2026-07-05.memory-tools.v12");

    const appendEvent = contract.tool_contracts.append_session_event;
    expect(appendEvent).toBeDefined();
    expect(appendEvent?.version).toBe(5);
    expect(appendEvent?.output_shape).toContain("writer_identity");
    expect(appendEvent?.output_shape).toContain("token_identity");
    expect(appendEvent?.output_shape).toContain("delegated_agent_id");
    expect(appendEvent?.output_shape).toContain("namespace_source");
    expect(appendEvent?.output_shape).toContain("lane_created");
    expect(appendEvent?.output_shape).toContain("retryable_outage");
    const appendInput = appendEvent?.input_schema as any;
    expect(appendInput.create_if_missing.type).toBe("boolean");
    expect(appendInput.create_if_missing.description).toContain(
      "first-write realtime agent scopes",
    );
    expect(appendInput.agent.description).toContain("validate against an existing lane");
    expect(appendInput.platform.description).toContain("Stored as the lane source");
    expect(appendInput.server_id.description).toContain("exact realtime scope");
    expect(appendInput.channel_id.description).toContain(
      "validate against an existing lane",
    );
    expect(appendInput.thread_id.description).toContain(
      "validate against an existing lane",
    );
    const shareCandidate = (appendEvent?.input_schema as any).metadata.fields
      .share_candidate;
    expect(shareCandidate.type).toBe("boolean");
    // The help must document the two-stage (sync reject / async promote) model
    // so a contract-driven agent learns the behavior, not just the type.
    expect(shareCandidate.description).toContain("share_candidate_rejected");
    expect(shareCandidate.description.toLowerCase()).toContain("secret");
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
      interchange_profiles: base.interchange_profiles,
      agent_memory_adapter: base.agent_memory_adapter,
      agent_context_pack: base.agent_context_pack,
      receipt_contract: base.receipt_contract,
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
      interchange_profiles: base.interchange_profiles,
      agent_memory_adapter: base.agent_memory_adapter,
      agent_context_pack: base.agent_context_pack,
      receipt_contract: base.receipt_contract,
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
      interchange_profiles: base.interchange_profiles,
      agent_memory_adapter: base.agent_memory_adapter,
      agent_context_pack: base.agent_context_pack,
      receipt_contract: base.receipt_contract,
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
