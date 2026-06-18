import { describe, expect, it } from "bun:test";
import { buildContract, contractHash } from "./contract.ts";

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
  });

  it("keeps the schema hash stable when only generated_at changes", () => {
    const first = buildContract("2026-06-18T00:00:00.000Z");
    const second = buildContract("2026-06-18T01:00:00.000Z");

    expect(first.generated_at).not.toBe(second.generated_at);
    expect(first.schema_hash).toBe(second.schema_hash);
  });

  it("changes the schema hash when public capabilities change", () => {
    const base = buildContract("2026-06-18T00:00:00.000Z");
    const changedPayload = {
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
    };

    expect(contractHash(changedPayload)).not.toBe(base.schema_hash);
  });
});
