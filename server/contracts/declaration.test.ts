/**
 * The rewrite's contract declaration is DERIVED, not asserted.
 *
 * These tests exist because the thing they replace could not fail. The
 * declaration used to be two hardcoded string literals, and
 * `contracts/check-parity.ts` compared them to `buildContract()` -- so parity
 * reported green while the rewrite registry was materially short of the
 * contract it claimed to implement. A check that compares a constant to itself
 * has no failing input, which is exactly why nothing caught it.
 */
import { describe, expect, test } from "bun:test";
import { buildContract } from "../../src/contract.ts";
import {
  contractRequiredTools,
  evaluateRewriteContractSatisfaction,
  rewriteContractSatisfaction,
  serverContractDeclaration,
} from "./declaration.ts";
import { REWRITE_REGISTERED_TOOLS } from "./registered-tools.ts";

const GENERATED_AT = "1970-01-01T00:00:00.000Z";

describe("serverContractDeclaration", () => {
  test("derives the identity from buildContract rather than restating it", () => {
    const contract = buildContract(GENERATED_AT);
    expect(serverContractDeclaration(GENERATED_AT)).toEqual({
      contractVersion: contract.contract_version,
      schemaHash: contract.schema_hash,
    });
  });

  test("still reports the reviewed frozen identity", () => {
    // Pinned independently of `src/contract.test.ts`: deriving the value must
    // not quietly change what the rewrite tells downstream clients.
    expect(serverContractDeclaration(GENERATED_AT)).toEqual({
      contractVersion: "2026-07-23.memory-tools.v23",
      schemaHash:
        "4b69e9b437c96175531b049b6e3c2782f383334e9e1931e96e73835599e4a4a8",
    });
  });
});

describe("contractRequiredTools", () => {
  test("unions tool_contracts keys with kind:'tool' capabilities", () => {
    const required = contractRequiredTools({
      tool_contracts: { alpha: {}, beta: {} },
      capabilities: [
        { name: "beta", kind: "tool" },
        { name: "gamma", kind: "tool" },
        { name: "some_payload", kind: "schema" },
        { name: "streamable_http", kind: "transport" },
      ],
    });
    // gamma comes from the capability list alone, so a contract that names a
    // tool without a schema entry is still demanded.
    expect(required).toEqual(["alpha", "beta", "gamma"]);
  });

  test("excludes schema and transport capabilities, which are not tools", () => {
    const required = contractRequiredTools({
      tool_contracts: {},
      capabilities: [
        { name: "receipt_contract", kind: "schema" },
        { name: "streamable_http_auth", kind: "transport" },
      ],
    });
    expect(required).toEqual([]);
  });
});

describe("evaluateRewriteContractSatisfaction", () => {
  test("names every required tool the registry does not register", () => {
    const result = evaluateRewriteContractSatisfaction(
      ["alpha", "beta", "gamma"],
      ["alpha"],
    );
    expect(result.satisfied).toBe(false);
    expect(result.missingTools).toEqual(["beta", "gamma"]);
  });

  test("allows registering more than the contract requires", () => {
    // The rewrite deliberately carries record_skill_usage/skill_usage_report
    // (#469), which the frozen contract never named. Extra surface cannot break
    // a client holding the contract; only a shortfall can.
    const result = evaluateRewriteContractSatisfaction(
      ["alpha"],
      ["alpha", "record_skill_usage"],
    );
    expect(result.satisfied).toBe(true);
    expect(result.missingTools).toEqual([]);
  });

  test("an empty registry does not vacuously satisfy a real contract", () => {
    const result = evaluateRewriteContractSatisfaction(["alpha"], []);
    expect(result.satisfied).toBe(false);
    expect(result.missingTools).toEqual(["alpha"]);
  });
});

describe("the live rewrite registry", () => {
  test("is walked by running the real registrar, not by scanning source", () => {
    // Guards the failure mode a regex has and this does not: `src/tools` puts
    // the tool name on the same line as `registerTool(` while `server/tools`
    // puts it on the next, so the src-side single-line pattern finds ZERO
    // rewrite tools -- and a shortfall check over an empty set reports success.
    expect(REWRITE_REGISTERED_TOOLS.length).toBeGreaterThan(50);
    expect(REWRITE_REGISTERED_TOOLS).toContain("get_contract");
    expect(new Set(REWRITE_REGISTERED_TOOLS).size).toBe(
      REWRITE_REGISTERED_TOOLS.length,
    );
  });

  test("registers every contract-required tool whose port has landed", () => {
    const result = rewriteContractSatisfaction(GENERATED_AT);
    // Asserted as a set difference rather than `satisfied === true`: the port is
    // still in flight, and `contracts/check-parity.ts` is what judges each
    // remaining gap against its capability's declared status. Anything missing
    // here that is NOT a known scaffold-declared capability is drift.
    const KNOWN_UNPORTED = ["citation_recall"];
    expect(
      result.missingTools.filter((tool) => !KNOWN_UNPORTED.includes(tool)),
    ).toEqual([]);
  });
});
