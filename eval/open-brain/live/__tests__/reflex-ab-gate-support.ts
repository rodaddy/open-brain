import { expect } from "vitest";
import { expectDefined } from "../../../../scripts/test-support/expect-defined.ts";
import { runReflexAbGate, type ReflexAbGateClients } from "../reflex-ab-gate.ts";
import type { ReflexAbFixture } from "../reflex-ab-types.ts";
import type { LiveEvalConfig } from "../config.ts";
import {
  LiveTransportError,
  type ContextPackScope,
  type OpenBrainLiveClient,
  type ReflexPointersPayload,
  type ReflexPriorContextRef,
} from "../transport.ts";

// Shared harness for the runReflexAbGate orchestrator suites (REFLEX-4, #335).
// These drive a structural fake at the OpenBrainLiveClient seam so no hosted
// server is touched. The suites assert FUNCTIONAL OUTCOMES of the A/B
// suppression comparison — suppression enabled returns demonstrably fewer
// already-known items with zero redundant resurfacing while preserving net-new
// evidence, both arms are cited / body-free / budget-bounded / exact-scope
// isolated, and the cross-namespace denial control holds — never SQL shape or
// internal call counts. The receipt is proven content-free: only ids,
// namespaces, counts, booleans.

export const CONFIG: LiveEvalConfig = {
  baseUrl: "http://127.0.0.1:3100",
  primaryToken: "primary-token",
  negativeToken: "primary-token",
  negativeTokenIsDistinct: false,
  primaryNamespace: "eval-live-recall-reflex-ab-test",
  negativeNamespace: "eval-live-recall-reflex-ab-test-negative",
  project: "open-brain",
  searchMode: "hybrid",
  timeoutMs: 1000,
};

export const SCOPE = {
  agent: "reflex-ab-eval",
  platform: "eval",
  server_id: "open-brain-reflex-ab",
  channel_id: "reflex-ab-v1",
  session_key: "eval:reflex-ab:v1",
} as const;

// Two prior-known primary seeds, two net-new primary seeds, one negative.
export const FIXTURE: ReflexAbFixture = {
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

/** Every primary fixture id, in the order the OFF arm emits them by default. */
export const ALL_PRIMARY_IDS = ["known-a", "known-b", "netnew-a", "netnew-b"] as const;

export const serverId = (fixtureId: string) => `srv-${fixtureId}`;
export const sourceTypeOf = (table: string) =>
  table === "decisions" ? "decision" : "thought";
export const canonical = (source: string, id: string) => `brain_record:${source}:${id}`;

/** Look up a corpus entry by fixture id, narrowing away the undefined case. */
export function corpusEntry(fixtureId: string) {
  return expectDefined(
    FIXTURE.corpus.find((c) => c.id === fixtureId),
    `corpus entry ${fixtureId}`,
  );
}

/** The canonical citation id a primary fixture seed is emitted under. */
export function citationForFixture(fixtureId: string): string {
  const entry = corpusEntry(fixtureId);
  return canonical(sourceTypeOf(entry.table), serverId(fixtureId));
}

/** Build a body-free pointer item for a primary seed's server id. */
export function pointerFor(fixtureId: string): Record<string, unknown> {
  const entry = corpusEntry(fixtureId);
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
 * The natural one-citation-per-emitted-pointer list for a fixture set, matching
 * reflexPayload's default so a test can then perturb ONE identity.
 */
export const citationsFor = (fixtureIds: string[]) =>
  fixtureIds.map((fid) => ({
    id: citationForFixture(fid),
    kind: "pointer",
  }));

export type ReflexPayloadOverrides = Partial<{
  citations: Array<Record<string, unknown>>;
  budget: Record<string, unknown>;
  status: string;
  placement: string;
  extraPointer: Record<string, unknown>;
  pointers: Record<string, unknown>;
  warnings: ReflexPointersPayload["warnings"];
}>;

/** The complete whole-pack allocation order a well-formed budget reports. */
export const ALLOCATION_ORDER = [
  "working_set",
  "recovery",
  "durable_lane_context",
  "durable_memory",
  "profile_guidance",
  "process_guidance",
  "repo_facts",
  "pointers",
  "candidate_memory",
] as const;

/**
 * Build a well-formed reflex-pointers payload emitting the given primary fixture
 * ids as body-free cited pointers, with a clean citation bijection, a whole-pack
 * budget the serialized pointers fit inside, and a complete allocation order.
 */
export function reflexPayload(
  emittedFixtureIds: string[],
  overrides: ReflexPayloadOverrides = {},
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
      allocation_order: [...ALLOCATION_ORDER],
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

export interface FakeOptions {
  /** Payload for the OFF arm (no prior_context). Defaults to all 4 primaries. */
  offPayload?: ReflexPointersPayload;
  /**
   * Payload for the second unsuppressed CONTROL arm (no prior_context). When
   * omitted it mirrors the OFF arm exactly (stable resurfacing). Override it to
   * simulate a variable ranked recall that drops the known items on its own.
   */
  controlPayload?: ReflexPointersPayload;
  /**
   * Payload for the ON arm. When omitted, the fake computes a REALISTIC
   * suppressed payload: it drops any pointer whose citation_id/source_ref was
   * passed as prior_context, so a correct suppression is simulated end to end.
   */
  onPayload?: ReflexPointersPayload;
  /** Override the ON arm to ignore prior_context (simulate broken suppression). */
  onIgnoresPriorContext?: boolean;
  reflexThrowsOn?: "off" | "control" | "on";
  seedFailFor?: string[];
  archiveFailFor?: string[];
  negativeRead?: "denied" | "empty" | "leak" | "throws";
}

export interface FakeState {
  seeded: Map<string, { table: string; namespace: string }>;
  archived: string[];
  reflexScopes: ContextPackScope[];
  priorContextByCall: Array<readonly ReflexPriorContextRef[] | undefined>;
  attemptReadNamespaces: string[];
}

/** Which A/B arm a reflex call belongs to, by call ordinal. */
type Arm = "off" | "control" | "on";
const armForCall = (callIndex: number): Arm =>
  callIndex === 0 ? "off" : callIndex === 1 ? "control" : "on";

/**
 * Compute the ON arm's payload for a given prior_context, honouring the
 * onPayload / onIgnoresPriorContext overrides. The default is a REALISTIC
 * suppression: drop every emitted pointer whose citation_id was sent as
 * prior_context.
 */
function suppressedPayload(
  opts: FakeOptions,
  priorContext: readonly ReflexPriorContextRef[] | undefined,
): ReflexPointersPayload {
  if (opts.onPayload) return opts.onPayload;
  if (opts.onIgnoresPriorContext) {
    // Broken suppression: emit exactly what the OFF arm did.
    return reflexPayload([...ALL_PRIMARY_IDS]);
  }
  const suppressedCitations = new Set(
    (priorContext ?? [])
      .map((r) => r.citation_id)
      .filter((c): c is string => typeof c === "string"),
  );
  const surviving = ALL_PRIMARY_IDS.filter(
    (fid) => !suppressedCitations.has(citationForFixture(fid)),
  );
  return reflexPayload(surviving);
}

/** The fake `logMemory` seam: records the seed or throws for a failing id. */
function makeLogMemory(opts: FakeOptions, state: FakeState) {
  const seedFail = new Set(opts.seedFailFor ?? []);
  return async function logMemory(o: {
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
  };
}

/** The fake `reflexPointers` seam: dispatches OFF, CONTROL, then ON by call. */
function makeReflexPointers(
  opts: FakeOptions,
  state: FakeState,
  offPayload: ReflexPointersPayload,
  controlPayload: ReflexPointersPayload,
) {
  let reflexCall = 0;
  return async function reflexPointers(o: {
    scope: ContextPackScope;
    priorContext?: readonly ReflexPriorContextRef[];
  }) {
    state.reflexScopes.push(o.scope);
    state.priorContextByCall.push(o.priorContext);
    const arm = armForCall(reflexCall);
    reflexCall += 1;
    if (opts.reflexThrowsOn === arm) {
      throw new LiveTransportError("agent_reflex_pointers:timeout", false);
    }
    if (arm === "off") return offPayload;
    if (arm === "control") return controlPayload;
    return suppressedPayload(opts, o.priorContext);
  };
}

/** The fake `attemptRead` seam: the cross-namespace denial control. */
function makeAttemptRead(
  opts: FakeOptions,
  state: FakeState,
  role: "primary" | "negative",
) {
  return async function attemptRead(o: {
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
  };
}

/** The fake `archive` seam: the teardown path, with per-id failure injection. */
function makeArchive(opts: FakeOptions, state: FakeState) {
  const archiveFail = new Set(opts.archiveFailFor ?? []);
  const byServerId = (id: string) => id.replace(/^srv-/, "");
  return async function archive(o: { table: string; id: string }) {
    const fixtureId = byServerId(o.id);
    if (archiveFail.has(fixtureId)) {
      throw new LiveTransportError("archive_entry:error", false);
    }
    state.archived.push(o.id);
    return state.seeded.has(o.id) ? "archived" : "already_absent";
  };
}

export function makeFakeClients(opts: FakeOptions = {}): {
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

  const offPayload = opts.offPayload ?? reflexPayload([...ALL_PRIMARY_IDS]);
  // The control arm is a second unsuppressed call; by default it mirrors the OFF
  // arm exactly, so the known items resurface stably across both.
  const controlPayload = opts.controlPayload ?? offPayload;

  function makeClient(role: "primary" | "negative"): OpenBrainLiveClient {
    const fake = {
      logMemory: makeLogMemory(opts, state),
      reflexPointers: makeReflexPointers(opts, state, offPayload, controlPayload),
      attemptRead: makeAttemptRead(opts, state, role),
      archive: makeArchive(opts, state),
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

export function assertContentFree(receipt: unknown): void {
  const json = JSON.stringify(receipt);
  expect(json).not.toContain("must never surface");
  expect(json).not.toContain("cache eviction body");
  expect(json).not.toContain("beacon rotation body");
  expect(json).not.toContain("handoff checkpoint body");
}
