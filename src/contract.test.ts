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
    expect(contract.capabilities.map((c) => c.name)).toContain(
      "upsert_repo_fact",
    );
    for (const tool of [
      "get_contract",
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
    const upsertRepoFact = contract.tool_contracts.upsert_repo_fact;
    expect(upsertRepoFact).toBeDefined();
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
    // Pin the version string and the append_session_event v2 nomination
    // contract so a future TS/Python divergence fails here, in lockstep with
    // python/openbrain-memory CURRENT_CONTRACT_VERSION.
    const contract = buildContract("2026-06-18T00:00:00.000Z");
    expect(contract.contract_version).toBe("2026-06-19.memory-tools.v4");

    const appendEvent = contract.tool_contracts.append_session_event;
    expect(appendEvent).toBeDefined();
    expect(appendEvent?.version).toBe(2);
    const shareCandidate = (appendEvent?.input_schema as any).metadata.fields
      .share_candidate;
    expect(shareCandidate.type).toBe("boolean");
    // The help must document the two-stage (sync reject / async promote) model
    // so a contract-driven agent learns the behavior, not just the type.
    expect(shareCandidate.description).toContain("share_candidate_rejected");
    expect(shareCandidate.description.toLowerCase()).toContain("secret");
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
