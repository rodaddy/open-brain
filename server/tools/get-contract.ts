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
 * `server/contracts/declaration.ts` already records that same identity
 * (`2026-07-23.memory-tools.v23`, hash `4b69e9b4...`), verified equal to
 * `buildContract()`'s output on this branch. The assertion below keeps that
 * equality enforced rather than assumed: if `src/contract.ts` moves without the
 * rewrite's declaration moving with it, the mismatch surfaces as a logged
 * warning at call time instead of as a client-side negotiation failure.
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
import { SERVER_CONTRACT_DECLARATION } from "../contracts/declaration.ts";
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
      if (
        contract.contract_version !== SERVER_CONTRACT_DECLARATION.contractVersion ||
        contract.schema_hash !== SERVER_CONTRACT_DECLARATION.schemaHash
      ) {
        dependencies.logger.warn(
          {
            tool: "get_contract",
            servedVersion: contract.contract_version,
            declaredVersion: SERVER_CONTRACT_DECLARATION.contractVersion,
          },
          "contract_declaration_drift",
        );
      }
      dependencies.logger.info({ tool: "get_contract" }, "tool_result");
      return textResult(contract);
    },
  );
}
