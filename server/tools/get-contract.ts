/**
 * `get_contract`: return the canonical Open Brain public contract manifest.
 *
 * The manifest is built by `src/contract.ts` rather than rebuilt here, and that
 * is the whole design decision. The contract is what downstream clients
 * (`openbrain-memory`, `rtech-hermes-runtime`, `mcp2cli`) negotiate against, and
 * its `schema_hash` is a sha256 over the payload; a second hand-maintained copy
 * in the rewrite would be a second answer to "what does this server promise",
 * and the two would diverge silently on the first schema edit. Reusing the
 * builder means the rewrite cannot drift from the contract it serves.
 *
 * `server/contracts/declaration.ts` used to hold that identity as two string
 * literals, and the warning below compared `buildContract()` against them. That
 * comparison is gone because the declaration is now DERIVED from the same
 * builder: deriving both sides would make the condition `x !== x`, a branch that
 * can never fire while still reading like a guard. The frozen identity is
 * anchored where an anchor actually holds -- the pinned expectation in
 * `src/contract.test.ts` and `contracts/memory/contract-declaration-v24.fixture.json`
 * -- so a hash move still has to be deliberate.
 *
 * What IS worth checking at call time is the question the old string comparison
 * could not ask: whether this server registers everything the contract it just
 * handed out promises. A client negotiates against the manifest and then calls
 * its tools, so serving a contract naming a tool this registry does not answer
 * is the failure that matters, and it is invisible to any version-string match.
 *
 * `natsAvailability` is not threaded through. The rewrite has not ported
 * `nats-runtime.ts`/`nats-bridge.ts` on any wave, so there is no runtime
 * boundary to report from; `buildContract` defaults it to
 * `not_runtime_available`, which is the accurate answer for this server and the
 * value current-src emits when its own bridge is absent. Realtime transport is
 * excluded from `schema_hash` by design, so this does not change the hash.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../auth/permissions.ts";
import { buildContract } from "../../src/contract.ts";
import {
  contractRequiredTools,
  evaluateRewriteContractSatisfaction,
} from "../contracts/declaration.ts";
import { rewriteRegisteredTools } from "../contracts/registered-tools.ts";
import { authIdentity, errorResult, textResult, type MemoryToolDependencies } from "./types.ts";

export function registerGetContractTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "get_contract",
    {
      description:
        "Return the canonical Open Brain public contract manifest for downstream clients.",
      inputSchema: {},
      annotations: {
        title: "Get Contract",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (_args, extra) => {
      const identity = authIdentity(extra.authInfo);
      // Gated on `sessions` read, matching observed current-src: the manifest is
      // service metadata, not namespaced memory, so it carries no per-namespace
      // predicate -- there is nothing in it that belongs to a lane.
      if (!identity || !canRead(identity.role, "sessions")) {
        return errorResult("Permission denied: cannot read contract");
      }

      const contract = buildContract();
      const satisfaction = evaluateRewriteContractSatisfaction(
        contractRequiredTools(contract),
        rewriteRegisteredTools(),
      );
      if (!satisfaction.satisfied) {
        // Warn, do not fail: `get_contract` answering honestly is more useful to
        // a client than refusing, and the build-time gate in
        // `contracts/check-parity.ts` is what blocks the gap from shipping.
        dependencies.logger.warn(
          {
            tool: "get_contract",
            servedVersion: contract.contract_version,
            missingTools: satisfaction.missingTools,
            requiredToolCount: satisfaction.requiredTools.length,
            registeredToolCount: satisfaction.registeredTools.length,
          },
          "contract_registry_shortfall",
        );
      }
      dependencies.logger.info({ tool: "get_contract" }, "tool_result");
      return textResult(contract);
    },
  );
}
