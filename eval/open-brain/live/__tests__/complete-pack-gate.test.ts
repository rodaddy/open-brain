import { describe, expect, it } from "bun:test";
import {
  runCompletePackGate,
  type CompletePackGateClients,
} from "../complete-pack-gate.ts";
import { COMPLETE_PACK_SECTION_NAMES } from "../complete-pack-types.ts";
import type { CompletePackFixture } from "../complete-pack-types.ts";
import type { LiveEvalConfig } from "../config.ts";
import {
  LiveTransportError,
  type ContextPackPayload,
  type ContextPackScope,
  type OpenBrainLiveClient,
} from "../transport.ts";

// Orchestrator tests for runCompletePackGate (issue #330). These drive a
// structural fake at the OpenBrainLiveClient seam so no hosted server is
// touched. They assert FUNCTIONAL OUTCOMES of the assembled pack — presence or
// defined emptiness of each of the nine sections, exact-scope isolation,
// citation bijection, serialized whole-pack budget, per-section contribution,
// and teardown discipline — never SQL shape or internal call counts. The
// receipt is proven content-free: only ids, namespaces, counts, booleans.

const CONFIG: LiveEvalConfig = {
  baseUrl: "http://127.0.0.1:3100",
  primaryToken: "primary-token",
  negativeToken: "primary-token",
  negativeTokenIsDistinct: false,
  primaryNamespace: "eval-live-recall-pack-test",
  negativeNamespace: "eval-live-recall-pack-test-negative",
  searchMode: "hybrid",
  timeoutMs: 1000,
};

const SCOPE = {
  agent: "complete-pack-eval",
  platform: "eval",
  server_id: "open-brain-complete-pack",
  channel_id: "complete-pack-v1",
  session_key: "eval:complete-pack:v1",
} as const;

// Two primary records the recall should surface, one negative record forbidden.
const FIXTURE: CompletePackFixture = {
  schema_version: 1,
  fixture_id: "complete-pack-test-v1",
  description: "test",
  query: "marlin telemetry cache and beacon rotation",
  corpus: [
    {
      id: "prim-a",
      table: "thoughts",
      namespace_role: "primary",
      content: "primary a marlin cache body",
      tags: ["t"],
    },
    {
      id: "prim-b",
      table: "decisions",
      namespace_role: "primary",
      content: "primary b beacon rotation body",
      tags: ["t"],
    },
    {
      id: "neg-secret",
      table: "thoughts",
      namespace_role: "negative",
      content: "negative secret body that must never surface",
      tags: ["t"],
    },
  ],
  expected_recall_ids: ["prim-a", "prim-b"],
  forbidden_ids: ["neg-secret"],
};

const serverId = (fixtureId: string) => `srv-${fixtureId}`;
const canonical = (source: string, id: string) =>
  `brain_record:${source}:${id}`;

/**
 * Build a well-formed emitted pack payload for the two seeded primary records,
 * with all nine sections present-or-defined-empty, a clean citation bijection,
 * a whole-pack budget the serialized sections fit inside, and durable_lane's
 * exact-scope denial. Overrides let each test perturb exactly one property.
 */
function goodPayload(
  overrides: Partial<{
    sections: Record<string, unknown>;
    citations: Array<Record<string, unknown>>;
    budget: Record<string, unknown>;
    warnings: ContextPackPayload["warnings"];
    status: string;
    dropSection: string;
    extraDurableItem: Record<string, unknown>;
  }> = {},
): ContextPackPayload {
  const durableItems = [
    {
      id: serverId("prim-a"),
      source_type: "thought",
      namespace: CONFIG.primaryNamespace,
      content: "primary a marlin cache body",
      citation_id: canonical("thought", serverId("prim-a")),
      source_ref: {
        source: "brain",
        type: "thought",
        id: serverId("prim-a"),
        namespace: CONFIG.primaryNamespace,
      },
    },
    {
      id: serverId("prim-b"),
      source_type: "decision",
      namespace: CONFIG.primaryNamespace,
      content: "primary b beacon rotation body",
      citation_id: canonical("decision", serverId("prim-b")),
      source_ref: {
        source: "brain",
        type: "decision",
        id: serverId("prim-b"),
        namespace: CONFIG.primaryNamespace,
      },
    },
  ];
  if (overrides.extraDurableItem) durableItems.push(overrides.extraDurableItem);

  const durableCitations = durableItems.map((i) => ({
    id: i.citation_id,
    kind: "brain_record",
    source_ref: i.source_ref,
  }));

  const sections: Record<string, unknown> = {
    working_set: {
      label: "working_set",
      items: [],
      item_count: 0,
    },
    recovery: undefined, // recovery is not requested unless opted-in; absent OK
    durable_memory: {
      label: "durable_memory",
      namespace_scoped: true,
      query: FIXTURE.query,
      items: durableItems,
      item_count: durableItems.length,
      truncated: false,
    },
    profile_guidance: {
      label: "profile_guidance",
      namespace_bound: true,
      items: [],
      item_count: 0,
    },
    process_guidance: {
      label: "process_guidance",
      namespace_bound: true,
      items: [],
      item_count: 0,
    },
    pointers: {
      label: "pointers",
      namespace_scoped: true,
      resolvable_reference_only: true,
      items: [],
      item_count: 0,
      truncated: false,
    },
    candidate_memory: {
      label: "candidate_memory",
      items: [],
      item_count: 0,
      empty_reason: "candidate_predicate_unavailable",
      confidence: "unconfirmed",
      auto_promotable: false,
    },
    ...(overrides.sections ?? {}),
  };
  // Empty-section dispositions modeled exactly as the live pack reports them on a
  // fresh throwaway scope:
  //  - working_set / recovery are RAM-only (recovery is absent unless opted in);
  //  - profile_guidance / process_guidance / pointers emit a truthful empty body
  //    with a namespace-binding flag and NO empty_reason and NO scope-denial
  //    (the guidance loaders and pointer builder return scopeDenials: []);
  //  - durable_lane_context reports its exact_scope denial;
  //  - repo_facts reports its no_active_repo denial.
  // So the only scope-denials the server surfaces here are durable_lane_context
  // and repo_facts — the guidance/pointer empties are self-describing bodies.

  if (overrides.dropSection) delete sections[overrides.dropSection];

  const warnings: ContextPackPayload["warnings"] = overrides.warnings ?? {
    scope_denials: [
      { source: "durable_lane_context", reasons: ["exact_scope"] },
      { source: "repo_facts", reasons: ["no_active_repo"] },
    ],
    degraded_sources: [],
    truncation: [],
  };

  const baseSections = Object.fromEntries(
    Object.entries(sections).filter(([, v]) => v !== undefined),
  );
  const serialized = JSON.stringify(baseSections).length;

  const budget: Record<string, unknown> = overrides.budget ?? {
    requested: { max_tokens: 6000 },
    whole_pack: {
      content_char_limit: serialized + 500,
      content_chars_used: serialized,
      allocation_order: [...COMPLETE_PACK_SECTION_NAMES],
    },
  };

  return {
    status: overrides.status ?? "ok",
    sections: baseSections,
    citations: overrides.citations ?? durableCitations,
    budget,
    warnings,
  };
}

interface FakeOptions {
  payload?: ContextPackPayload;
  packThrows?: boolean;
  seedFailFor?: string[];
  archiveFailFor?: string[];
}

interface FakeState {
  seeded: Map<string, { table: string; namespace: string }>;
  archived: string[];
  packScopes: ContextPackScope[];
}

function makeFakeClients(opts: FakeOptions = {}): {
  clients: CompletePackGateClients;
  state: FakeState;
} {
  const state: FakeState = {
    seeded: new Map(),
    archived: [],
    packScopes: [],
  };
  const seedFail = new Set(opts.seedFailFor ?? []);
  const archiveFail = new Set(opts.archiveFailFor ?? []);
  const byServerId = (id: string) => id.replace(/^srv-/, "");

  function makeClient(): OpenBrainLiveClient {
    const fake = {
      async logMemory(o: {
        table: string;
        content: string;
        tags: string[];
        namespace: string;
      }) {
        const entry = FIXTURE.corpus.find((c) => c.content === o.content);
        const fixtureId = entry?.id ?? "unknown";
        if (seedFail.has(fixtureId)) {
          throw new LiveTransportError(`log:${fixtureId}:error`, false);
        }
        const id = serverId(fixtureId);
        state.seeded.set(id, { table: o.table, namespace: o.namespace });
        return { id, namespace: o.namespace, merged: false };
      },
      async contextPack(o: { scope: ContextPackScope }) {
        state.packScopes.push(o.scope);
        if (opts.packThrows) {
          throw new LiveTransportError("agent_context_pack:timeout", false);
        }
        return opts.payload ?? goodPayload();
      },
      async archive(o: { table: string; id: string }) {
        const fixtureId = byServerId(o.id);
        if (archiveFail.has(fixtureId)) {
          throw new LiveTransportError("archive_entry:error", false);
        }
        state.archived.push(o.id);
        return state.seeded.has(o.id) ? "archived" : "already_absent";
      },
      async close() {},
    };
    return fake as unknown as OpenBrainLiveClient;
  }

  return {
    clients: { primary: makeClient(), negative: makeClient() },
    state,
  };
}

function run(opts: FakeOptions = {}) {
  const { clients, state } = makeFakeClients(opts);
  return {
    outcome: runCompletePackGate({
      fixture: FIXTURE,
      config: CONFIG,
      clients,
      budgetMaxTokens: 6000,
      scope: SCOPE,
      commit: "testcommit",
      generatedAt: "2026-07-23T00:00:00.000Z",
    }),
    state,
  };
}

function assertContentFree(receipt: unknown): void {
  const json = JSON.stringify(receipt);
  expect(json).not.toContain("must never surface");
  expect(json).not.toContain("marlin cache body");
  expect(json).not.toContain("beacon rotation body");
}

describe("runCompletePackGate happy path", () => {
  it("verifies all five properties, tears down, and reports PASS", async () => {
    const { outcome, state } = run();
    const { receipt, passed } = await outcome;

    expect(passed).toBe(true);
    expect(receipt.failures).toEqual([]);
    expect(receipt.seeded).toEqual({ primary: 2, negative: 1 });

    // 1. Every requested section is present or defined-empty.
    for (const name of COMPLETE_PACK_SECTION_NAMES) {
      const v = receipt.sections.find((s) => s.section === name);
      expect(v).toBeDefined();
      expect(v!.has_items || v!.defined_empty).toBe(true);
    }
    // durable_memory carried items; the RAM-only + guidance sections are empty.
    const durable = receipt.sections.find(
      (s) => s.section === "durable_memory",
    );
    expect(durable!.has_items).toBe(true);
    expect(durable!.item_count).toBe(2);
    const candidate = receipt.sections.find(
      (s) => s.section === "candidate_memory",
    );
    expect(candidate!.disposition).toBe("candidate_predicate_unavailable");

    // 2. Isolation.
    expect(receipt.isolation.exact_scope_denied).toBe(true);
    expect(receipt.isolation.namespace_leaks).toBe(0);
    expect(receipt.isolation.expected_recall_present).toBe(true);

    // 3. Citation bijection.
    expect(receipt.citations.bijective).toBe(true);
    expect(receipt.citations.dangling_citations).toBe(0);
    expect(receipt.citations.uncited_items).toBe(0);

    // 4. Serialized budget respected with a complete allocation order.
    expect(receipt.budget.within_budget).toBe(true);
    expect(receipt.budget.allocation_order_complete).toBe(true);

    // 5. Per-section contribution recorded.
    for (const v of receipt.sections) {
      expect(typeof v.serialized_chars).toBe("number");
    }

    // The pack was built under the PRIMARY throwaway namespace (isolation seam).
    expect(state.packScopes.length).toBe(1);
    expect(state.packScopes[0]!.namespace).toBe(CONFIG.primaryNamespace);

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
        scope_denials: [
          { source: "durable_lane_context", reasons: ["exact_scope"] },
        ],
        degraded_sources: [],
        truncation: [],
      },
    });
    const { outcome } = run({ payload });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    const v = receipt.sections.find((s) => s.section === "candidate_memory");
    expect(v!.present).toBe(false);
    expect(v!.defined_empty).toBe(false);
    expect(receipt.failures.some((f) => f.includes("candidate_memory"))).toBe(
      true,
    );
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
        degraded_sources: [
          { source: "durable_memory", reason: "recall_failed" },
        ],
        truncation: [],
      },
      // With durable dropped, no items, no citations, no expected recall.
      citations: [],
    });
    const { outcome } = run({ payload });
    const { receipt } = await outcome;
    const v = receipt.sections.find((s) => s.section === "durable_memory");
    expect(v!.defined_empty).toBe(true);
    expect(v!.disposition).toBe("recall_failed");
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
    const v = receipt.sections.find((s) => s.section === "durable_memory");
    expect(v!.present).toBe(true);
    expect(v!.has_items).toBe(false);
    expect(v!.defined_empty).toBe(false);
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

describe("runCompletePackGate serialized budget", () => {
  it("fails when serialized sections exceed the whole-pack limit", async () => {
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

  it("fails when no whole-pack budget block is reported at all", async () => {
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
    expect(receipt.failures.some((f) => f.includes("isolation breach"))).toBe(
      true,
    );
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
    const v = receipt.sections.find((s) => s.section === "durable_memory");
    expect(v!.defined_empty).toBe(true); // section is fine on its own
    expect(receipt.isolation.expected_recall_present).toBe(false);
    expect(passed).toBe(false);
    expect(receipt.failures.some((f) => f.includes("hollow recall"))).toBe(
      true,
    );
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
    const err = await outcome.catch((e) => e as LiveTransportError);
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
    expect(
      receipt.failures.some((f) => f.includes("teardown failed to archive")),
    ).toBe(true);
    assertContentFree(receipt);
  });
});
