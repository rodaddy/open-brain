import { buildContract } from "../src/contract.ts";
import {
  rewriteContractSatisfaction,
  serverContractDeclaration,
  type RewriteContractSatisfaction,
} from "../server/contracts/declaration.ts";

export interface ContractDeclarationProvider {
  id: "current-src" | "server-rewrite-scaffold";
  state: "running-implementation" | "partial-implementation" | "scaffold-only";
  declaration(generatedAt: string): {
    contractVersion: string;
    schemaHash: string;
  };
  /**
   * Whether this provider's REGISTERED tools satisfy the contract it declares.
   *
   * Optional because it only means something for a provider whose registry the
   * checker can walk in-process. `current-src` already has an equivalent, and
   * stricter, invariant in the tool gap map.
   */
  satisfaction?(generatedAt: string): RewriteContractSatisfaction;
}

export const SERVER_CONTRACT_PROVIDERS: readonly ContractDeclarationProvider[] = [
  {
    id: "current-src",
    state: "running-implementation",
    declaration(generatedAt) {
      const contract = buildContract(generatedAt);
      return {
        contractVersion: contract.contract_version,
        schemaHash: contract.schema_hash,
      };
    },
  },
  {
    id: "server-rewrite-scaffold",
    state: "partial-implementation",
    // DERIVED, not asserted. This was a pair of hardcoded literals, so the
    // parity check compared a constant to itself and reported green while the
    // rewrite registry was short of the contract. Identity now comes from the
    // same builder the running provider uses; `satisfaction` is what proves the
    // rewrite has earned the identity it declares.
    declaration(generatedAt) {
      return serverContractDeclaration(generatedAt);
    },
    satisfaction(generatedAt) {
      return rewriteContractSatisfaction(generatedAt);
    },
  },
];
