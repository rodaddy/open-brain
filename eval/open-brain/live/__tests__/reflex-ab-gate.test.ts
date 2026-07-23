import { describe, expect, it } from "bun:test";
import {
  runReflexAbGate,
  type ReflexAbGateClients,
} from "../reflex-ab-gate.ts";
import type { ReflexAbFixture } from "../reflex-ab-types.ts";
import type { LiveEvalConfig } from "../config.ts";
import {
  LiveTransportError,
  type ContextPackScope,
  type OpenBrainLiveClient,
  type ReflexPointersPayload,
  type ReflexPriorContextRef,
} from "../transport.ts";

// Orchestrator tests for runReflexAbGate (REFLEX-4, #335). These drive a
// structural fake at the OpenBrainLiveClient seam so no hosted server is
// touched. They assert FUNCTIONAL OUTCOMES of the A/B suppression comparison —
// suppression enabled returns demonstrably fewer already-known items with zero
// redundant resurfacing while preserving net-new evidence, both arms are cited /
// body-free / budget-bounded / exact-scope isolated, and the cross-namespace
// denial control holds — never SQL shape or internal call counts. The receipt is
// proven content-free: only ids, namespaces, counts, booleans.

const CONFIG: LiveEvalConfig = {
  baseUrl: "http://127.0.0.1:3100",
  primaryToken: "primary-token",
  negativeToken: "primary-token",
  negativeTokenIsDistinct: false,
  primaryNamespace: "eval-live-recall-reflex-ab-test",
  negativeNamespace: "eval-live-recall-reflex-ab-test-negative",
  searchMode: "hybrid",
  timeoutMs: 1000,
};

const SCOPE = {
  agent: "reflex-ab-eval",
  platform: "eval",
  server_id: "open-brain-reflex-ab",
  channel_id: "reflex-ab-v1",
  session_key: "eval:reflex-ab:v1",
} as const;

// Two prior-known primary seeds, two net-new primary seeds, one negative.
const FIXTURE: ReflexAbFixture = {
  schema_version: 1,
  fixture_id: "reflex-ab-test-v1",
  description: "test",
  query: "drifter telemetry cache and beacon rotation and handoff checkpoint",
  corpus: [
    {
      id: "known-a",
      table: "thoughts",
      namespace_role: "primary",
      prior_known: true,
      content: "known a cache eviction body",
      tags: ["t"],
    },
    {
      id: "known-b",
      table: "decisions",
      namespace_role: "primary",
      prior_known: true,
      content: "known b beacon rotation body",
      tags: ["t"],
    },
    {
      id: "netnew-a",
      table: "thoughts",
      namespace_role: "primary",
      content: "netnew a handoff checkpoint body",
      tags: ["t"],
    },
    {
      id: "netnew-b",
      table: "decisions",
      namespace_role: "primary",
      content: "netnew b fusion weighting body",
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
  prior_known_ids: ["known-a", "known-b"],
  net_new_ids: ["netnew-a", "netnew-b"],
  forbidden_ids: ["neg-secret"],
};

const serverId = (fixtureId: string) => `srv-${fixtureId}`;
const sourceTypeOf = (table: string) =>
  table === "decisions" ? "decision" : "thought";
const canonical = (source: string, id: string) =>
  `brain_record:${source}:${id}`;

/** Build a body-free pointer item for a primary seed's server id. */
function pointerFor(fixtureId: string): Record<string, unknown> {
  const entry = FIXTURE.corpus.find((c) => c.id === fixtureId)!;
  const st = sourceTypeOf(entry.table);
  const id = serverId(fixtureId);
  return {
    id,
    source_type: st,
    namespace: CONFIG.primaryNamespace,
    tier: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: null,
    citation_id: canonical(st, id),
    source_ref: {
      source: "brain",
      type: st,
      id,
      namespace: CONFIG.primaryNamespace,
    },
  };
}

/**
 * Build a well-formed reflex-pointers payload emitting the given primary fixture
 * ids as body-free cited pointers, with a clean citation bijection, a whole-pack
 * budget the serialized pointers fit inside, and a complete allocation order.
 */
function reflexPayload(
  emittedFixtureIds: string[],
  overrides: Partial<{
    citations: Array<Record<string, unknown>>;
    budget: Record<string, unknown>;
    status: string;
    placement: string;
    extraPointer: Record<string, unknown>;
    pointers: Record<string, unknown>;
    warnings: ReflexPointersPayload["warnings"];
  }> = {},
): ReflexPointersPayload {
  const items = emittedFixtureIds.map(pointerFor);
  if (overrides.extraPointer) items.push(overrides.extraPointer);
  const citations =
    overrides.citations ??
    items.map((i) => ({
      id: i.citation_id,
      kind: "pointer",
      source_ref: i.source_ref,
    }));

  const pointers = overrides.pointers ?? {
    label: "pointers",
    namespace_scoped: true,
    resolvable_reference_only: true,
    items,
    item_count: items.length,
    truncated: false,
  };
  const serialized = JSON.stringify(pointers).length;
  const budget = overrides.budget ?? {
    requested: { max_tokens: 6000 },
    whole_pack: {
      content_char_limit: serialized + 500,
      content_chars_used: serialized,
      allocation_order: [
        "working_set",
        "recovery",
        "durable_lane_context",
        "durable_memory",
        "profile_guidance",
        "process_guidance",
        "repo_facts",
        "pointers",
        "candidate_memory",
      ],
    },
  };

  return {
    status: overrides.status ?? "ok",
    placement: overrides.placement ?? "client_owned",
    pointers,
    citations,
    budget,
    warnings: overrides.warnings ?? {
      scope_denials: [],
      degraded_sources: [],
      truncation: [],
    },
  };
}

interface FakeOptions {
  /** Payload for the OFF arm (no prior_context). Defaults to all 4 primaries. */
  offPayload?: ReflexPointersPayload;
  /**
   * Payload for the ON arm. When omitted, the fake computes a REALISTIC
   * suppressed payload: it drops any pointer whose citation_id/source_ref was
   * passed as prior_context, so a correct suppression is simulated end to end.
   */
  onPayload?: ReflexPointersPayload;
  /** Override the ON arm to ignore prior_context (simulate broken suppression). */
  onIgnoresPriorContext?: boolean;
  reflexThrowsOn?: "off" | "on";
  seedFailFor?: string[];
  archiveFailFor?: string[];
  negativeRead?: "denied" | "empty" | "leak" | "throws";
}

interface FakeState {
  seeded: Map<string, { table: string; namespace: string }>;
  archived: string[];
  reflexScopes: ContextPackScope[];
  priorContextByCall: Array<readonly ReflexPriorContextRef[] | undefined>;
  attemptReadNamespaces: string[];
}

function makeFakeClients(opts: FakeOptions = {}): {
  clients: ReflexAbGateClients;
  state: FakeState;
} {
  const state: FakeState = {
    seeded: new Map(),
    archived: [],
    reflexScopes: [],
    priorContextByCall: [],
    attemptReadNamespaces: [],
  };
  const seedFail = new Set(opts.seedFailFor ?? []);
  const archiveFail = new Set(opts.archiveFailFor ?? []);
  const byServerId = (id: string) => id.replace(/^srv-/, "");

  const offPayload =
    opts.offPayload ??
    reflexPayload(["known-a", "known-b", "netnew-a", "netnew-b"]);

  function suppressedPayload(
    priorContext: readonly ReflexPriorContextRef[] | undefined,
  ): ReflexPointersPayload {
    if (opts.onPayload) return opts.onPayload;
    if (opts.onIgnoresPriorContext) {
      // Broken suppression: emit exactly what the OFF arm did.
      return reflexPayload(["known-a", "known-b", "netnew-a", "netnew-b"]);
    }
    // Realistic suppression: drop any emitted pointer whose identity was passed
    // as prior_context (by citation_id).
    const suppressedCitations = new Set(
      (priorContext ?? [])
        .map((r) => r.citation_id)
        .filter((c): c is string => typeof c === "string"),
    );
    const surviving = ["known-a", "known-b", "netnew-a", "netnew-b"].filter(
      (fid) => {
        const entry = FIXTURE.corpus.find((c) => c.id === fid)!;
        const cid = canonical(sourceTypeOf(entry.table), serverId(fid));
        return !suppressedCitations.has(cid);
      },
    );
    return reflexPayload(surviving);
  }

  function makeClient(role: "primary" | "negative"): OpenBrainLiveClient {
    let reflexCall = 0;
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
      async reflexPointers(o: {
        scope: ContextPackScope;
        priorContext?: readonly ReflexPriorContextRef[];
      }) {
        state.reflexScopes.push(o.scope);
        state.priorContextByCall.push(o.priorContext);
        const arm = reflexCall === 0 ? "off" : "on";
        reflexCall += 1;
        if (opts.reflexThrowsOn === arm) {
          throw new LiveTransportError("agent_reflex_pointers:timeout", false);
        }
        return arm === "off" ? offPayload : suppressedPayload(o.priorContext);
      },
      async attemptRead(o: {
        namespace: string;
      }): Promise<{ denied: boolean; hitCount: number }> {
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
    outcome: runReflexAbGate({
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
  expect(json).not.toContain("cache eviction body");
  expect(json).not.toContain("beacon rotation body");
  expect(json).not.toContain("handoff checkpoint body");
}

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

    // ON arm: both known items suppressed, net-new preserved.
    expect(receipt.arm_on.pointer_count).toBe(2);
    expect(receipt.arm_on.redundant_resurfacing).toBe(0);
    expect(receipt.arm_on.net_new_present).toBe(2);
    expect(receipt.arm_on.net_new_missing).toBe(0);

    // A/B comparison: the REFLEX-4 acceptance signal.
    expect(receipt.comparison.known_resurfaced_off).toBe(2);
    expect(receipt.comparison.known_resurfaced_on).toBe(0);
    expect(receipt.comparison.known_suppressed_delta).toBe(2);
    expect(receipt.comparison.fewer_known_when_enabled).toBe(true);
    expect(receipt.comparison.net_new_preserved).toBe(2);
    expect(receipt.comparison.net_new_preserved_on_both).toBe(true);

    // The ON arm received the OFF arm's known-seed references as prior_context.
    const onPriorContext = state.priorContextByCall[1];
    expect(onPriorContext).toBeDefined();
    expect(onPriorContext!.length).toBe(2);
    const sentCitations = onPriorContext!.map((r) => r.citation_id).sort();
    expect(sentCitations).toEqual(
      [
        canonical("thought", serverId("known-a")),
        canonical("decision", serverId("known-b")),
      ].sort(),
    );
    // The OFF arm sent NO prior_context.
    expect(state.priorContextByCall[0]).toBeUndefined();

    // Cross-namespace denial ran and denied, probing the NEGATIVE namespace.
    expect(receipt.negative_control.ran).toBe(true);
    expect(receipt.negative_control.denied).toBe(true);
    expect(state.attemptReadNamespaces).toEqual([CONFIG.negativeNamespace]);

    // Both reflex calls ran under the PRIMARY throwaway namespace.
    expect(state.reflexScopes.length).toBe(2);
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
    expect(receipt.failures.some((f) => f.includes("already-known item"))).toBe(
      true,
    );
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
    expect(receipt.failures.some((f) => f.includes("net-new evidence"))).toBe(
      true,
    );
  });

  it("fails when a net-new item is missing on the OFF arm (hollow recall)", async () => {
    const { outcome } = run({
      offPayload: reflexPayload(["known-a", "known-b", "netnew-a"]),
    });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.net_new_missing).toBe(1);
    expect(
      receipt.failures.some((f) => f.includes("net-new record(s) missing")),
    ).toBe(true);
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
    const off = reflexPayload(["known-a", "known-b", "netnew-a", "netnew-b"], {
      placement: "meta_injected",
    });
    const { outcome } = run({ offPayload: off });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.placement_client_owned).toBe(false);
    expect(receipt.failures.some((f) => f.includes("client_owned"))).toBe(true);
  });

  it("fails on a dangling citation with no emitted pointer", async () => {
    const off = reflexPayload(["known-a", "known-b", "netnew-a", "netnew-b"]);
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
    const off = reflexPayload(["known-a", "known-b", "netnew-a", "netnew-b"]);
    off.citations = off.citations.slice(0, 3);
    const { outcome } = run({ offPayload: off });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.uncited_pointers).toBe(1);
    expect(receipt.arm_off.citations_bijective).toBe(false);
  });

  it("fails when serialized pointers exceed the whole-pack limit", async () => {
    const off = reflexPayload(["known-a", "known-b", "netnew-a", "netnew-b"]);
    const serialized = JSON.stringify(off.pointers).length;
    off.budget = {
      whole_pack: {
        content_char_limit: serialized - 10,
        content_chars_used: serialized,
        allocation_order: [
          "working_set",
          "recovery",
          "durable_lane_context",
          "durable_memory",
          "profile_guidance",
          "process_guidance",
          "repo_facts",
          "pointers",
          "candidate_memory",
        ],
      },
    };
    const { outcome } = run({ offPayload: off });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.budget.within_budget).toBe(false);
  });

  it("fails when the whole-pack allocation order is incomplete", async () => {
    const off = reflexPayload(["known-a", "known-b", "netnew-a", "netnew-b"]);
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
    const off = reflexPayload(["known-a", "known-b", "netnew-a", "netnew-b"]);
    off.budget = { requested: { max_tokens: 6000 } };
    const { outcome } = run({ offPayload: off });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.budget.content_char_limit).toBeNull();
    expect(receipt.arm_off.budget.within_budget).toBe(false);
  });
});

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
    const off = reflexPayload(["known-a", "known-b", "netnew-a", "netnew-b"], {
      extraPointer: leak,
    });
    const { outcome } = run({ offPayload: off });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.arm_off.namespace_leaks).toBe(1);
    expect(receipt.failures.some((f) => f.includes("isolation breach"))).toBe(
      true,
    );
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
    expect(receipt.negative_control.failure).toContain(
      "negative-control read failed",
    );
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

  it("tears down seeded records even when the ON reflex call throws", async () => {
    const { outcome, state } = run({ reflexThrowsOn: "on" });
    await expect(outcome).rejects.toThrow(LiveTransportError);
    expect(state.archived.length).toBe(5);
  });

  it("tears down records seeded so far when seeding fails partway", async () => {
    const { outcome, state } = run({ seedFailFor: ["neg-secret"] });
    await expect(outcome).rejects.toThrow(LiveTransportError);
    // All four primaries seeded before the negative seed failed.
    expect(state.archived.sort()).toEqual(
      ["srv-known-a", "srv-known-b", "srv-netnew-a", "srv-netnew-b"].sort(),
    );
  });

  it("preserves the content-free teardown failed count on a deferred error", async () => {
    const { outcome } = run({
      reflexThrowsOn: "off",
      archiveFailFor: ["known-a"],
    });
    const err = await outcome.catch((e) => e as LiveTransportError);
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
    expect(
      receipt.failures.some((f) => f.includes("teardown failed to archive")),
    ).toBe(true);
    assertContentFree(receipt);
  });
});
