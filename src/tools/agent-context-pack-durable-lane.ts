// L5 adapter (issue 864): legacy call form over server/tools/context-pack-durable-lane.ts; retired with src/ at L6.
import {
  loadDurableLaneContext as loadServerDurableLaneContext,
  type DurableLaneContextFragment,
} from "../../server/tools/context-pack-durable-lane.ts";
import type { AgentContextPackArgs } from "../../server/tools/context-pack-args.ts";
import {
  memoryToolDependenciesFor,
  type ToolDeps,
} from "../../server/tools/legacy-context-pack/legacy-deps.ts";
import type { MemoryToolDependencies } from "../../server/tools/types.ts";
import { sharedNamespaceConfig } from "../../server/security/shared-namespace.ts";

export {
  CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
  UNBOUNDED,
  boundedText,
} from "../../server/tools/context-pack-shared.ts";
export type { DurableLaneContextFragment };

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

/** Legacy positional form; the server twin takes server-shaped dependencies. */
export async function loadDurableLaneContext(
  args: AgentContextPackArgs,
  namespace: string,
  deps: ToolDeps,
  contentCharLimit?: number,
): Promise<DurableLaneContextFragment> {
  return loadServerDurableLaneContext(
    args,
    namespace,
    legacyDependencies(deps),
    contentCharLimit,
  );
}
