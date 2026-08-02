import { describe, expect, test } from "bun:test";
import { SERVER_REWRITE_STATE } from "../server/state.ts";
import { SERVER_CONTRACT_PROVIDERS } from "./server-contract-providers.ts";

describe("server contract provider harness", () => {
  test("runs the declaration gate against current and rewrite providers", () => {
    expect(SERVER_CONTRACT_PROVIDERS.map((provider) => provider.id)).toEqual([
      "current-src",
      "server-rewrite-scaffold",
    ]);
  });

  test("does not mistake scaffold parity for a serving implementation", () => {
    const rewrite = SERVER_CONTRACT_PROVIDERS.find(
      (provider) => provider.id === "server-rewrite-scaffold",
    );

    expect(rewrite?.state).toBe("scaffold-only");
    expect(SERVER_REWRITE_STATE).toEqual({
      law0: "WRITTEN",
      phase: "scaffold-only",
      servesTraffic: false,
      cutoverStarted: false,
    });
  });
});
