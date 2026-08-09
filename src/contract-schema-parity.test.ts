/**
 * Contract mirror <-> live Zod schema parity (#678).
 *
 * WHY THIS FILE EXISTS. `src/contract-schemas.ts` is a HAND-MAINTAINED mirror
 * of the Zod schemas that actually validate requests, and `schema_hash` — the
 * value docs/downstream-rollout.md:112 calls "the authoritative drift receipt"
 * — is computed over a payload that includes that mirror. So the receipt moves
 * when the MIRROR moves, not when the CONTRACT moves. Between #543 and #563 the
 * live `agent_context_pack` schema gained `repo`, `prior_context`, and
 * `continue_from`; the mirror was never touched; and every downstream
 * compatibility check (python/.../_runtime_router.py) returned an identical
 * verdict on both sides of a real, client-facing shape change.
 *
 * Reconciling those three keys fixed one instance. THIS FILE is what stops the
 * next one being silent in the same way: the mirror is now pinned to the Zod
 * source by an executable assertion, so a shape change that forgets the mirror
 * fails here instead of shipping a blind receipt.
 *
 * WHAT IS ENFORCED, AND WHAT IS NOT — stated plainly rather than implied.
 * ENFORCED: the KEY SET, in both directions, for every tool whose live Zod
 * schema this file can reach, across BOTH reachable serving trees.
 *   - a key in Zod but not the mirror under-advertises the contract: clients
 *     are told a parameter does not exist when the server accepts it.
 *   - a key in the mirror but not in Zod is worse — it advertises a parameter
 *     the registration-time `.strict()` schema will REJECT, so a client that
 *     believes the manifest gets an error it cannot diagnose.
 * NOT ENFORCED: per-field bounds and descriptions. The mirror states them in a
 * hand-authored vocabulary (`maxLength`, `required: "citation_id_or_source_ref"`)
 * that Zod introspection does not reproduce 1:1, so a change to `query`'s max
 * length in Zod alone would still drift silently. Deriving the whole mirror
 * from Zod is a contract-shape rewrite rather than a drift fix, and it would
 * move the hash for reasons unrelated to #678. The gap is real and is named
 * here so the next reader does not mistake this file for total coverage.
 */

import { describe, expect, test } from "bun:test";

import { TOOL_CONTRACTS } from "./contract-schemas.ts";
import {
  agentContextPackInputSchema as srcContextPackSchema,
  agentReflexPointersInputSchema as srcReflexSchema,
} from "./tools/agent-context-pack.ts";
import {
  agentContextPackInputSchema as serverContextPackSchema,
  agentReflexPointersInputSchema as serverReflexSchema,
} from "../server/tools/context-pack-args.ts";

/**
 * The tools this file pins, and the live Zod shape each mirror must match.
 *
 * Both serving trees are listed on purpose. `server/main.ts` is the serving
 * entrypoint, but `src/index.ts` is still reachable through `bun start`,
 * `deploy/open-brain.service`, and `scripts/run-two-worker.ts` (see the
 * duplication note in src/tools/agent-context-pack.ts). A mirror reconciled
 * against one tree while the other drifted would be accurate and still wrong
 * on the surface that happens to be running.
 */
const PINNED: ReadonlyArray<{
  tool: string;
  tree: "src" | "server";
  zodShape: Record<string, unknown>;
}> = [
  { tool: "agent_context_pack", tree: "src", zodShape: srcContextPackSchema },
  {
    tool: "agent_context_pack",
    tree: "server",
    zodShape: serverContextPackSchema,
  },
  { tool: "agent_reflex_pointers", tree: "src", zodShape: srcReflexSchema },
  {
    tool: "agent_reflex_pointers",
    tree: "server",
    zodShape: serverReflexSchema,
  },
];

function sortedKeys(shape: Record<string, unknown>): string[] {
  return Object.keys(shape).sort();
}

describe("contract mirror parity with the live Zod schemas (#678)", () => {
  for (const { tool, tree, zodShape } of PINNED) {
    test(`${tool} (${tree} tree): mirror advertises exactly the accepted keys`, () => {
      const entry = TOOL_CONTRACTS[tool];
      expect(entry).toBeDefined();

      const mirrorKeys = sortedKeys(
        (entry?.input_schema ?? {}) as Record<string, unknown>,
      );
      const zodKeys = sortedKeys(zodShape);

      // Compared as whole sorted arrays rather than with two subset checks, so
      // a failure prints both sides and the reader can see WHICH key drifted
      // and in which direction — the report is the point, not just the red.
      expect(mirrorKeys).toEqual(zodKeys);
    });
  }

  test("the mirror does not advertise a key the strict schema would reject", () => {
    // The direction that produces the worse client experience, asserted on its
    // own so the failure message names the hazard rather than a diff.
    for (const { tool, tree, zodShape } of PINNED) {
      const entry = TOOL_CONTRACTS[tool];
      const mirrorKeys = sortedKeys(
        (entry?.input_schema ?? {}) as Record<string, unknown>,
      );
      const accepted = new Set(Object.keys(zodShape));
      const wouldBeRejected = mirrorKeys.filter((key) => !accepted.has(key));
      expect({ tool, tree, wouldBeRejected }).toEqual({
        tool,
        tree,
        wouldBeRejected: [],
      });
    }
  });

  test("the two serving trees accept the same keys as each other", () => {
    // Independent of the mirror comparisons above: if the trees disagree, at
    // most one of them can be matching the mirror, and the manifest is wrong on
    // whichever surface is actually serving.
    expect(sortedKeys(srcContextPackSchema)).toEqual(
      sortedKeys(serverContextPackSchema),
    );
    expect(sortedKeys(srcReflexSchema)).toEqual(sortedKeys(serverReflexSchema));
  });

  test("the keys #678 was filed about are present (regression anchor)", () => {
    // The specific drift that made the receipt blind. Named explicitly so a
    // future refactor of this file cannot quietly drop the case that motivated
    // it — the generic comparison above would still pass if someone deleted
    // the key from BOTH the mirror and the Zod schema, and that deletion is a
    // breaking change that should be loud.
    const mirrorKeys = sortedKeys(
      (TOOL_CONTRACTS.agent_context_pack?.input_schema ?? {}) as Record<
        string,
        unknown
      >,
    );
    for (const key of ["repo", "prior_context", "continue_from"]) {
      expect(mirrorKeys).toContain(key);
    }
  });
});
