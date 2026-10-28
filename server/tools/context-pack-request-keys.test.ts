/**
 * Functional tests for how `agent_context_pack` handles the REQUEST itself:
 * an unknown request key, and the receipt that names requested vs served
 * sections. Split out of `context-pack.test.ts`; shared fixtures live in
 * `./testing/context-pack-test-support.ts`.
 */
import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { expectDefined } from "../testing/expect-defined.ts";
import {
  callJson,
  harness,
  recallStackCount,
  SCOPE,
  sectionsOf,
} from "./testing/context-pack-test-support.ts";

/**
 * #535 — a caller mistake must never look like a successful answer.
 *
 * Operator directive (Dana, 2026-08-03): "Should be more than just keep it or
 * drop it. It should be fail loudly and make us think about it."
 *
 * The defect these tests pin: the MCP SDK validates against a plain
 * `z.object()` built from the raw shape, which STRIPS undeclared keys. Sending
 * `sections` (the near-miss spelling of `requested_sections`) left the parsed
 * args with no section selection at all, so the pack returned its
 * working_set-only default with `status: "ok"`. A typo read as a correct
 * minimal request, twice at real cost (#439, #526).
 *
 * RED PROOF: with `rejectUnknownRequestKeys` removed from
 * `parseAgentContextPackArgs`, the first test fails on
 * `expect(isError).toBe(true)` — the call succeeds and returns the default
 * pack, which is exactly the old behavior.
 */
describe("an unknown request key fails loudly instead of returning a default pack", () => {
  /**
   * The rejection arrives as an `isError` tool result carrying the JSON-RPC
   * -32602 InvalidParams text, because the SDK rejects before dispatch and the
   * client surfaces that as an error result rather than a throw. Reading the
   * message is reading exactly what a caller sees on the wire.
   */
  async function rejectionMessage(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    if (result.isError !== true) {
      throw new Error(
        `${name} accepted the request instead of rejecting it — ` +
          `the silent-default defect is back. Payload: ${text.slice(0, 200)}`,
      );
    }
    return text;
  }

  test("agent_context_pack rejects `sections` by name and lists the accepted keys", async () => {
    const { client, queries } = await harness("agent", "dana");

    // The exact near-miss from #439/#526: correct intent, wrong key.
    const message = await rejectionMessage(client, "agent_context_pack", {
      ...SCOPE,
      sections: ["durable_memory", "repo_facts"],
    });

    // Named rejection, not a generic parse failure: the offending key and the
    // accepted vocabulary are both present so the caller can correct toward it.
    expect(message).toContain("unrecognized_keys");
    expect(message).toContain("sections");
    expect(message).toContain("Accepted keys");
    expect(message).toContain("requested_sections");
    expect(message).toContain("include_unreviewed_recovery");

    // The old behavior's tell was a success-shaped body. There must be none.
    expect(message).not.toContain("openbrain.agent_context_pack.v1");

    // Rejection happens before dispatch, so no retrieval ran for a bad request.
    expect(recallStackCount(queries)).toBe(0);
  });

  test("agent_reflex_pointers rejects a pack-only key rather than ignoring it", async () => {
    const { client } = await harness("agent", "dana");

    // `requested_sections` is valid on the pack and NOT on the reflex, which is
    // the near-miss this surface actually sees. Ignoring it would silently
    // change nothing while the caller believed it had selected sections.
    const message = await rejectionMessage(client, "agent_reflex_pointers", {
      ...SCOPE,
      query: "needle",
      requested_sections: ["durable_memory"],
    });

    expect(message).toContain("requested_sections");
    expect(message).toContain("Accepted keys");
  });

  test("an unknown VALUE inside requested_sections names the accepted vocabulary", async () => {
    const { client } = await harness("agent", "dana");

    // Singular `repo_fact` — the section name is `repo_facts`. Already enforced
    // by the enum; pinned here so the guarantee cannot regress silently.
    const message = await rejectionMessage(client, "agent_context_pack", {
      ...SCOPE,
      requested_sections: ["repo_fact"],
    });

    expect(message).toContain("repo_facts");
    expect(message).toContain("candidate_memory");
  });

  test("the advertised schema declares that unknown keys are refused", async () => {
    const { client } = await harness("agent", "dana");

    // `additionalProperties: false` in tools/list is how a caller learns the
    // rule BEFORE breaking it, rather than from a failed call.
    const { tools } = await client.listTools();
    for (const name of ["agent_context_pack", "agent_reflex_pointers"]) {
      const tool = expectDefined(
        tools.find((candidate) => candidate.name === name),
        `the advertised ${name} tool`,
      );
      expect(tool).toBeDefined();
      expect(
        (tool.inputSchema as { additionalProperties?: boolean }).additionalProperties,
      ).toBe(false);
    }
  });

  test("a correctly spelled request is unaffected", async () => {
    const { client } = await harness("agent", "dana");

    const { payload, isError } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      requested_sections: ["working_set", "candidate_memory"],
    });

    expect(isError).toBe(false);
    expect(payload.status).toBe("ok");
    expect(Object.keys(sectionsOf(payload)).sort()).toEqual([
      "candidate_memory",
      "working_set",
    ]);
  });
});

/**
 * #535 receipt — what was asked for, against what came back.
 *
 * Unknown keys and unknown section values are both rejected above. What neither
 * catches is a section spelled correctly, accepted, and then dropped downstream
 * (budget eviction is the live case). That still reads as a success-shaped
 * short answer, so the pack states the difference in its own payload rather
 * than leaving the caller to diff `sections` against their request from memory.
 */
describe("the pack names requested vs served sections in its receipt", () => {
  test("a fully served request reports no shortfall", async () => {
    const { client } = await harness("agent", "dana");

    const { payload } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      requested_sections: ["working_set", "candidate_memory"],
    });

    const receipt = payload.sections_receipt as {
      requested: string[];
      served: string[];
      requested_not_served: string[];
    };
    expect(receipt.requested).toEqual(["working_set", "candidate_memory"]);
    expect(receipt.served.sort()).toEqual(["candidate_memory", "working_set"]);
    expect(receipt.requested_not_served).toEqual([]);
  });

  test("the default (no requested_sections) is distinguishable from an explicit request", async () => {
    const { client } = await harness("agent", "dana");

    const { payload } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
    });

    const receipt = payload.sections_receipt as {
      requested: string[] | null;
      served: string[];
      requested_not_served: string[];
    };
    // `null`, not `[]`: the caller asked for nothing and took the documented
    // default, which is not the same as asking for nothing. That default
    // serves working_set AND durable_memory since #744
    // (docs/agent-context-pack-contract.md:88).
    expect(receipt.requested).toBeNull();
    expect(receipt.served).toEqual(["working_set", "durable_memory"]);
    expect(receipt.requested_not_served).toEqual([]);
  });

  test("a requested section that does not arrive is named in the receipt", async () => {
    const { client } = await harness("agent", "dana");

    // `recovery` is admitted only with the explicit opt-in, so requesting it
    // without `include_unreviewed_recovery` is a request that cannot be served.
    // Before this receipt existed, that shortfall was invisible in the payload.
    const { payload } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      requested_sections: ["working_set", "recovery"],
    });

    const receipt = payload.sections_receipt as {
      requested: string[];
      served: string[];
      requested_not_served: string[];
    };
    expect(receipt.requested_not_served).toEqual(["recovery"]);
    expect(receipt.served).not.toContain("recovery");
  });
});
