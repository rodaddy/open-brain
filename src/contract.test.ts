import { describe, expect, it } from "bun:test";
import type { OpenBrainContract } from "./contract.ts";
import { buildContract, contractHash } from "./contract.ts";

type ContractPayload = Omit<OpenBrainContract, "generated_at" | "schema_hash">;

describe("Open Brain contract manifest", () => {
  it("builds a manifest with required compatibility fields", () => {
    const contract = buildContract("2026-06-18T00:00:00.000Z");

    expect(contract.service).toBe("open-brain");
    expect(contract.contract_version).toContain("repo-facts");
    expect(contract.schema_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(contract.min_client_versions.mcp2cli).toBe("0.3.6");
    expect(contract.transport.namespace_boundary).toBe("authorization");
    expect(contract.capabilities.map((c) => c.name)).toContain(
      "upsert_repo_fact",
    );
    const upsertRepoFact = contract.tool_contracts.upsert_repo_fact;
    expect(upsertRepoFact).toBeDefined();
    expect((upsertRepoFact?.input_schema as any).metadata.source_url.required).toBe(
      true,
    );
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
});
