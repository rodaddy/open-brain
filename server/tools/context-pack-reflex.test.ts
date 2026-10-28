/**
 * Functional tests for `agent_reflex_pointers`, which must project the pack
 * WITHOUT running a second retrieval stack. Split out of
 * `context-pack.test.ts`; shared fixtures live in
 * `./testing/context-pack-test-support.ts`.
 */
import { describe, expect, test } from "vitest";
import {
  callJson,
  citationIds,
  harness,
  recallStackCount,
  SCOPE,
  searchRow,
} from "./testing/context-pack-test-support.ts";

describe("agent_reflex_pointers projects the pack without a second stack", () => {
  test("the reflex runs exactly one recall and returns body-free pointers", async () => {
    const { client, queries } = await harness("agent", "dana", {
      rows: [searchRow("a", "alpha"), searchRow("b", "bravo")],
    });

    const { payload } = await callJson(client, "agent_reflex_pointers", {
      ...SCOPE,
      query: "needle",
    });

    expect(recallStackCount(queries)).toBe(1);
    expect(payload.schema).toBe("openbrain.agent_reflex_pointers.v1");
    expect(payload.placement).toBe("client_owned");
    expect(payload.resolvable_reference_only).toBe(true);
    const pointers = payload.pointers as Record<string, unknown>;
    expect(pointers.item_count).toBe(2);
    for (const item of pointers.items as Array<Record<string, unknown>>) {
      expect(item).not.toHaveProperty("content");
    }
    // The bijection survives the projection.
    expect(citationIds(payload).sort()).toEqual(
      (pointers.items as Array<{ citation_id: string }>)
        .map((item) => item.citation_id)
        .sort(),
    );
  });

  test("the reflex emits no non-pointer section even when the pack could", async () => {
    const { client } = await harness("agent", "dana", {
      rows: [searchRow("a", "alpha")],
    });

    const { payload } = await callJson(client, "agent_reflex_pointers", {
      ...SCOPE,
      query: "needle",
    });

    // It is a pointer reflex; a durable body arriving here would defeat the
    // entire reason the surface exists.
    expect(payload).not.toHaveProperty("sections");
    expect(payload).not.toHaveProperty("durable_memory");
  });

  test("an auth denial passes through unchanged rather than inventing a message", async () => {
    const { client } = await harness("agent", "dana");

    const { payload, isError } = await callJson(client, "agent_reflex_pointers", {
      ...SCOPE,
      namespace: "someone-else",
      query: "needle",
    });

    expect(isError).toBe(true);
    expect(payload.error).toBe(
      "Permission denied: cannot read namespace 'someone-else'",
    );
  });

  test("prior-context suppression applies before any pointer is emitted", async () => {
    const { client } = await harness("agent", "dana", {
      rows: [searchRow("a", "alpha"), searchRow("b", "bravo")],
    });

    const { payload } = await callJson(client, "agent_reflex_pointers", {
      ...SCOPE,
      query: "needle",
      prior_context: [{ citation_id: "brain_record:thought:a" }],
    });

    const pointers = payload.pointers as Record<string, unknown>;
    expect(
      (pointers.items as Array<{ citation_id: string }>).map(
        (item) => item.citation_id,
      ),
    ).toEqual(["brain_record:thought:b"]);
  });
});
