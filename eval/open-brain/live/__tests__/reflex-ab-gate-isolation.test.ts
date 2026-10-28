import { describe, expect, it } from "vitest";
import { LiveTransportError } from "../transport.ts";
import { expectTransportError } from "./transport-test-support.ts";
import {
  ALL_PRIMARY_IDS,
  assertContentFree,
  canonical,
  CONFIG,
  reflexPayload,
  run,
  serverId,
} from "./reflex-ab-gate-support.ts";

// Namespace isolation, the cross-namespace denial control, and teardown
// discipline for runReflexAbGate (REFLEX-4, #335). The A/B contrast and
// stability control live in the sibling reflex-ab-gate.test.ts; citation
// bijection and the per-arm EVAL-3 functional bar live in
// reflex-ab-gate-bijection.test.ts. Shared fakes and fixtures are in
// reflex-ab-gate-support.ts.

describe("runReflexAbGate isolation", () => {
  it("fails when a forbidden negative record surfaces as a pointer", async () => {
    // Inject the negative seeded server id as a body-free pointer (a leak). Cite
    // it so the ONLY failure is the isolation breach.
    const negId = serverId("neg-secret");
    const leak = {
      id: negId,
      source_type: "thought",
      namespace: CONFIG.primaryNamespace,
      tier: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: null,
      citation_id: canonical("thought", negId),
      source_ref: { source: "brain", type: "thought", id: negId },
    };
    const off = reflexPayload([...ALL_PRIMARY_IDS], {
      extraPointer: leak,
    });
    const { outcome } = run({ offPayload: off });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.namespace_leaks).toBe(1);
    expect(receipt.failures.some((f) => f.includes("isolation breach"))).toBe(true);
    assertContentFree(receipt);
  });
});

describe("runReflexAbGate cross-namespace denial control", () => {
  it("FALSE-PASS regression: an allowed-but-empty negative read FAILS the gate", async () => {
    const { outcome } = run({ negativeRead: "empty" });
    const { receipt, passed } = await outcome;
    expect(receipt.arm_off.namespace_leaks).toBe(0);
    expect(receipt.negative_control.ran).toBe(true);
    expect(receipt.negative_control.denied).toBe(false);
    expect(passed).toBe(false);
    expect(
      receipt.failures.some((f) => f.includes("negative-control not denied")),
    ).toBe(true);
    assertContentFree(receipt);
  });

  it("fails on a permitted non-empty read of the negative namespace", async () => {
    const { outcome } = run({ negativeRead: "leak" });
    const { receipt, passed } = await outcome;
    expect(receipt.negative_control.denied).toBe(false);
    expect(receipt.negative_control.observed_hit_count).toBe(1);
    expect(passed).toBe(false);
  });

  it("fails the proof without throwing when the probe read errors", async () => {
    const { outcome } = run({ negativeRead: "throws" });
    const { receipt, passed } = await outcome;
    expect(receipt.negative_control.ran).toBe(true);
    expect(receipt.negative_control.denied).toBe(false);
    expect(receipt.negative_control.failure).toContain("negative-control read failed");
    expect(passed).toBe(false);
    assertContentFree(receipt);
  });
});

describe("runReflexAbGate teardown discipline", () => {
  it("tears down seeded records even when the OFF reflex call throws", async () => {
    const { outcome, state } = run({ reflexThrowsOn: "off" });
    await expect(outcome).rejects.toThrow(LiveTransportError);
    expect(state.archived.length).toBe(5);
  });

  it("tears down seeded records even when the CONTROL reflex call throws", async () => {
    const { outcome, state } = run({ reflexThrowsOn: "control" });
    await expect(outcome).rejects.toThrow(LiveTransportError);
    expect(state.archived.length).toBe(5);
  });

  it("tears down seeded records even when the ON reflex call throws", async () => {
    const { outcome, state } = run({ reflexThrowsOn: "on" });
    await expect(outcome).rejects.toThrow(LiveTransportError);
    expect(state.archived.length).toBe(5);
  });

  it("tears down records seeded so far when seeding fails partway", async () => {
    const { outcome, state } = run({ seedFailFor: ["neg-secret"] });
    await expect(outcome).rejects.toThrow(LiveTransportError);
    // All four primaries seeded before the negative seed failed.
    const byCodePoint = (a: string, b: string) => a.localeCompare(b);
    expect(state.archived.sort(byCodePoint)).toEqual(
      ["srv-known-a", "srv-known-b", "srv-netnew-a", "srv-netnew-b"].sort(byCodePoint),
    );
  });

  it("preserves the content-free teardown failed count on a deferred error", async () => {
    const { outcome } = run({
      reflexThrowsOn: "off",
      archiveFailFor: ["known-a"],
    });
    const err = expectTransportError(
      await outcome.catch((e) => e as LiveTransportError),
    );
    expect(err).toBeInstanceOf(LiveTransportError);
    expect(err.label).toBe("agent_reflex_pointers:timeout;teardown-failed=1");
    expect(err.label).not.toContain("srv-");
    expect(err.label).not.toContain("body");
  });

  it("fails the gate (never PASS) when a teardown archive fails", async () => {
    const { outcome } = run({ archiveFailFor: ["known-a"] });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.teardown.failed).toBe(1);
    expect(receipt.failures.some((f) => f.includes("teardown failed to archive"))).toBe(
      true,
    );
    assertContentFree(receipt);
  });
});
