// L5 adapter (issue 864): legacy call form over server/tools/agent-context-pack.ts; retired with src/ at L6.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildAgentContextPackPayload as buildServerContextPackPayload,
  buildAgentReflexPointersPayload as buildServerReflexPointersPayload,
  registerAgentContextPackTool,
  registerAgentReflexPointersTool,
  type AgentContextPackBuildResult,
  type AgentReflexPointersBuildResult,
} from "../../server/tools/agent-context-pack.ts";
import {
  registerRecoveryWalAppendTool,
  registerRecoveryWalMarkTool,
  registerWorkingSetAppendTool,
} from "../../server/tools/realtime-append.ts";
import type {
  AgentContextPackArgs,
  AgentReflexPointersArgs,
} from "../../server/tools/context-pack-args.ts";
import {
  authIdentityFor,
  memoryToolDependenciesFor,
  type AuthInfo,
  type ToolDeps,
} from "../../server/tools/legacy-context-pack/legacy-deps.ts";
import type { MemoryToolDependencies } from "../../server/tools/types.ts";
import { sharedNamespaceConfig } from "../../server/security/shared-namespace.ts";

export {
  SECTION_NAMES,
  scopeInputSchema,
  priorContextReferenceInputSchema,
  contextPackBudgetInputSchema,
  contextPackContinuationInputSchema,
  agentContextPackInputSchema,
  agentContextPackStrictSchema,
  AGENT_CONTEXT_PACK_REQUEST_KEYS,
  parseAgentContextPackArgs,
  agentReflexPointersInputSchema,
  agentReflexPointersStrictSchema,
  AGENT_REFLEX_POINTERS_REQUEST_KEYS,
  parseAgentReflexPointersArgs,
} from "../../server/tools/context-pack-args.ts";
export { CONTEXT_PACK_SECTION_PRIORITY } from "../../server/tools/context-pack-budget.ts";
export type {
  AgentContextPackArgs,
  AgentReflexPointersArgs,
  AgentContextPackBuildResult,
  AgentReflexPointersBuildResult,
};

/**
 * The legacy dependency mapping, with the values the server twin takes as
 * configuration read from the environment at call time.
 *
 * The server modules read no environment of their own; the legacy path derived
 * both of these per call. Reading them HERE, at the moment of the call, keeps a
 * legacy caller that sets one of them after import behaving exactly as it did.
 * `src/shared-namespace.ts` is the identical parse; it is not imported because
 * an adapter may name no src/ relative specifier.
 */
function legacyDependencies(deps: ToolDeps): MemoryToolDependencies {
  const sharedNamespaceNames = sharedNamespaceConfig({
    sharedNamespaceCanonical: process.env["SHARED_NAMESPACE_CANONICAL"],
    sharedNamespacePhysical: process.env["SHARED_NAMESPACE_PHYSICAL"],
    openbrainSharedNamespace: process.env["OPENBRAIN_SHARED_NAMESPACE"],
    sharedNamespaceLegacy: process.env["SHARED_NAMESPACE_LEGACY"],
    openbrainLegacySharedNamespace: process.env["OPENBRAIN_LEGACY_SHARED_NAMESPACE"],
    legacySharedFallback: process.env["OPENBRAIN_LEGACY_SHARED_FALLBACK"],
    sharedFallbackMinResults: process.env["OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS"],
    allowLegacySharedWrites: process.env["OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES"],
  });
  return memoryToolDependenciesFor(
    deps,
    sharedNamespaceNames,
    process.env["OPENBRAIN_RECOVERY_WAL_PATH"] ?? null,
  );
}

/** Legacy positional form; the server twin takes server-shaped auth and dependencies. */
export async function buildAgentContextPackPayload(
  args: AgentContextPackArgs,
  auth: AuthInfo | undefined,
  deps: ToolDeps,
): Promise<AgentContextPackBuildResult> {
  return buildServerContextPackPayload(
    args,
    auth ? authIdentityFor(auth) : undefined,
    legacyDependencies(deps),
  );
}

/** Legacy positional form; the server twin takes server-shaped auth and dependencies. */
export async function buildAgentReflexPointersPayload(
  args: AgentReflexPointersArgs,
  auth: AuthInfo | undefined,
  deps: ToolDeps,
): Promise<AgentReflexPointersBuildResult> {
  return buildServerReflexPointersPayload(
    args,
    auth ? authIdentityFor(auth) : undefined,
    legacyDependencies(deps),
  );
}

export function registerAgentContextPack(server: McpServer, deps: ToolDeps) {
  registerAgentContextPackTool(server, legacyDependencies(deps));
}

export function registerAgentReflexPointers(server: McpServer, deps: ToolDeps) {
  registerAgentReflexPointersTool(server, legacyDependencies(deps));
}

export function registerWorkingSetAppend(server: McpServer, deps: ToolDeps) {
  registerWorkingSetAppendTool(server, legacyDependencies(deps));
}

export function registerRecoveryWalAppend(server: McpServer, deps: ToolDeps) {
  registerRecoveryWalAppendTool(server, legacyDependencies(deps));
}

export function registerRecoveryWalMark(server: McpServer, deps: ToolDeps) {
  registerRecoveryWalMarkTool(server, legacyDependencies(deps));
}
