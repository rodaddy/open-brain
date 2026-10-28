import { describe, expect, it } from "vitest";
import { expectDefined } from "../../../../scripts/test-support/expect-defined.ts";
import { COMPLETE_PACK_SECTION_NAMES } from "../complete-pack-types.ts";
import { LiveTransportError } from "../transport.ts";
import { expectTransportError } from "./transport-test-support.ts";
import {
  assertContentFree,
  canonical,
  CONFIG,
  FIXTURE,
  goodPayload,
  run,
  serverId,
} from "./complete-pack-gate-support.ts";

// Orchestrator tests for runCompletePackGate (issue #330): the happy path,
// presence-or-defined-emptiness, citation truth, the serialized whole-pack
// allowance, exact-scope isolation, and teardown discipline. The lane-walker,
// occurrence-count, and sanitization suites live in the sibling
// complete-pack-gate-findings.test.ts. Shared fakes and fixtures are in
// complete-pack-gate-support.ts.

describe("runCompletePackGate happy path", () => {
  it("verifies all six properties, tears down, and reports PASS", async () => {
    const { outcome, state } = run();
    const { receipt, passed } = await outcome;

    expect(passed).toBe(true);
    expect(receipt.failures).toEqual([]);
    expect(receipt.seeded).toEqual({ primary: 2, negative: 1 });

    // 1. Every requested section is present or defined-empty.
    for (const name of COMPLETE_PACK_SECTION_NAMES) {
      const v = expectDefined(
        receipt.sections.find((s) => s.section === name),
        `section ${name}`,
      );
      expect(v.has_items || v.defined_empty).toBe(true);
    }
    // durable_memory carried items; the RAM-only + guidance sections are empty.
    const durable = expectDefined(
      receipt.sections.find((s) => s.section === "durable_memory"),
      "durable_memory section",
    );
    expect(durable.has_items).toBe(true);
    expect(durable.item_count).toBe(2);
    const candidate = expectDefined(
      receipt.sections.find((s) => s.section === "candidate_memory"),
      "candidate_memory section",
    );
    expect(candidate.disposition).toBe("candidate_predicate_unavailable");
    // repo_facts is present-empty with a no_active_repo denial: its disposition
    // is that ACTUAL reason, never the hardcoded exact_scope (finding #3).
    const repoFacts = expectDefined(
      receipt.sections.find((s) => s.section === "repo_facts"),
      "repo_facts section",
    );
    expect(repoFacts.present).toBe(true);
    expect(repoFacts.defined_empty).toBe(true);
    expect(repoFacts.disposition).toBe("no_active_repo");

    // 2. Isolation.
    expect(receipt.isolation.exact_scope_denied).toBe(true);
    expect(receipt.isolation.namespace_leaks).toBe(0);
    expect(receipt.isolation.expected_recall_present).toBe(true);

    // 6. Explicit cross-namespace denial ran and was denied, and the probe
    // targeted the NEGATIVE namespace with the PRIMARY caller.
    expect(receipt.negative_control.ran).toBe(true);
    expect(receipt.negative_control.denied).toBe(true);
    expect(receipt.negative_control.observed_hit_count).toBe(0);
    expect(state.attemptReadNamespaces).toEqual([CONFIG.negativeNamespace]);
    expect(state.attemptReadNamespaces).not.toContain(CONFIG.primaryNamespace);

    // 3. Citation bijection.
    expect(receipt.citations.bijective).toBe(true);
    expect(receipt.citations.dangling_citations).toBe(0);
    expect(receipt.citations.uncited_items).toBe(0);

    // 4. Serialized whole-pack allowance respected with a complete order.
    expect(receipt.budget.within_budget).toBe(true);
    expect(receipt.budget.allocation_order_complete).toBe(true);

    // 5. Per-section contribution recorded.
    for (const v of receipt.sections) {
      expect(typeof v.serialized_chars).toBe("number");
    }

    // The pack was built under the PRIMARY throwaway namespace (isolation seam).
    expect(state.packScopes.length).toBe(1);
    expect(expectDefined(state.packScopes[0], "first pack scope").namespace).toBe(
      CONFIG.primaryNamespace,
    );

    // Teardown archived exactly the 3 seeded records.
    expect(receipt.teardown).toEqual({
      attempted: 3,
      archived: 3,
      already_absent: 0,
      failed: 0,
    });
    assertContentFree(receipt);
  });
});

describe("runCompletePackGate presence-or-defined-emptiness", () => {
  it("fails when a requested section is missing with no defined denial/degrade", async () => {
    // Drop candidate_memory entirely and remove any warning explaining it.
    const payload = goodPayload({
      dropSection: "candidate_memory",
      warnings: {
        scope_denials: [{ source: "durable_lane_context", reasons: ["exact_scope"] }],
        degraded_sources: [],
        truncation: [],
      },
    });
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    const v = expectDefined(
      receipt.sections.find((s) => s.section === "candidate_memory"),
      "candidate_memory section",
    );
    expect(v.present).toBe(false);
    expect(v.defined_empty).toBe(false);
    expect(receipt.failures.some((f) => f.includes("candidate_memory"))).toBe(true);
  });

  it("accepts a section omitted but explained by a degraded-source", async () => {
    const payload = goodPayload({
      dropSection: "durable_memory",
      warnings: {
        scope_denials: [
          { source: "durable_lane_context", reasons: ["exact_scope"] },
          { source: "profile_guidance", reasons: ["no_promoted_guidance"] },
          { source: "process_guidance", reasons: ["no_promoted_guidance"] },
          { source: "repo_facts", reasons: ["no_active_repo"] },
        ],
        degraded_sources: [{ source: "durable_memory", reason: "recall_failed" }],
        truncation: [],
      },
      // With durable dropped, no items, no citations, no expected recall.
      citations: [],
    });
    const { outcome } = run({ payload });
    const { receipt } = await outcome;
    const v = expectDefined(
      receipt.sections.find((s) => s.section === "durable_memory"),
      "durable_memory section",
    );
    expect(v.defined_empty).toBe(true);
    expect(v.disposition).toBe("recall_failed");
    // Expected recall is now absent -> the run still FAILS on the hollow-recall
    // guard even though the section itself is defined-empty.
    expect(receipt.isolation.expected_recall_present).toBe(false);
    expect(receipt.passed).toBe(false);
  });

  it("fails a present-but-empty section with no recognized empty marker", async () => {
    // durable_memory present, zero items, and NO empty_reason: an unmarked empty
    // is a defect (it does not truthfully state why it is empty).
    const payload = goodPayload({
      sections: {
        durable_memory: {
          label: "durable_memory",
          namespace_scoped: true,
          query: FIXTURE.query,
          items: [],
          item_count: 0,
          truncated: false,
        },
      },
      citations: [],
    });
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    const v = expectDefined(
      receipt.sections.find((s) => s.section === "durable_memory"),
      "durable_memory section",
    );
    expect(v.present).toBe(true);
    expect(v.has_items).toBe(false);
    expect(v.defined_empty).toBe(false);
    expect(passed).toBe(false);
  });
});

describe("runCompletePackGate citation truth", () => {
  it("fails on a dangling citation referencing no emitted item", async () => {
    const payload = goodPayload();
    payload.citations = [
      ...payload.citations,
      { id: "brain_record:thought:ghost", kind: "brain_record" },
    ];
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.citations.dangling_citations).toBe(1);
    expect(receipt.citations.bijective).toBe(false);
  });

  it("fails on an emitted item with no matching citation", async () => {
    const payload = goodPayload();
    // Drop one citation, leaving its item uncited.
    payload.citations = payload.citations.slice(0, 1);
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.citations.uncited_items).toBe(1);
    expect(receipt.citations.bijective).toBe(false);
  });
});

describe("runCompletePackGate serialized whole-pack allowance", () => {
  it("fails when serialized sections exceed the whole-pack allowance", async () => {
    const payload = goodPayload();
    const serialized = JSON.stringify(payload.sections).length;
    payload.budget = {
      whole_pack: {
        content_char_limit: serialized - 10, // too small to admit the sections
        content_chars_used: serialized,
        allocation_order: [...COMPLETE_PACK_SECTION_NAMES],
      },
    };
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.budget.within_budget).toBe(false);
  });

  it("fails when the whole-pack allocation order is incomplete", async () => {
    const payload = goodPayload();
    const serialized = JSON.stringify(payload.sections).length;
    payload.budget = {
      whole_pack: {
        content_char_limit: serialized + 500,
        content_chars_used: serialized,
        allocation_order: ["working_set", "durable_memory"], // missing seven
      },
    };
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.budget.allocation_order_complete).toBe(false);
  });

  it("fails when no whole-pack allowance block is reported at all", async () => {
    const payload = goodPayload();
    payload.budget = { requested: { max_tokens: 6000 } };
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.budget.content_char_limit).toBeNull();
    expect(receipt.budget.within_budget).toBe(false);
  });
});

describe("runCompletePackGate exact-scope isolation", () => {
  it("fails when a forbidden negative record surfaces in a section item", async () => {
    // Inject the negative seeded server id as a pointer item (a leak).
    const payload = goodPayload({
      sections: {
        pointers: {
          label: "pointers",
          items: [
            {
              id: serverId("neg-secret"),
              source_type: "thought",
              namespace: CONFIG.primaryNamespace,
              citation_id: canonical("thought", serverId("neg-secret")),
              source_ref: {
                source: "brain",
                type: "thought",
                id: serverId("neg-secret"),
              },
            },
          ],
          item_count: 1,
          truncated: false,
        },
      },
    });
    // Add the pointer citation so citation-truth stays clean and the ONLY failure
    // is the isolation leak.
    payload.citations = [
      ...payload.citations,
      {
        id: canonical("thought", serverId("neg-secret")),
        kind: "pointer",
        source_ref: {
          source: "brain",
          type: "thought",
          id: serverId("neg-secret"),
        },
      },
    ];
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.isolation.namespace_leaks).toBe(1);
    expect(receipt.failures.some((f) => f.includes("isolation breach"))).toBe(true);
    assertContentFree(receipt);
  });

  it("fails when durable_lane_context does not report its exact-scope empty", async () => {
    const payload = goodPayload({
      warnings: {
        scope_denials: [
          { source: "repo_facts", reasons: ["no_active_repo"] },
          { source: "profile_guidance", reasons: ["no_promoted_guidance"] },
          { source: "process_guidance", reasons: ["no_promoted_guidance"] },
        ],
        degraded_sources: [],
        truncation: [],
      },
    });
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.isolation.exact_scope_denied).toBe(false);
    expect(receipt.failures.some((f) => f.includes("exact-scope"))).toBe(true);
  });

  it("fails when the expected primary recall does not surface (hollow recall)", async () => {
    // durable_memory present-and-empty with a truthful no_matches reason, so the
    // section itself is defined-empty, but the expected records never surfaced —
    // a broken predicate would look exactly like this, so the gate fails it.
    const payload = goodPayload({
      sections: {
        durable_memory: {
          label: "durable_memory",
          namespace_scoped: true,
          query: FIXTURE.query,
          items: [],
          item_count: 0,
          empty_reason: "no_matches",
          truncated: false,
        },
      },
      citations: [],
    });
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    const v = expectDefined(
      receipt.sections.find((s) => s.section === "durable_memory"),
      "durable_memory section",
    );
    expect(v.defined_empty).toBe(true); // section is fine on its own
    expect(receipt.isolation.expected_recall_present).toBe(false);
    expect(passed).toBe(false);
    expect(receipt.failures.some((f) => f.includes("hollow recall"))).toBe(true);
  });
});

describe("runCompletePackGate present-empty scope-denial disposition", () => {
  it("labels a present-empty repo_facts with its actual no_active_repo reason, not exact_scope", async () => {
    // Finding #3 false-pass regression: the goodPayload repo_facts is present
    // (repo: null) with a no_active_repo denial. The hardcoded-exact_scope bug
    // would mislabel it; the disposition must be the real reason.
    const { outcome } = run();
    const { receipt } = await outcome;
    const repoFacts = expectDefined(
      receipt.sections.find((s) => s.section === "repo_facts"),
      "repo_facts section",
    );
    expect(repoFacts.present).toBe(true);
    expect(repoFacts.has_items).toBe(false);
    expect(repoFacts.defined_empty).toBe(true);
    expect(repoFacts.disposition).toBe("no_active_repo");
    // durable_lane_context (omitted body) still carries its own exact_scope
    // reason: the two present/absent denials are NOT conflated to one label.
    const lane = expectDefined(
      receipt.sections.find((s) => s.section === "durable_lane_context"),
      "durable_lane_context section",
    );
    expect(lane.disposition).toBe("exact_scope");
  });

  it("joins multiple present-empty denial reasons instead of one hardcoded label", async () => {
    // A present-empty repo_facts reporting two reasons must surface both, proving
    // the disposition is derived from scopeDenial.reasons, not a constant.
    const payload = goodPayload({
      warnings: {
        scope_denials: [
          { source: "durable_lane_context", reasons: ["exact_scope"] },
          {
            source: "repo_facts",
            reasons: ["no_active_repo", "namespace_bound"],
          },
        ],
        degraded_sources: [],
        truncation: [],
      },
    });
    const { outcome } = run({ payload });
    const { receipt } = await outcome;
    const repoFacts = expectDefined(
      receipt.sections.find((s) => s.section === "repo_facts"),
      "repo_facts section",
    );
    expect(repoFacts.disposition).toBe("no_active_repo,namespace_bound");
  });
});

describe("runCompletePackGate cross-namespace denial probe (finding #1)", () => {
  it("passes when the primary caller's read of the negative namespace is denied", async () => {
    const { outcome } = run({ negativeRead: "denied" });
    const { receipt, passed } = await outcome;
    expect(receipt.negative_control.ran).toBe(true);
    expect(receipt.negative_control.denied).toBe(true);
    expect(passed).toBe(true);
  });

  it("FALSE-PASS regression: an allowed-but-empty negative read must FAIL the gate", async () => {
    // The emitted-pack leak walk is clean (no forbidden id surfaced), so the old
    // gate would PASS. But an allowed-but-empty read is not proof of isolation —
    // a forbidden record ranked below the cut looks identical. The denial probe
    // fails the gate closed.
    const { outcome } = run({ negativeRead: "empty" });
    const { receipt, passed } = await outcome;
    expect(receipt.isolation.namespace_leaks).toBe(0); // walk is clean...
    expect(receipt.negative_control.ran).toBe(true);
    expect(receipt.negative_control.denied).toBe(false); // ...but read was allowed
    expect(receipt.negative_control.observed_hit_count).toBe(0);
    expect(passed).toBe(false);
    expect(
      receipt.failures.some((f) => f.includes("negative-control not denied")),
    ).toBe(true);
    assertContentFree(receipt);
  });

  it("fails when the primary caller is permitted a NON-empty read of the negative namespace", async () => {
    const { outcome } = run({ negativeRead: "leak" });
    const { receipt, passed } = await outcome;
    expect(receipt.negative_control.denied).toBe(false);
    expect(receipt.negative_control.observed_hit_count).toBe(1);
    expect(passed).toBe(false);
    expect(
      receipt.failures.some((f) => f.includes("negative-control not denied")),
    ).toBe(true);
  });

  it("fails the proof (denied=false) without throwing when the probe read errors", async () => {
    // A non-denial transport error means the proof could not be established;
    // probeNegativeControl catches it and reports denied=false with a redacted
    // failure label, so the gate does NOT throw but still fails closed.
    const { outcome } = run({ negativeRead: "throws" });
    const { receipt, passed } = await outcome;
    expect(receipt.negative_control.ran).toBe(true);
    expect(receipt.negative_control.denied).toBe(false);
    expect(receipt.negative_control.failure).toContain("negative-control read failed");
    expect(passed).toBe(false);
    assertContentFree(receipt);
  });
});

describe("runCompletePackGate teardown discipline", () => {
  it("tears down seeded records even when the pack call throws", async () => {
    const { outcome, state } = run({ packThrows: true });
    await expect(outcome).rejects.toThrow(LiveTransportError);
    expect(state.archived.length).toBe(3);
  });

  it("tears down the records seeded so far when seeding fails partway", async () => {
    const { outcome, state } = run({ seedFailFor: ["neg-secret"] });
    await expect(outcome).rejects.toThrow(LiveTransportError);
    expect(state.archived.sort()).toEqual(["srv-prim-a", "srv-prim-b"].sort());
  });

  it("preserves the content-free teardown failed count on a deferred error", async () => {
    const { outcome } = run({ packThrows: true, archiveFailFor: ["prim-a"] });
    const err = expectTransportError(
      await outcome.catch((e) => e as LiveTransportError),
    );
    expect(err).toBeInstanceOf(LiveTransportError);
    expect(err.label).toBe("agent_context_pack:timeout;teardown-failed=1");
    expect(err.label).not.toContain("srv-");
    expect(err.label).not.toContain("body");
  });

  it("fails the gate (never PASS) when a teardown archive fails", async () => {
    const { outcome } = run({ archiveFailFor: ["prim-a"] });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.teardown.failed).toBe(1);
    expect(receipt.failures.some((f) => f.includes("teardown failed to archive"))).toBe(
      true,
    );
    assertContentFree(receipt);
  });
});
