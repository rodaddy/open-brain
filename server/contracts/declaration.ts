import { buildContract } from "./contract.ts";
import { rewriteRegisteredTools } from "./registered-tools.ts";

export interface ServerContractDeclaration {
  contractVersion: string;
  schemaHash: string;
}

/**
 * What the frozen contract REQUIRES any server implementation to register.
 *
 * `tool_contracts` keys and the `kind: "tool"` capability names are the same 21
 * names today, but they are two independent statements in the contract and are
 * unioned rather than assumed equal -- if a later contract adds a tool
 * capability without a schema entry (or the reverse), this still demands both.
 * `kind: "schema"` and `kind: "transport"` capabilities are excluded: they name
 * payload shapes and the HTTP transport, not registered MCP tools.
 */
export function contractRequiredTools(contract: {
  tool_contracts: Record<string, unknown>;
  capabilities: ReadonlyArray<{ name: string; kind: string }>;
}): string[] {
  const required = new Set<string>(Object.keys(contract.tool_contracts));
  for (const capability of contract.capabilities) {
    if (capability.kind === "tool") required.add(capability.name);
  }
  return [...required].sort();
}

export interface RewriteContractSatisfaction {
  requiredTools: string[];
  registeredTools: string[];
  missingTools: string[];
  satisfied: boolean;
}

/**
 * Does the rewrite registry satisfy the frozen contract?
 *
 * Registering MORE than the contract requires is not a violation -- the rewrite
 * deliberately carries `record_skill_usage`/`skill_usage_report` (#469), which
 * the contract never promised. Registering LESS is: a client holding this
 * contract would call a tool the rewrite does not answer.
 */
export function evaluateRewriteContractSatisfaction(
  requiredTools: readonly string[],
  registeredTools: readonly string[],
): RewriteContractSatisfaction {
  const registered = new Set(registeredTools);
  const missingTools = requiredTools.filter((tool) => !registered.has(tool));
  return {
    requiredTools: [...requiredTools],
    registeredTools: [...registeredTools].sort(),
    missingTools,
    satisfied: missingTools.length === 0,
  };
}

/**
 * The rewrite's contract identity, DERIVED -- not asserted.
 *
 * This used to be two hardcoded string literals, which made
 * `contracts/check-parity.ts` compare a constant to itself: parity stayed green
 * while the rewrite registry was materially short of the contract it claimed to
 * implement. The gate proved the src side and merely echoed the server side.
 *
 * The identity now comes from the same `buildContract()` the running src
 * provider derives from, so the two can no longer drift apart by editing a
 * string. Whether the rewrite actually HONORS that identity is a separate
 * question, answered by `rewriteContractSatisfaction()` and enforced by the
 * checker -- an identity is a claim, and the claim is only worth what the
 * registry backs.
 */
export function serverContractDeclaration(
  generatedAt: string,
): ServerContractDeclaration {
  const contract = buildContract(generatedAt);
  return {
    contractVersion: contract.contract_version,
    schemaHash: contract.schema_hash,
  };
}

export function rewriteContractSatisfaction(
  generatedAt: string,
): RewriteContractSatisfaction {
  return evaluateRewriteContractSatisfaction(
    contractRequiredTools(buildContract(generatedAt)),
    rewriteRegisteredTools(),
  );
}
