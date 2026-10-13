import { describe, expect, it } from "vitest";
import { expectDefined } from "../../../../scripts/test-support/expect-defined.ts";
import type { ContextPackPayload } from "../transport.ts";
import {
  assertContentFree,
  canonical,
  CONFIG,
  FIXTURE,
  goodPayload,
  run,
  serverId,
} from "./complete-pack-gate-support.ts";

// Regression suites for the review findings on runCompletePackGate (issue #330):
// the durable_lane_context events/lane walkers, occurrence-count citation
// bijection, every-expected-recall, the populated-section denial + reason
// allowlist, and reason/status sentinel sanitization. The happy path and the
// core property suites live in the sibling complete-pack-gate.test.ts; shared
// fakes and fixtures are in complete-pack-gate-support.ts.

const LANE_ID = "lane-uuid-777";
const EVENT_A_ID = "event-uuid-111";
const EVENT_B_ID = "event-uuid-222";
const LANE_CITATION_ID = `session_lane:${LANE_ID}`;
const EVENT_A_CITATION = `session_event:${EVENT_A_ID}`;
const EVENT_B_CITATION = `session_event:${EVENT_B_ID}`;

/**
 * The durable_lane_context body for a populated exact-scope lane WITH events,
 * each citing itself via session_event:<id>, exactly as
 * server/tools/agent-context-pack-durable-lane.ts emits it.
 */
function populatedLaneSection(leakEventSourceRef?: string): Record<string, unknown> {
  return {
    label: "durable_lane_context",
    exact_scope_required: true,
    lane: {
      id: LANE_ID,
      session_key: "eval:complete-pack:v1",
      status: "active",
      citation_id: LANE_CITATION_ID,
    },
    events: [
      {
        id: EVENT_A_ID,
        event_type: "decision",
        content: "lane event a body",
        citation_id: EVENT_A_CITATION,
        source_ref: leakEventSourceRef ?? `ob_session_events/${EVENT_A_ID}`,
      },
      {
        id: EVENT_B_ID,
        event_type: "thought",
        content: "lane event b body",
        citation_id: EVENT_B_CITATION,
        source_ref: `ob_session_events/${EVENT_B_ID}`,
      },
    ],
    event_count: 2,
    truncated: false,
  };
}

/**
 * A production-accurate populated-lane payload. No exact_scope scope-denial (the
 * lane exists), so this run exercises the citation bijection over events and
 * lane-scoped leak detection, not overall PASS. The pack cites the lane and
 * every event; dropEventCitations removes the event citations so a test can
 * prove the events themselves are walked (uncited detection).
 */
function populatedLanePayload(
  overrides: {
    leakEventSourceRef?: string;
    dropEventCitations?: boolean;
  } = {},
): ContextPackPayload {
  const payload = goodPayload({
    warnings: {
      // Lane exists -> no exact_scope denial; repo_facts still present-empty.
      scope_denials: [{ source: "repo_facts", reasons: ["no_active_repo"] }],
      degraded_sources: [],
      truncation: [],
    },
    sections: {
      durable_lane_context: populatedLaneSection(overrides.leakEventSourceRef),
    },
  });
  const laneCitation = {
    id: LANE_CITATION_ID,
    kind: "session_lane",
    source_ref: `ob_session_lanes/${LANE_ID}`,
  };
  const laneCitations = overrides.dropEventCitations
    ? [laneCitation]
    : [
        laneCitation,
        {
          id: EVENT_A_CITATION,
          kind: "session_event",
          source_ref: `ob_session_events/${EVENT_A_ID}`,
        },
        {
          id: EVENT_B_CITATION,
          kind: "session_event",
          source_ref: `ob_session_events/${EVENT_B_ID}`,
        },
      ];
  payload.citations = [...payload.citations, ...laneCitations];
  return payload;
}

/** A durable_memory item shaped as the pack emits it, with a chosen citation. */
function durableItem(
  fixtureId: string,
  sourceType: string,
  citationId: string,
): Record<string, unknown> {
  return {
    id: serverId(fixtureId),
    source_type: sourceType,
    namespace: CONFIG.primaryNamespace,
    citation_id: citationId,
    source_ref: {
      source: "brain",
      type: sourceType,
      id: serverId(fixtureId),
      namespace: CONFIG.primaryNamespace,
    },
  };
}

/** A durable_memory section body wrapping the given emitted items. */
function durableSection(
  items: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    label: "durable_memory",
    namespace_scoped: true,
    query: FIXTURE.query,
    items,
    item_count: items.length,
    truncated: false,
  };
}

describe("runCompletePackGate durable_lane_context events/lane walkers (finding #2)", () => {
  it("counts each lane event citation as emitted so a populated lane stays bijective", async () => {
    const { outcome } = run({ payload: populatedLanePayload() });
    const { receipt } = await outcome;
    // The two durable_memory items + lane + two events are all cited: bijective.
    expect(receipt.citations.dangling_citations).toBe(0);
    expect(receipt.citations.uncited_items).toBe(0);
    expect(receipt.citations.bijective).toBe(true);
    // emitted item citations now include the lane and both events.
    expect(receipt.citations.emitted_item_citations).toBe(5);
  });

  it("flags an uncited lane event as a bijection break (events ARE walked)", async () => {
    const { outcome } = run({
      payload: populatedLanePayload({ dropEventCitations: true }),
    });
    const { receipt, passed } = await outcome;
    // Two event citations were dropped but the events are still emitted, so they
    // are now uncited — proving the walker reaches events[], not just items/lane.
    expect(receipt.citations.uncited_items).toBe(2);
    expect(receipt.citations.bijective).toBe(false);
    expect(passed).toBe(false);
  });

  it("detects a forbidden negative id embedded in a lane event source_ref pointer", async () => {
    // A leaked negative record surfacing as an event source_ref pointer must be
    // caught even though it lives on events[], not items[]. Cite it so the ONLY
    // failure is the isolation leak.
    const forbidden = serverId("neg-secret");
    const payload = populatedLanePayload({
      leakEventSourceRef: `ob_session_events/${forbidden}`,
    });
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    expect(receipt.isolation.namespace_leaks).toBeGreaterThanOrEqual(1);
    expect(passed).toBe(false);
    expect(receipt.failures.some((f) => f.includes("isolation breach"))).toBe(true);
    assertContentFree(receipt);
  });

  it("detects a forbidden negative id surfacing as a lane event id", async () => {
    // The forbidden id as an event's own `id` (not a source_ref) is still a leak.
    const forbidden = serverId("neg-secret");
    const payload = goodPayload({
      warnings: {
        scope_denials: [{ source: "repo_facts", reasons: ["no_active_repo"] }],
        degraded_sources: [],
        truncation: [],
      },
      sections: {
        durable_lane_context: {
          label: "durable_lane_context",
          exact_scope_required: true,
          lane: { id: "lane-ok", citation_id: "session_lane:lane-ok" },
          events: [
            {
              id: forbidden,
              event_type: "decision",
              content: "leaked event body",
              citation_id: `session_event:${forbidden}`,
              source_ref: `ob_session_events/${forbidden}`,
            },
          ],
          event_count: 1,
          truncated: false,
        },
      },
    });
    payload.citations = [
      ...payload.citations,
      {
        id: "session_lane:lane-ok",
        kind: "session_lane",
        source_ref: "ob_session_lanes/lane-ok",
      },
      {
        id: `session_event:${forbidden}`,
        kind: "session_event",
        source_ref: `ob_session_events/${forbidden}`,
      },
    ];
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    expect(receipt.isolation.namespace_leaks).toBeGreaterThanOrEqual(1);
    expect(passed).toBe(false);
    assertContentFree(receipt);
  });
});

describe("runCompletePackGate citation occurrence-count bijection (terminal finding #1)", () => {
  it("flags TWO distinct emitted units sharing ONE citation_id (set-based would pass)", async () => {
    // Two DISTINCT durable_memory items carry the SAME citation_id. A single
    // top-level citation for that id cannot cite both units. The old set-based
    // bijection collapsed both emitted occurrences to one member and matched the
    // single citation -> false PASS. Occurrence counting sees 2 emitted vs 1
    // cited for that id -> 1 uncited, not bijective.
    const shared = canonical("thought", serverId("prim-a"));
    const payload = goodPayload({
      sections: {
        durable_memory: durableSection([
          durableItem("prim-a", "thought", shared),
          // A distinct unit (different server id) reusing prim-a's citation_id.
          durableItem("prim-b", "decision", shared),
        ]),
      },
      // Exactly ONE top-level citation for the shared id.
      citations: [{ id: shared, kind: "brain_record" }],
    });
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    // 2 emitted occurrences of the shared id, 1 cited -> 1 uncited occurrence.
    expect(receipt.citations.emitted_item_citations).toBe(2);
    expect(receipt.citations.uncited_items).toBe(1);
    expect(receipt.citations.bijective).toBe(false);
    expect(passed).toBe(false);
    assertContentFree(receipt);
  });

  it("still rejects matching duplicate counts when two units share one citation identity", async () => {
    const shared = canonical("thought", serverId("prim-a"));
    const payload = goodPayload({
      sections: {
        durable_memory: durableSection([
          durableItem("prim-a", "thought", shared),
          durableItem("prim-b", "decision", shared),
        ]),
      },
      // Repeating the same top-level id does not make the identity bijective:
      // two distinct emitted units still cannot share one citation identity.
      citations: [
        { id: shared, kind: "brain_record" },
        { id: shared, kind: "brain_record" },
      ],
    });
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    expect(receipt.citations.emitted_item_citations).toBe(2);
    expect(receipt.citations.uncited_items).toBe(1);
    expect(receipt.citations.dangling_citations).toBe(1);
    expect(receipt.citations.bijective).toBe(false);
    expect(passed).toBe(false);
    assertContentFree(receipt);
  });

  it("flags a DUPLICATE top-level citation occurrence for one emitted unit (set-based would pass)", async () => {
    // One emitted durable_memory item, but its citation_id appears TWICE in the
    // top-level citations array. The old set-based check deduped the two
    // citations to one member and matched -> false PASS. Occurrence counting
    // sees 1 emitted vs 2 cited -> 1 dangling surplus, not bijective.
    const payload = goodPayload();
    const firstCitation = expectDefined(payload.citations[0], "first emitted citation");
    payload.citations = [...payload.citations, { ...firstCitation }];
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    expect(receipt.citations.dangling_citations).toBe(1);
    expect(receipt.citations.bijective).toBe(false);
    expect(passed).toBe(false);
    assertContentFree(receipt);
  });
});

describe("runCompletePackGate every-expected-recall (terminal finding #2)", () => {
  it("fails when only ONE of the two expected recall ids surfaces (one-of-many)", async () => {
    // durable_memory surfaces ONLY prim-a; prim-b (also expected) never recalls.
    // The old "any one expected id present" check passed because prim-a appeared;
    // requiring EVERY expected id catches the missing prim-b as a partial-recall
    // defect. Citations kept bijective (only prim-a cited) so the ONLY failure is
    // the incomplete expected recall.
    const payload = goodPayload({
      sections: {
        durable_memory: durableSection([
          durableItem("prim-a", "thought", canonical("thought", serverId("prim-a"))),
        ]),
      },
      citations: [
        {
          id: canonical("thought", serverId("prim-a")),
          kind: "brain_record",
          source_ref: {
            source: "brain",
            type: "thought",
            id: serverId("prim-a"),
          },
        },
      ],
    });
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    // The section is fine and prim-a surfaced, but prim-b did not.
    expect(receipt.citations.bijective).toBe(true);
    expect(receipt.isolation.expected_recall_present).toBe(false);
    expect(passed).toBe(false);
    expect(receipt.failures.some((f) => f.includes("hollow recall"))).toBe(true);
    assertContentFree(receipt);
  });
});

describe("runCompletePackGate populated-section denial + reason allowlist (terminal finding #3)", () => {
  it("fails a POPULATED section that also claims a scope-denial for itself (forged denial)", async () => {
    // durable_lane_context is emitted with items AND its exact_scope denial is
    // present. A denial must agree with an actually empty/omitted section; a
    // populated section claiming denial is forged/stale. The old classifier
    // returned "items" and passed the section, letting the contradictory denial
    // stand; now the populated-with-denial case fails the section.
    const payload = goodPayload({
      sections: {
        durable_lane_context: {
          label: "durable_lane_context",
          exact_scope_required: true,
          items: [
            {
              id: "lane-item-1",
              source_type: "session_event",
              citation_id: "session_event:lane-item-1",
              source_ref: "ob_session_events/lane-item-1",
            },
          ],
          item_count: 1,
          truncated: false,
        },
      },
      // The denial is retained for durable_lane_context even though it is now
      // populated -- the contradiction the gate must catch.
      warnings: {
        scope_denials: [
          { source: "durable_lane_context", reasons: ["exact_scope"] },
          { source: "repo_facts", reasons: ["no_active_repo"] },
        ],
        degraded_sources: [],
        truncation: [],
      },
    });
    payload.citations = [
      ...payload.citations,
      { id: "session_event:lane-item-1", kind: "session_event" },
    ];
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    const lane = expectDefined(
      receipt.sections.find((s) => s.section === "durable_lane_context"),
      "durable_lane_context section",
    );
    expect(lane.has_items).toBe(true);
    expect(lane.defined_empty).toBe(false);
    expect(
      receipt.failures.some(
        (f) => f.includes("durable_lane_context") && f.includes("populated"),
      ),
    ).toBe(true);
    expect(passed).toBe(false);
    assertContentFree(receipt);
  });

  it("rejects an omitted section 'explained' by an ARBITRARY non-allowlisted denial reason", async () => {
    // candidate_memory is dropped and 'explained' by a made-up scope-denial
    // reason that is NOT in candidate_memory's allowlist (candidate_memory has no
    // allowed scope-denial reasons at all). The old classifier accepted any
    // source-matched denial and marked it defined-empty; the allowlist now
    // rejects the arbitrary reason so the omitted section fails.
    const payload = goodPayload({
      dropSection: "candidate_memory",
      warnings: {
        scope_denials: [
          { source: "durable_lane_context", reasons: ["exact_scope"] },
          { source: "repo_facts", reasons: ["no_active_repo"] },
          {
            source: "candidate_memory",
            reasons: ["totally_made_up_reason"],
          },
        ],
        degraded_sources: [],
        truncation: [],
      },
    });
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    const candidate = expectDefined(
      receipt.sections.find((s) => s.section === "candidate_memory"),
      "candidate_memory section",
    );
    expect(candidate.present).toBe(false);
    expect(candidate.defined_empty).toBe(false);
    expect(passed).toBe(false);
    assertContentFree(receipt);
  });
});

describe("runCompletePackGate reason/status sentinel sanitization (terminal finding #4)", () => {
  it("never echoes a malicious server reason into a section disposition", async () => {
    // repo_facts present-empty but its scope-denial reason carries an injected
    // sentinel. definedScopeDenialReasons only returns allowlisted reasons, so
    // this unrecognized reason yields null -> the present-empty repo_facts falls
    // through to the unmarked-empty defect (generic disposition), and the raw
    // sentinel never lands in the receipt.
    const sentinel = "SENTINEL_LEAK_marlin cache body";
    const payload = goodPayload({
      warnings: {
        scope_denials: [
          { source: "durable_lane_context", reasons: ["exact_scope"] },
          { source: "repo_facts", reasons: [sentinel] },
        ],
        degraded_sources: [],
        truncation: [],
      },
    });
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    const repoFacts = expectDefined(
      receipt.sections.find((s) => s.section === "repo_facts"),
      "repo_facts section",
    );
    // The arbitrary reason is NOT accepted as a defined denial; disposition is a
    // finite generic label, never the raw sentinel string.
    expect(repoFacts.defined_empty).toBe(false);
    expect(repoFacts.disposition).not.toContain("SENTINEL_LEAK");
    expect(JSON.stringify(receipt)).not.toContain("SENTINEL_LEAK");
    expect(passed).toBe(false);
    assertContentFree(receipt);
  });

  it("sanitizes a malicious pack status to a finite label in the failures list", async () => {
    // A non-ok status that carries an injected sentinel/body must be reduced to a
    // finite allowlisted label (or the fixed generic) before entering failures.
    const payload = goodPayload({
      status: "error: leaked marlin cache body SENTINEL_STATUS",
    });
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    const statusFailure = receipt.failures.find((f) => f.includes("pack status is"));
    expect(statusFailure).toBeDefined();
    expect(statusFailure).toContain("'unrecognized'");
    expect(statusFailure).not.toContain("SENTINEL_STATUS");
    expect(statusFailure).not.toContain("marlin cache body");
    expect(JSON.stringify(receipt)).not.toContain("SENTINEL_STATUS");
    assertContentFree(receipt);
  });
});
