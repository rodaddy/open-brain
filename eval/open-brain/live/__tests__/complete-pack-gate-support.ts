import { expect } from "vitest";
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

// Shared harness for the runCompletePackGate orchestrator suites (issue #330).
// These drive a structural fake at the OpenBrainLiveClient seam so no hosted
// server is touched. The suites assert FUNCTIONAL OUTCOMES of the assembled
// pack — presence or defined emptiness of each of the nine sections,
// exact-scope isolation, citation bijection, serialized whole-pack allowance,
// per-section contribution, and teardown discipline — never SQL shape or
// internal call counts. The receipt is proven content-free: only ids,
// namespaces, counts, booleans.

export const CONFIG: LiveEvalConfig = {
  baseUrl: "http://127.0.0.1:3100",
  primaryToken: "primary-token",
  negativeToken: "primary-token",
  negativeTokenIsDistinct: false,
  primaryNamespace: "eval-live-recall-pack-test",
  negativeNamespace: "eval-live-recall-pack-test-negative",
  project: "open-brain",
  searchMode: "hybrid",
  timeoutMs: 1000,
};

export const SCOPE = {
  agent: "complete-pack-eval",
  platform: "eval",
  server_id: "open-brain-complete-pack",
  channel_id: "complete-pack-v1",
  session_key: "eval:complete-pack:v1",
} as const;

// Two primary records the recall should surface, one negative record forbidden.
export const FIXTURE: CompletePackFixture = {
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

export const serverId = (fixtureId: string) => `srv-${fixtureId}`;
export const canonical = (source: string, id: string) => `brain_record:${source}:${id}`;

export interface GoodPayloadOverrides {
  sections?: Record<string, unknown>;
  citations?: Array<Record<string, unknown>>;
  budget?: Record<string, unknown>;
  warnings?: ContextPackPayload["warnings"];
  status?: string;
  dropSection?: string;
  extraDurableItem?: Record<string, unknown>;
}

/** The two seeded primary records exactly as the pack emits them. */
function baseDurableItems(): Array<Record<string, unknown>> {
  return [
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
}

/**
 * The nine-section body a healthy pack emits on a fresh throwaway scope.
 *
 * Empty-section dispositions are modeled exactly as the live pack reports them:
 *  - working_set / recovery are RAM-only (recovery is absent unless opted in);
 *  - profile_guidance / process_guidance / pointers emit a truthful empty body
 *    with a namespace-binding flag and NO empty_reason and NO scope-denial
 *    (the guidance loaders and pointer builder return scopeDenials: []);
 *  - durable_lane_context reports its exact_scope denial (body omitted);
 *  - repo_facts is PRESENT-empty ({repo: null, repo_bound: false}) AND reports
 *    its no_active_repo denial — its disposition must derive from that reason,
 *    not the hardcoded exact_scope of durable_lane_context.
 * So the only scope-denials the server surfaces here are durable_lane_context
 * and repo_facts — the guidance/pointer empties are self-describing bodies.
 */
function baseSectionBodies(
  durableItems: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
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
      // (server/tools/context-pack-repo-facts.ts): a present body carrying
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
  };
}

const DEFAULT_WARNINGS: ContextPackPayload["warnings"] = {
  scope_denials: [
    { source: "durable_lane_context", reasons: ["exact_scope"] },
    { source: "repo_facts", reasons: ["no_active_repo"] },
  ],
  degraded_sources: [],
  truncation: [],
};

/**
 * Build a well-formed emitted pack payload for the two seeded primary records,
 * with all nine sections present-or-defined-empty, a clean citation bijection,
 * a whole-pack allowance the serialized sections fit inside, and durable_lane's
 * exact-scope denial. Overrides let each test perturb exactly one property.
 */
export function goodPayload(overrides: GoodPayloadOverrides = {}): ContextPackPayload {
  const durableItems = baseDurableItems();
  if (overrides.extraDurableItem) durableItems.push(overrides.extraDurableItem);

  const durableCitations = durableItems.map((i) => ({
    id: i.citation_id,
    kind: "brain_record",
    source_ref: i.source_ref,
  }));

  const sections: Record<string, unknown> = {
    ...baseSectionBodies(durableItems),
    ...overrides.sections,
  };

  if (overrides.dropSection) delete sections[overrides.dropSection];

  const warnings = overrides.warnings ?? DEFAULT_WARNINGS;

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

export interface FakeOptions {
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

export interface FakeState {
  seeded: Map<string, { table: string; namespace: string }>;
  archived: string[];
  packScopes: ContextPackScope[];
  /** Namespaces the PRIMARY caller's isolation probe (attemptRead) targeted. */
  attemptReadNamespaces: string[];
}

export function makeFakeClients(opts: FakeOptions = {}): {
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

export function run(opts: FakeOptions = {}) {
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

export function assertContentFree(receipt: unknown): void {
  const json = JSON.stringify(receipt);
  expect(json).not.toContain("must never surface");
  expect(json).not.toContain("marlin cache body");
  expect(json).not.toContain("beacon rotation body");
}
