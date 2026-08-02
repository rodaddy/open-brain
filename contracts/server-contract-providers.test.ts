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

  /**
   * The cutover moved this pin rather than deleting it.
   *
   * Its job never was "assert false forever" -- it is the tripwire that stops
   * `server/state.ts` from drifting away from the wired reality in either
   * direction. Before the flip it caught a premature `servesTraffic: true`; now
   * it catches an accidental revert to `false` while the deployed chain spawns
   * `server/main.ts`. Whole-object `toEqual` is deliberate: adding a field
   * without deciding what it claims should fail here.
   *
   * `law0` is `MERGED`, not `RUNNING`. A passing test proves code, not a live
   * process; the deployed `/health` proof is what may raise it.
   */
  test("declares exactly the post-cutover state, and nothing stronger than merged", () => {
    const rewrite = SERVER_CONTRACT_PROVIDERS.find(
      (provider) => provider.id === "server-rewrite-scaffold",
    );

    expect(rewrite?.state).toBe("running-implementation");
    expect(SERVER_REWRITE_STATE).toEqual({
      law0: "MERGED",
      phase: "cutover",
      servesTraffic: true,
      cutoverStarted: true,
    });
  });
});
