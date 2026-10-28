/**
 * Contract declaration for the TypeScript memory client.
 *
 * The contract id and schema hash are DERIVED from the server source of truth
 * (`server/contracts/contract.ts`) — never forked literals. `buildContract`'s schema hash is
 * timestamp-independent, so the live value equals the reviewed fixture value.
 */

import {
  buildContract,
  CONTRACT_SCHEMA_VERSION,
  CONTRACT_VERSION,
} from "../../../server/contracts/contract.ts";

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

export const FIRST_CLASS_RUNTIME_TOOL_VERSIONS: Readonly<Record<string, number>> = {
  session_start: 2,
  session_wrap: 2,
  // v3 as of #678 (mirror reconciled with the live Zod schema).
  agent_context_pack: 3,
  append_session_event: 8,
};
export const FIRST_CLASS_RUNTIME_TOOLS: readonly string[] = Object.keys(
  FIRST_CLASS_RUNTIME_TOOL_VERSIONS,
);

export interface ContractValidationResult {
  ok: boolean;
  reasons: readonly string[];
}

/** Options accepted by {@link validateContractManifest}. */
export interface ContractValidationOptions {
  requiredTools?: readonly string[];
  requiredToolVersions?: Readonly<Record<string, number>>;
  compatibleContractVersions?: readonly string[];
  expectedSchemaVersion?: number;
  expectedSchemaHash?: string;
  expectedScope?: string;
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
  options: ContractValidationOptions = {},
): ContractValidationResult {
  if (!isRecord(manifest)) {
    return { ok: false, reasons: ["contract manifest must be an object"] };
  }
  const reasons: string[] = [
    ...scopeReasons(manifest, options),
    ...contractVersionReasons(manifest, options),
    ...schemaVersionReasons(manifest, options),
    ...schemaHashReasons(manifest, options),
    ...requiredToolReasons(manifest, options),
  ];
  return { ok: reasons.length === 0, reasons };
}

function scopeReasons(
  manifest: Record<string, unknown>,
  options: ContractValidationOptions,
): string[] {
  const expectedScope = options.expectedScope ?? EXPECTED_CONTRACT_SCOPE;
  if (manifest["contract_scope"] === expectedScope) {
    return [];
  }
  return ["contract_scope mismatch"];
}

function contractVersionReasons(
  manifest: Record<string, unknown>,
  options: ContractValidationOptions,
): string[] {
  const contractVersion = manifest["contract_version"];
  if (typeof contractVersion !== "string" || !contractVersion) {
    return ["contract_version is missing or not a non-empty string"];
  }
  const compatible = options.compatibleContractVersions;
  if (
    compatible !== undefined &&
    compatible.length > 0 &&
    !compatible.includes(contractVersion)
  ) {
    return ["contract_version is not compatible"];
  }
  return [];
}

function schemaVersionReasons(
  manifest: Record<string, unknown>,
  options: ContractValidationOptions,
): string[] {
  if (options.expectedSchemaVersion === undefined) {
    return [];
  }
  const version = manifest["schema_version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return ["schema_version is missing or not an integer"];
  }
  if (version !== options.expectedSchemaVersion) {
    return ["schema_version mismatch"];
  }
  return [];
}

function schemaHashReasons(
  manifest: Record<string, unknown>,
  options: ContractValidationOptions,
): string[] {
  if (options.expectedSchemaHash === undefined) {
    return [];
  }
  const schemaHash = manifest["schema_hash"];
  if (typeof schemaHash !== "string" || !schemaHash) {
    return ["schema_hash is missing or not a non-empty string"];
  }
  if (schemaHash !== options.expectedSchemaHash) {
    return ["schema_hash mismatch"];
  }
  return [];
}

function requiredToolReasons(
  manifest: Record<string, unknown>,
  options: ContractValidationOptions,
): string[] {
  const requiredTools = options.requiredTools ?? [];
  if (requiredTools.length === 0) {
    return [];
  }
  const requiredVersions = options.requiredToolVersions ?? {};
  const capabilityVersions = capabilityToolVersions(manifest["capabilities"]);
  return [
    ...capabilityReasons(requiredTools, requiredVersions, capabilityVersions),
    ...toolContractReasons(manifest["tool_contracts"], requiredTools, requiredVersions),
  ];
}

function capabilityReasons(
  requiredTools: readonly string[],
  requiredVersions: Readonly<Record<string, number>>,
  capabilityVersions: Map<string, unknown>,
): string[] {
  const reasons: string[] = [];
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
    if (!isVersionAtLeast(capabilityVersions.get(tool), minimum)) {
      reasons.push(`capability '${tool}'.version must be >= ${minimum}`);
    }
  }
  return reasons;
}

function toolContractReasons(
  toolContracts: unknown,
  requiredTools: readonly string[],
  requiredVersions: Readonly<Record<string, number>>,
): string[] {
  if (!isRecord(toolContracts)) {
    return ["tool_contracts is missing or not an object"];
  }
  const reasons: string[] = [];
  const missingContracts = requiredTools
    .filter((tool) => !(tool in toolContracts))
    .sort();
  if (missingContracts.length > 0) {
    reasons.push(
      "required tool(s) missing from tool_contracts: " + missingContracts.join(", "),
    );
  }
  for (const tool of requiredTools) {
    const entry = toolContracts[tool];
    if (entry === undefined) {
      continue;
    }
    reasons.push(...toolContractEntryReasons(tool, entry, requiredVersions));
  }
  return reasons;
}

function toolContractEntryReasons(
  tool: string,
  entry: unknown,
  requiredVersions: Readonly<Record<string, number>>,
): string[] {
  if (!isRecord(entry)) {
    return [`tool_contracts['${tool}'] must be an object`];
  }
  const reasons: string[] = [
    ...toolContractVersionReasons(tool, entry["version"], requiredVersions[tool]),
  ];
  if (!isRecord(entry["input_schema"])) {
    reasons.push(`tool_contracts['${tool}'].input_schema must be an object`);
  }
  const outputShape = entry["output_shape"];
  if (
    !(typeof outputShape === "string" && outputShape.trim().length > 0) &&
    !isRecord(entry["output_schema"])
  ) {
    reasons.push(
      `tool_contracts['${tool}'] must define a non-empty output_shape ` +
        "or output_schema object",
    );
  }
  return reasons;
}

function toolContractVersionReasons(
  tool: string,
  version: unknown,
  minimum: number | undefined,
): string[] {
  if (version === undefined || version === null || version === "") {
    return [`tool_contracts['${tool}'].version is missing or empty`];
  }
  if (minimum !== undefined && !isVersionAtLeast(version, minimum)) {
    return [`tool_contracts['${tool}'].version must be >= ${minimum}`];
  }
  return [];
}

function isVersionAtLeast(version: unknown, minimum: number): boolean {
  return typeof version === "number" && Number.isInteger(version) && version >= minimum;
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
