import { describe, expect, it } from "vitest";
import {
  ALL_PRIMARY_IDS,
  ALLOCATION_ORDER,
  assertContentFree,
  canonical,
  citationsFor,
  pointerFor,
  reflexPayload,
  run,
  serverId,
} from "./reflex-ab-gate-support.ts";

// Citation-multiplicity bijection and the per-arm EVAL-3 functional bar for
// runReflexAbGate (REFLEX-4, #335). The A/B contrast and stability control live
// in the sibling reflex-ab-gate.test.ts; isolation, the cross-namespace denial
// control, and teardown discipline live in reflex-ab-gate-isolation.test.ts.
// Shared fakes and fixtures are in reflex-ab-gate-support.ts.

describe("runReflexAbGate citation multiplicity bijection", () => {
  it("accepts an identity emitted and cited with equal multiplicity (>1)", async () => {
    // Emit known-a twice (same identity) and cite it twice: emitted count ==
    // cited count per identity, so the bijection must hold even though the old
    // Math.max(-1) logic wrongly flagged a legitimate equal-multiplicity pair.
    const dupPointer = pointerFor("known-a");
    const off = reflexPayload([...ALL_PRIMARY_IDS], {
      extraPointer: dupPointer,
      // known-a cited twice (once for each emitted copy); everything else once.
      citations: [
        ...citationsFor([...ALL_PRIMARY_IDS]),
        { id: canonical("thought", serverId("known-a")), kind: "pointer" },
      ],
    });
    const { outcome } = run({ offPayload: off, controlPayload: off });
    const { receipt } = await outcome;
    expect(receipt.arm_off.citations_bijective).toBe(true);
    expect(receipt.arm_off.dangling_citations).toBe(0);
    expect(receipt.arm_off.uncited_pointers).toBe(0);
  });

  it("fails when an identity is emitted twice but cited once (uncited surplus)", async () => {
    const dupPointer = pointerFor("known-a");
    const off = reflexPayload([...ALL_PRIMARY_IDS], {
      extraPointer: dupPointer,
      // known-a emitted twice but cited ONLY once: emitted=2, cited=1 -> one
      // uncited surplus. The old lenient logic tolerated this off-by-one.
      citations: citationsFor([...ALL_PRIMARY_IDS]),
    });
    const { outcome } = run({ offPayload: off, controlPayload: off });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.citations_bijective).toBe(false);
    expect(receipt.arm_off.uncited_pointers).toBe(1);
    expect(receipt.arm_off.dangling_citations).toBe(0);
  });

  it("fails when an identity is cited twice but emitted once (dangling surplus)", async () => {
    // known-a emitted once but cited TWICE: cited=2, emitted=1 -> one dangling.
    const off = reflexPayload([...ALL_PRIMARY_IDS], {
      citations: [
        ...citationsFor([...ALL_PRIMARY_IDS]),
        { id: canonical("thought", serverId("known-a")), kind: "pointer" },
      ],
    });
    const { outcome } = run({ offPayload: off, controlPayload: off });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.citations_bijective).toBe(false);
    expect(receipt.arm_off.dangling_citations).toBe(1);
    expect(receipt.arm_off.uncited_pointers).toBe(0);
  });
});

describe("runReflexAbGate EVAL-3 functional bar per arm", () => {
  it("fails when a pointer carries a body-bearing field (leakage)", async () => {
    const leaky = pointerFor("netnew-a");
    leaky.content = "netnew a handoff checkpoint body";
    const off = reflexPayload(["known-a", "known-b", "netnew-b"], {
      extraPointer: leaky,
    });
    const { outcome } = run({ offPayload: off });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.body_free).toBe(false);
    expect(receipt.failures.some((f) => f.includes("body-bearing"))).toBe(true);
    // The leaked body content never lands in the receipt.
    assertContentFree(receipt);
  });

  it("fails when placement is not client_owned (implicit injection)", async () => {
    const off = reflexPayload([...ALL_PRIMARY_IDS], {
      placement: "meta_injected",
    });
    const { outcome } = run({ offPayload: off });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.placement_client_owned).toBe(false);
    expect(receipt.failures.some((f) => f.includes("client_owned"))).toBe(true);
  });

  it("fails on a dangling citation with no emitted pointer", async () => {
    const off = reflexPayload([...ALL_PRIMARY_IDS]);
    off.citations = [
      ...off.citations,
      { id: "brain_record:thought:ghost", kind: "pointer" },
    ];
    const { outcome } = run({ offPayload: off });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.dangling_citations).toBe(1);
    expect(receipt.arm_off.citations_bijective).toBe(false);
  });

  it("fails on an uncited emitted pointer", async () => {
    const off = reflexPayload([...ALL_PRIMARY_IDS]);
    off.citations = off.citations.slice(0, 3);
    const { outcome } = run({ offPayload: off });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.uncited_pointers).toBe(1);
    expect(receipt.arm_off.citations_bijective).toBe(false);
  });

  it("fails when serialized pointers exceed the whole-pack limit", async () => {
    const off = reflexPayload([...ALL_PRIMARY_IDS]);
    const serialized = JSON.stringify(off.pointers).length;
    off.budget = {
      whole_pack: {
        content_char_limit: serialized - 10,
        content_chars_used: serialized,
        allocation_order: [...ALLOCATION_ORDER],
      },
    };
    const { outcome } = run({ offPayload: off });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.budget.within_budget).toBe(false);
  });

  it("fails when the whole-pack allocation order is incomplete", async () => {
    const off = reflexPayload([...ALL_PRIMARY_IDS]);
    const serialized = JSON.stringify(off.pointers).length;
    off.budget = {
      whole_pack: {
        content_char_limit: serialized + 500,
        content_chars_used: serialized,
        allocation_order: ["pointers"],
      },
    };
    const { outcome } = run({ offPayload: off });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.budget.allocation_order_complete).toBe(false);
  });

  it("fails when no whole-pack budget block is reported at all", async () => {
    const off = reflexPayload([...ALL_PRIMARY_IDS]);
    off.budget = { requested: { max_tokens: 6000 } };
    const { outcome } = run({ offPayload: off });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.budget.content_char_limit).toBeNull();
    expect(receipt.arm_off.budget.within_budget).toBe(false);
  });
});
