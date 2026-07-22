/**
 * Contract declaration for the TypeScript memory client.
 *
 * The contract id and schema hash are DERIVED from the server source of truth
 * (`src/contract.ts`) — never forked literals. `buildContract`'s schema hash is
 * timestamp-independent, so the live value equals the reviewed fixture value.
 */

import {
  buildContract,
  CONTRACT_SCHEMA_VERSION,
  CONTRACT_VERSION,
} from "../../../src/contract.ts";

export const CURRENT_CONTRACT_VERSION: string = CONTRACT_VERSION;
export const CURRENT_CONTRACT_SCHEMA_VERSION: number = CONTRACT_SCHEMA_VERSION;
export const CURRENT_CONTRACT_SCHEMA_HASH: string = buildContract(
  "1970-01-01T00:00:00.000Z",
).schema_hash;
export const CURRENT_CONTRACT_HEADER = `${CURRENT_CONTRACT_VERSION};schema_hash=${CURRENT_CONTRACT_SCHEMA_HASH}`;
export const COMPATIBLE_CONTRACT_VERSIONS: readonly string[] = [
  CURRENT_CONTRACT_VERSION,
];

export const EXPECTED_CONTRACT_SCOPE = "required_openbrain_memory_contract";

export const FIRST_CLASS_RUNTIME_TOOL_VERSIONS: Readonly<
  Record<string, number>
> = {
  session_start: 2,
  session_wrap: 2,
  agent_context_pack: 2,
  append_session_event: 8,
};
export const FIRST_CLASS_RUNTIME_TOOLS: readonly string[] = Object.keys(
  FIRST_CLASS_RUNTIME_TOOL_VERSIONS,
);

export interface ContractValidationResult {
  ok: boolean;
  reasons: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capabilityToolVersions(value: unknown): Map<string, unknown> {
  const versions = new Map<string, unknown>();
  if (!Array.isArray(value)) {
    return versions;
  }
  for (const capability of value) {
    if (
      isRecord(capability) &&
      capability["kind"] === "tool" &&
      typeof capability["name"] === "string"
    ) {
      versions.set(capability["name"], capability["version"]);
    }
  }
  return versions;
}

/**
 * Validate a live Open Brain contract manifest without network access.
 *
 * Mirrors the Python `validate_contract_manifest` for the first-class runtime
 * gate: contract scope, compatible contract id, schema version/hash, and
 * required tool capabilities/contracts. Client-version range validation is
 * intentionally absent: the server manifest does not yet declare a
 * TypeScript-client entry, and validating an absent entry would fail closed
 * against every live server (runtime-specific difference, see README).
 *
 * Reasons are content-free: field names only, never manifest values.
 */
export function validateContractManifest(
  manifest: unknown,
  options: {
    requiredTools?: readonly string[];
    requiredToolVersions?: Readonly<Record<string, number>>;
    compatibleContractVersions?: readonly string[];
    expectedSchemaVersion?: number;
    expectedSchemaHash?: string;
    expectedScope?: string;
  } = {},
): ContractValidationResult {
  const reasons: string[] = [];
  if (!isRecord(manifest)) {
    return { ok: false, reasons: ["contract manifest must be an object"] };
  }
  const expectedScope = options.expectedScope ?? EXPECTED_CONTRACT_SCOPE;
  if (manifest["contract_scope"] !== expectedScope) {
    reasons.push("contract_scope mismatch");
  }

  const contractVersion = manifest["contract_version"];
  if (typeof contractVersion !== "string" || !contractVersion) {
    reasons.push("contract_version is missing or not a non-empty string");
  } else if (
    options.compatibleContractVersions !== undefined &&
    options.compatibleContractVersions.length > 0 &&
    !options.compatibleContractVersions.includes(contractVersion)
  ) {
    reasons.push("contract_version is not compatible");
  }

  if (options.expectedSchemaVersion !== undefined) {
    const version = manifest["schema_version"];
    if (typeof version !== "number" || !Number.isInteger(version)) {
      reasons.push("schema_version is missing or not an integer");
    } else if (version !== options.expectedSchemaVersion) {
      reasons.push("schema_version mismatch");
    }
  }
  if (options.expectedSchemaHash !== undefined) {
    const schemaHash = manifest["schema_hash"];
    if (typeof schemaHash !== "string" || !schemaHash) {
      reasons.push("schema_hash is missing or not a non-empty string");
    } else if (schemaHash !== options.expectedSchemaHash) {
      reasons.push("schema_hash mismatch");
    }
  }

  const requiredTools = options.requiredTools ?? [];
  if (requiredTools.length > 0) {
    const requiredVersions = options.requiredToolVersions ?? {};
    const capabilityVersions = capabilityToolVersions(manifest["capabilities"]);
    const missingCapabilities = requiredTools
      .filter((tool) => !capabilityVersions.has(tool))
      .sort();
    if (missingCapabilities.length > 0) {
      reasons.push(
        "required tool(s) missing from contract capabilities: " +
          missingCapabilities.join(", "),
      );
    }
    for (const [tool, minimum] of Object.entries(requiredVersions)) {
      if (!capabilityVersions.has(tool)) {
        continue;
      }
      const version = capabilityVersions.get(tool);
      if (
        typeof version !== "number" ||
        !Number.isInteger(version) ||
        version < minimum
      ) {
        reasons.push(`capability '${tool}'.version must be >= ${minimum}`);
      }
    }

    const toolContracts = manifest["tool_contracts"];
    if (!isRecord(toolContracts)) {
      reasons.push("tool_contracts is missing or not an object");
    } else {
      const missingContracts = requiredTools
        .filter((tool) => !(tool in toolContracts))
        .sort();
      if (missingContracts.length > 0) {
        reasons.push(
          "required tool(s) missing from tool_contracts: " +
            missingContracts.join(", "),
        );
      }
      for (const tool of requiredTools) {
        const entry = toolContracts[tool];
        if (entry === undefined) {
          continue;
        }
        if (!isRecord(entry)) {
          reasons.push(`tool_contracts['${tool}'] must be an object`);
          continue;
        }
        const version = entry["version"];
        if (version === undefined || version === null || version === "") {
          reasons.push(`tool_contracts['${tool}'].version is missing or empty`);
        } else {
          const minimum = requiredVersions[tool];
          if (
            minimum !== undefined &&
            (typeof version !== "number" ||
              !Number.isInteger(version) ||
              version < minimum)
          ) {
            reasons.push(
              `tool_contracts['${tool}'].version must be >= ${minimum}`,
            );
          }
        }
        if (!isRecord(entry["input_schema"])) {
          reasons.push(
            `tool_contracts['${tool}'].input_schema must be an object`,
          );
        }
        const outputShape = entry["output_shape"];
        const outputSchema = entry["output_schema"];
        if (
          !(typeof outputShape === "string" && outputShape.trim().length > 0) &&
          !isRecord(outputSchema)
        ) {
          reasons.push(
            `tool_contracts['${tool}'] must define a non-empty output_shape ` +
              "or output_schema object",
          );
        }
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/** Validate the first-class runtime's required memory contract. */
export function validateFirstClassContract(
  manifest: unknown,
): ContractValidationResult {
  return validateContractManifest(manifest, {
    requiredTools: FIRST_CLASS_RUNTIME_TOOLS,
    requiredToolVersions: FIRST_CLASS_RUNTIME_TOOL_VERSIONS,
    compatibleContractVersions: COMPATIBLE_CONTRACT_VERSIONS,
    expectedSchemaVersion: CURRENT_CONTRACT_SCHEMA_VERSION,
    expectedSchemaHash: CURRENT_CONTRACT_SCHEMA_HASH,
  });
}
