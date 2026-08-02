import { buildContract } from "../src/contract.ts";
import { SERVER_CONTRACT_DECLARATION } from "../server/contracts/declaration.ts";

export interface ContractDeclarationProvider {
  id: "current-src" | "server-rewrite-scaffold";
  state: "running-implementation" | "partial-implementation" | "scaffold-only";
  declaration(generatedAt: string): {
    contractVersion: string;
    schemaHash: string;
  };
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
    declaration() {
      return SERVER_CONTRACT_DECLARATION;
    },
  },
];
