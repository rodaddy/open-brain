import { describe, expect, it } from "vitest";
import { expectDefined } from "../../../../scripts/test-support/expect-defined.ts";
import {
  ALL_PRIMARY_IDS,
  assertContentFree,
  canonical,
  CONFIG,
  reflexPayload,
  run,
  serverId,
} from "./reflex-ab-gate-support.ts";

// The core A/B contrast suites for runReflexAbGate (REFLEX-4, #335): the happy
// path, the suppression contrast, and the stability control that makes the
// contrast attributable. Citation bijection and the per-arm EVAL-3 functional
// bar live in the sibling reflex-ab-gate-bijection.test.ts; isolation, the
// cross-namespace denial control, and teardown discipline live in
// reflex-ab-gate-isolation.test.ts. Shared fakes and fixtures are in
// reflex-ab-gate-support.ts.

describe("runReflexAbGate happy path", () => {
  it("proves suppression returns fewer known items, preserves net-new, and PASSES", async () => {
    const { outcome, state } = run();
    const { receipt, passed } = await outcome;

    expect(passed).toBe(true);
    expect(receipt.failures).toEqual([]);
    expect(receipt.seeded).toEqual({
      primary: 4,
      negative: 1,
      prior_known: 2,
      net_new: 2,
    });

    // OFF arm: all 4 primaries emitted, both known items resurfaced.
    expect(receipt.arm_off.pointer_count).toBe(4);
    expect(receipt.arm_off.redundant_resurfacing).toBe(2);
    expect(receipt.arm_off.net_new_present).toBe(2);
    expect(receipt.arm_off.net_new_missing).toBe(0);
    expect(receipt.arm_off.namespace_leaks).toBe(0);
    expect(receipt.arm_off.citations_bijective).toBe(true);
    expect(receipt.arm_off.body_free).toBe(true);
    expect(receipt.arm_off.placement_client_owned).toBe(true);
    expect(receipt.arm_off.budget.within_budget).toBe(true);
    expect(receipt.arm_off.budget.allocation_order_complete).toBe(true);

    // CONTROL arm (second unsuppressed call): mirrors the OFF baseline exactly,
    // proving the known items resurface stably across two unsuppressed calls.
    expect(receipt.arm_control.pointer_count).toBe(4);
    expect(receipt.arm_control.redundant_resurfacing).toBe(2);
    expect(receipt.arm_control.net_new_present).toBe(2);
    expect(receipt.arm_control.net_new_missing).toBe(0);

    // ON arm: both known items suppressed, net-new preserved.
    expect(receipt.arm_on.pointer_count).toBe(2);
    expect(receipt.arm_on.redundant_resurfacing).toBe(0);
    expect(receipt.arm_on.net_new_present).toBe(2);
    expect(receipt.arm_on.net_new_missing).toBe(0);

    // A/B comparison: the REFLEX-4 acceptance signal.
    expect(receipt.comparison.known_resurfaced_off).toBe(2);
    expect(receipt.comparison.known_resurfaced_control).toBe(2);
    expect(receipt.comparison.known_resurfaced_on).toBe(0);
    expect(receipt.comparison.known_suppressed_delta).toBe(2);
    expect(receipt.comparison.fewer_known_when_enabled).toBe(true);
    // Stability control: OFF and CONTROL resurfaced the SAME non-vacuous set.
    expect(receipt.comparison.known_resurfacing_stable).toBe(true);
    expect(receipt.comparison.stable_known_count).toBe(2);
    // Reference-coverage control: a non-empty prior_context that exactly covers
    // the OFF arm's emitted known set was sent to the ON arm.
    expect(receipt.comparison.references_sent).toBe(2);
    expect(receipt.comparison.references_cover_off_known).toBe(true);
    expect(receipt.comparison.net_new_preserved).toBe(2);
    expect(receipt.comparison.net_new_preserved_on_both).toBe(true);

    // Only the ON arm (third call) received prior_context; both unsuppressed
    // arms (OFF, CONTROL) sent none.
    expect(state.priorContextByCall.length).toBe(3);
    expect(state.priorContextByCall[0]).toBeUndefined();
    expect(state.priorContextByCall[1]).toBeUndefined();
    const onPriorContext = expectDefined(
      state.priorContextByCall[2],
      "ON arm prior_context",
    );
    expect(onPriorContext.length).toBe(2);
    const byCodePoint = (a: string, b: string) => a.localeCompare(b);
    const sentCitations = onPriorContext
      .map((r, i) => expectDefined(r.citation_id, `prior_context[${i}] id`))
      .sort(byCodePoint);
    expect(sentCitations).toEqual(
      [
        canonical("thought", serverId("known-a")),
        canonical("decision", serverId("known-b")),
      ].sort(byCodePoint),
    );

    // Cross-namespace denial ran and denied, probing the NEGATIVE namespace.
    expect(receipt.negative_control.ran).toBe(true);
    expect(receipt.negative_control.denied).toBe(true);
    expect(state.attemptReadNamespaces).toEqual([CONFIG.negativeNamespace]);

    // All three reflex calls ran under the PRIMARY throwaway namespace.
    expect(state.reflexScopes.length).toBe(3);
    for (const s of state.reflexScopes) {
      expect(s.namespace).toBe(CONFIG.primaryNamespace);
    }

    // Teardown archived exactly the 5 seeded records.
    expect(receipt.teardown).toEqual({
      attempted: 5,
      archived: 5,
      already_absent: 0,
      failed: 0,
    });
    assertContentFree(receipt);
  });
});

describe("runReflexAbGate A/B contrast", () => {
  it("fails when suppression enabled still resurfaces a known item (broken suppression)", async () => {
    const { outcome } = run({ onIgnoresPriorContext: true });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.comparison.known_resurfaced_on).toBe(2);
    expect(receipt.comparison.fewer_known_when_enabled).toBe(false);
    expect(receipt.failures.some((f) => f.includes("already-known item"))).toBe(true);
    assertContentFree(receipt);
  });

  it("fails vacuously when the OFF arm resurfaced no known items (nothing to suppress)", async () => {
    // OFF arm emits only net-new: the known items never surfaced, so the contrast
    // has nothing to prove. Both arms would look 'equal' on known items -> fail.
    const offOnlyNetNew = reflexPayload(["netnew-a", "netnew-b"]);
    const { outcome } = run({
      offPayload: offOnlyNetNew,
      onPayload: reflexPayload(["netnew-a", "netnew-b"]),
    });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.comparison.known_resurfaced_off).toBe(0);
    expect(receipt.failures.some((f) => f.includes("vacuous"))).toBe(true);
  });

  it("fails when suppression drops a net-new item (over-suppression)", async () => {
    // ON arm drops a net-new pointer as well as the known ones — net-new must be
    // preserved on both arms.
    const { outcome } = run({
      onPayload: reflexPayload(["netnew-a"]), // netnew-b missing
    });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_on.net_new_missing).toBe(1);
    expect(receipt.comparison.net_new_preserved_on_both).toBe(false);
    expect(receipt.failures.some((f) => f.includes("net-new evidence"))).toBe(true);
  });

  it("fails when a net-new item is missing on the OFF arm (hollow recall)", async () => {
    const { outcome } = run({
      offPayload: reflexPayload(["known-a", "known-b", "netnew-a"]),
    });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.net_new_missing).toBe(1);
    expect(receipt.failures.some((f) => f.includes("net-new record(s) missing"))).toBe(
      true,
    );
  });
});

describe("runReflexAbGate stability control", () => {
  it("fails when the unsuppressed control arm resurfaces a DIFFERENT known set (variable recall)", async () => {
    // OFF resurfaces both known items; the CONTROL replay resurfaces only one of
    // them. A variable recall dropped a known item on its own, so the ON arm's
    // zero cannot be attributed to suppression -> the contrast is not sound.
    const { outcome } = run({
      offPayload: reflexPayload([...ALL_PRIMARY_IDS]),
      controlPayload: reflexPayload(["known-a", "netnew-a", "netnew-b"]),
    });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.comparison.known_resurfaced_off).toBe(2);
    expect(receipt.comparison.known_resurfaced_control).toBe(1);
    expect(receipt.comparison.known_resurfacing_stable).toBe(false);
    expect(receipt.comparison.stable_known_count).toBe(0);
    expect(
      receipt.failures.some((f) =>
        f.includes("unsuppressed known resurfacing is not stable"),
      ),
    ).toBe(true);
    assertContentFree(receipt);
  });

  it("fails when a known item is emitted without a resolvable identity (references cannot cover it)", async () => {
    // known-b surfaces on the OFF arm as a body-free pointer but carries NO
    // citation_id and NO structural source_ref, so the gate cannot build a
    // prior_context reference for it. references_sent then does not cover the
    // OFF arm's emitted known set and the suppression contrast is unattributable.
    const strippedKnownB: Record<string, unknown> = {
      id: serverId("known-b"),
      source_type: "decision",
      namespace: CONFIG.primaryNamespace,
      tier: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: null,
    };
    const off = reflexPayload(["known-a", "netnew-a", "netnew-b"], {
      extraPointer: strippedKnownB,
    });
    // The emitted known-b pointer has no citation_id, so it needs no citation to
    // stay bijective; the OFF arm's citations already cover the cited pointers.
    const { outcome } = run({
      offPayload: off,
      controlPayload: off,
    });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    // Both known items resurfaced, but only known-a was referenceable.
    expect(receipt.comparison.known_resurfaced_off).toBe(2);
    expect(receipt.comparison.references_sent).toBe(1);
    expect(receipt.comparison.references_cover_off_known).toBe(false);
    expect(
      receipt.failures.some((f) =>
        f.includes("do not exactly cover the off arm's emitted already-known set"),
      ),
    ).toBe(true);
    assertContentFree(receipt);
  });
});
