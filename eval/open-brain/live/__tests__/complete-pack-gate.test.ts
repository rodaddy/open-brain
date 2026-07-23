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
    repo_facts: {
      // Production present-empty shape for no active repo
      // (src/tools/agent-context-pack-repo-facts.ts): a present body carrying
      // {repo: null, repo_bound: false, items: []} PLUS a no_active_repo denial.
      label: "repo_facts",
      repo: null,
      namespace_bound: true,
      repo_bound: false,
      items: [],
      item_count: 0,
      truncated: false,
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
  //  - durable_lane_context reports its exact_scope denial (body omitted);
  //  - repo_facts is PRESENT-empty ({repo: null, repo_bound: false}) AND reports
  //    its no_active_repo denial — its disposition must derive from that reason,
  //    not the hardcoded exact_scope of durable_lane_context.
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
  /**
   * How the PRIMARY caller's cross-namespace read of the NEGATIVE namespace
   * resolves. "denied" is the only isolation-proving outcome; "empty" and "leak"
   * are allowed reads that must fail the gate; "throws" is a non-denial transport
   * error that leaves the proof unestablished (denied=false, no gate throw).
   */
  negativeRead?: "denied" | "empty" | "leak" | "throws";
}

interface FakeState {
  seeded: Map<string, { table: string; namespace: string }>;
  archived: string[];
  packScopes: ContextPackScope[];
  /** Namespaces the PRIMARY caller's isolation probe (attemptRead) targeted. */
  attemptReadNamespaces: string[];
}

function makeFakeClients(opts: FakeOptions = {}): {
  clients: CompletePackGateClients;
  state: FakeState;
} {
  const state: FakeState = {
    seeded: new Map(),
    archived: [],
    packScopes: [],
    attemptReadNamespaces: [],
  };
  const seedFail = new Set(opts.seedFailFor ?? []);
  const archiveFail = new Set(opts.archiveFailFor ?? []);
  const byServerId = (id: string) => id.replace(/^srv-/, "");

  function makeClient(role: "primary" | "negative"): OpenBrainLiveClient {
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
      async attemptRead(o: {
        namespace: string;
      }): Promise<{ denied: boolean; hitCount: number }> {
        // Record the namespace the PRIMARY isolation probe targeted so a test can
        // pin the live-proven call shape: the gate must probe the NEGATIVE
        // namespace with the PRIMARY caller.
        if (role === "primary") {
          state.attemptReadNamespaces.push(o.namespace);
        }
        switch (opts.negativeRead ?? "denied") {
          case "denied":
            return { denied: true, hitCount: 0 };
          case "empty":
            return { denied: false, hitCount: 0 };
          case "leak":
            return { denied: false, hitCount: 1 };
          case "throws":
            throw new LiveTransportError("search_brain:timeout", false);
        }
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
    clients: {
      primary: makeClient("primary"),
      negative: makeClient("negative"),
    },
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
  it("verifies all six properties, tears down, and reports PASS", async () => {
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
    // repo_facts is present-empty with a no_active_repo denial: its disposition
    // is that ACTUAL reason, never the hardcoded exact_scope (finding #3).
    const repoFacts = receipt.sections.find((s) => s.section === "repo_facts");
    expect(repoFacts!.present).toBe(true);
    expect(repoFacts!.defined_empty).toBe(true);
    expect(repoFacts!.disposition).toBe("no_active_repo");

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

describe("runCompletePackGate present-empty scope-denial disposition", () => {
  it("labels a present-empty repo_facts with its actual no_active_repo reason, not exact_scope", async () => {
    // Finding #3 false-pass regression: the goodPayload repo_facts is present
    // (repo: null) with a no_active_repo denial. The hardcoded-exact_scope bug
    // would mislabel it; the disposition must be the real reason.
    const { outcome } = run();
    const { receipt } = await outcome;
    const repoFacts = receipt.sections.find((s) => s.section === "repo_facts");
    expect(repoFacts!.present).toBe(true);
    expect(repoFacts!.has_items).toBe(false);
    expect(repoFacts!.defined_empty).toBe(true);
    expect(repoFacts!.disposition).toBe("no_active_repo");
    // durable_lane_context (omitted body) still carries its own exact_scope
    // reason: the two present/absent denials are NOT conflated to one label.
    const lane = receipt.sections.find(
      (s) => s.section === "durable_lane_context",
    );
    expect(lane!.disposition).toBe("exact_scope");
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
    const repoFacts = receipt.sections.find((s) => s.section === "repo_facts");
    expect(repoFacts!.disposition).toBe("no_active_repo,namespace_bound");
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
    expect(receipt.negative_control.failure).toContain(
      "negative-control read failed",
    );
    expect(passed).toBe(false);
    assertContentFree(receipt);
  });
});

describe("runCompletePackGate durable_lane_context events/lane walkers (finding #2)", () => {
  const laneId = "lane-uuid-777";
  const eventAId = "event-uuid-111";
  const eventBId = "event-uuid-222";

  /**
   * A production-accurate POPULATED durable_lane_context section: an exact-scope
   * lane WITH events, each citing itself via session_event:<id>, exactly as
   * src/tools/agent-context-pack-durable-lane.ts emits it. No exact_scope
   * scope-denial (the lane exists), so this run is used to exercise the citation
   * bijection over events and lane-scoped leak detection, not overall PASS.
   */
  function populatedLanePayload(
    overrides: {
      leakEventSourceRef?: string;
      dropEventCitations?: boolean;
    } = {},
  ): ContextPackPayload {
    const laneCitationId = `session_lane:${laneId}`;
    const eventACitation = `session_event:${eventAId}`;
    const eventBCitation = `session_event:${eventBId}`;
    const payload = goodPayload({
      warnings: {
        // Lane exists -> no exact_scope denial; repo_facts still present-empty.
        scope_denials: [{ source: "repo_facts", reasons: ["no_active_repo"] }],
        degraded_sources: [],
        truncation: [],
      },
      sections: {
        durable_lane_context: {
          label: "durable_lane_context",
          exact_scope_required: true,
          lane: {
            id: laneId,
            session_key: "eval:complete-pack:v1",
            status: "active",
            citation_id: laneCitationId,
          },
          events: [
            {
              id: eventAId,
              event_type: "decision",
              content: "lane event a body",
              citation_id: eventACitation,
              source_ref:
                overrides.leakEventSourceRef ?? `ob_session_events/${eventAId}`,
            },
            {
              id: eventBId,
              event_type: "thought",
              content: "lane event b body",
              citation_id: eventBCitation,
              source_ref: `ob_session_events/${eventBId}`,
            },
          ],
          event_count: 2,
          truncated: false,
        },
      },
    });
    // The pack cites the lane and every event. Drop the event citations when a
    // test wants to prove the events are walked (uncited detection).
    const laneCitations = overrides.dropEventCitations
      ? [
          {
            id: laneCitationId,
            kind: "session_lane",
            source_ref: `ob_session_lanes/${laneId}`,
          },
        ]
      : [
          {
            id: laneCitationId,
            kind: "session_lane",
            source_ref: `ob_session_lanes/${laneId}`,
          },
          {
            id: eventACitation,
            kind: "session_event",
            source_ref: `ob_session_events/${eventAId}`,
          },
          {
            id: eventBCitation,
            kind: "session_event",
            source_ref: `ob_session_events/${eventBId}`,
          },
        ];
    payload.citations = [...payload.citations, ...laneCitations];
    return payload;
  }

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
    expect(receipt.failures.some((f) => f.includes("isolation breach"))).toBe(
      true,
    );
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
