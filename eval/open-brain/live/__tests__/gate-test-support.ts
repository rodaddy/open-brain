import { expect } from "vitest";
import { runLiveGate, type GateClients } from "../gate.ts";
import type { LiveEvalConfig } from "../config.ts";
import {
  LiveTransportError,
  OpenBrainLiveClient,
  type OpenBrainToolCaller,
  type SearchHit,
  type ToolCallResult,
} from "../transport.ts";
import type { LiveFixture, LiveThresholds } from "../types.ts";

// Shared harness for the runLiveGate orchestrator suites (issue #322
// seeding/teardown + isolation regression, #324 composite gate). These drive a
// structural fake at the OpenBrainLiveClient seam so no hosted server is
// touched. What the suites prove:
//
//  - Teardown ALWAYS runs and archives exactly the records this run seeded --
//    even when seeding fails partway, when a query throws, or when a probe fails.
//  - A cleanup (archive) failure can never turn an otherwise-passing run into
//    PASS: teardownClean is a gate condition, not just a receipt field.
//  - The negative-control isolation proof is mandatory: PASS requires an
//    explicit denial. An allowed-but-empty negative read, an allowed non-empty
//    read, and a thrown non-denial error each fail the gate.
//  - Retrieved server ids are mapped back to fixture ids for scoring, and a
//    leaked negative id is counted as a namespace leak.
//  - thresholds that do not apply to the fixture throw before any live write.
//
// Everything the gate emits is content-free: only ids, namespaces, counts,
// booleans, and scores. The suites also assert no memory body leaks into the
// receipt.

export const CONFIG: LiveEvalConfig = {
  baseUrl: "http://127.0.0.1:3100",
  primaryToken: "primary-token",
  negativeToken: "primary-token",
  negativeTokenIsDistinct: false,
  primaryNamespace: "eval-live-recall-run-test",
  negativeNamespace: "eval-live-recall-run-test-negative",
  project: "open-brain",
  searchMode: "hybrid",
  timeoutMs: 1000,
};

export const THRESHOLDS: LiveThresholds = {
  schema_version: 1,
  thresholds_id: "test-thresholds-v1",
  applies_to_fixture_id: "test-fixture-v1",
  top_k: 5,
  thresholds: {
    min_recall_at_k: 0.9,
    min_precision_at_k: 0.3,
    min_mrr: 0.8,
    max_namespace_leaks: 0,
  },
};

// A small fixture: two primary records relevant to one probe, one negative
// record forbidden to that probe.
export const FIXTURE: LiveFixture = {
  schema_version: 1,
  fixture_id: "test-fixture-v1",
  description: "test",
  corpus: [
    {
      id: "prim-a",
      table: "thoughts",
      namespace_role: "primary",
      content: "primary a body",
      tags: ["t"],
    },
    {
      id: "prim-b",
      table: "decisions",
      namespace_role: "primary",
      content: "primary b body",
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
  probes: [
    {
      id: "probe-1",
      query: "find a and b",
      relevant: [
        { id: "prim-a", grade: 2 },
        { id: "prim-b", grade: 2 },
      ],
      forbidden_ids: ["neg-secret"],
    },
  ],
};

export interface FakeOptions {
  /** Fixture ids whose seed should throw a transport error (partial seed). */
  seedFailFor?: string[];
  /** Throw on the primary search call. */
  searchThrows?: boolean;
  /** Fixture ids whose archive should throw (cleanup failure). */
  archiveFailFor?: string[];
  /**
   * How the primary caller's read of the NEGATIVE namespace resolves:
   *  - "denied": server denies the read (isolation proven).
   *  - "empty": read is allowed but returns nothing (NOT proof).
   *  - "leak": read is allowed and returns the negative record (breach).
   *  - "throws": a non-denial transport error (proof could not be established).
   */
  negativeRead?: "denied" | "empty" | "leak" | "throws";
  /**
   * Extra fixture ids to inject into the PRIMARY probe search result, e.g. a
   * leaked negative id, to exercise leak counting via the retrieval mapping.
   */
  extraPrimaryHits?: string[];
  /**
   * Raw extra hits to append to the PRIMARY probe search result AFTER the
   * mapped/seeded primary hits, used to exercise pre-mapping hit validation:
   * a hit with a foreign/missing namespace, or an id this run never created.
   * These are appended verbatim (no seed-map filtering) so the gate must react
   * to them rather than silently drop them.
   */
  rawExtraPrimaryHits?: Array<{ id: string; namespace?: string }>;
}

export interface FakeState {
  seeded: Map<string, { table: string; namespace: string }>;
  archived: string[];
  closed: number;
  /** Namespaces the PRIMARY caller's isolation probe (attemptRead) targeted. */
  attemptReadNamespaces: string[];
}

/** Stable server id for a fixture id, and its inverse. */
const serverId = (fixtureId: string) => `srv-${fixtureId}`;
const byServerId = (id: string) => id.replace(/^srv-/, "");

/** The seam a fake client implements, before the OpenBrainLiveClient cast. */
interface FakeSeam {
  fixture: LiveFixture;
  opts: FakeOptions;
  state: FakeState;
  seedFail: Set<string>;
  archiveFail: Set<string>;
}

/** Seed handler: assigns a stable server id, or throws for a scripted failure. */
async function fakeLogMemory(
  seam: FakeSeam,
  o: { table: string; content: string; tags: string[]; namespace: string },
) {
  // Which fixture entry is this? Match by content (unique per entry).
  const entry = seam.fixture.corpus.find((c) => c.content === o.content);
  const fixtureId = entry?.id ?? "unknown";
  if (seam.seedFail.has(fixtureId)) {
    throw new LiveTransportError(`log:${fixtureId}:error`, false);
  }
  const id = serverId(fixtureId);
  seam.state.seeded.set(id, { table: o.table, namespace: o.namespace });
  // A fresh create: merged:false, matching the seed contract the real
  // logMemory now enforces.
  return { id, namespace: o.namespace, merged: false };
}

/**
 * Search handler: returns the seeded PRIMARY records as ranked hits (best-first)
 * plus any injected extra hits, then appends the raw (deliberately un-seeded /
 * foreign-namespace) hits so a test can prove the gate validates EVERY hit
 * before mapping instead of silently discarding an unaccountable one.
 */
async function fakeSearch(
  seam: FakeSeam,
  o: { namespace: string },
): Promise<SearchHit[]> {
  if (seam.opts.searchThrows) {
    throw new LiveTransportError("search_brain:timeout", false);
  }
  const primaryFixtureIds = seam.fixture.corpus
    .filter((c) => c.namespace_role === "primary")
    .map((c) => c.id);
  const hitFixtureIds = [...primaryFixtureIds, ...(seam.opts.extraPrimaryHits ?? [])];
  const mapped: SearchHit[] = hitFixtureIds
    .filter((fid) => seam.state.seeded.has(serverId(fid)))
    .map((fid) => ({
      id: serverId(fid),
      source_type: "thoughts",
      namespace: o.namespace,
    }));
  // The `namespace` key defaults to the searched namespace unless the test
  // overrides it (including setting it undefined to model a hit with no
  // namespace).
  const raw: SearchHit[] = (seam.opts.rawExtraPrimaryHits ?? []).map((h) => ({
    id: h.id,
    source_type: "thoughts",
    namespace: "namespace" in h ? h.namespace : o.namespace,
  }));
  return [...mapped, ...raw];
}

/** Isolation-probe handler, driven by FakeOptions.negativeRead. */
async function fakeAttemptRead(
  seam: FakeSeam,
  role: "primary" | "negative",
  o: { namespace: string },
): Promise<{ denied: boolean; hitCount: number }> {
  // Record the namespace the PRIMARY isolation probe targeted so a test can pin
  // the live-proven call shape: the gate must probe the NEGATIVE namespace with
  // the PRIMARY caller.
  if (role === "primary") {
    seam.state.attemptReadNamespaces.push(o.namespace);
  }
  switch (seam.opts.negativeRead ?? "denied") {
    case "denied":
      return { denied: true, hitCount: 0 };
    case "empty":
      return { denied: false, hitCount: 0 };
    case "leak":
      return { denied: false, hitCount: 1 };
    case "throws":
      throw new LiveTransportError("search_brain:timeout", false);
  }
}

/** Archive handler: records the id, or throws for a scripted cleanup failure. */
async function fakeArchive(seam: FakeSeam, o: { table: string; id: string }) {
  const fixtureId = byServerId(o.id);
  if (seam.archiveFail.has(fixtureId)) {
    throw new LiveTransportError("archive_entry:error", false);
  }
  seam.state.archived.push(o.id);
  return seam.state.seeded.has(o.id) ? "archived" : "already_absent";
}

/**
 * Build a pair of fake OpenBrainLiveClients (primary + negative) plus the shared
 * state they mutate. The fakes model just enough server behavior for the gate:
 * seeding assigns a stable server id ("srv-<fixtureId>"), primary search returns
 * the seeded primary records (best-first) mapped through their server ids, and
 * archive records the id. Negative-namespace behavior is driven by FakeOptions.
 */
export function makeFakeClients(
  fixture: LiveFixture,
  opts: FakeOptions = {},
): {
  clients: GateClients;
  state: FakeState;
} {
  const state: FakeState = {
    seeded: new Map(),
    archived: [],
    closed: 0,
    attemptReadNamespaces: [],
  };
  const seam: FakeSeam = {
    fixture,
    opts,
    state,
    seedFail: new Set(opts.seedFailFor ?? []),
    archiveFail: new Set(opts.archiveFailFor ?? []),
  };

  function makeClient(role: "primary" | "negative"): OpenBrainLiveClient {
    const fake = {
      logMemory: (o: {
        table: string;
        content: string;
        tags: string[];
        namespace: string;
      }) => fakeLogMemory(seam, o),
      search: (o: { namespace: string }) => fakeSearch(seam, o),
      attemptRead: (o: { namespace: string }) => fakeAttemptRead(seam, role, o),
      archive: (o: { table: string; id: string }) => fakeArchive(seam, o),
      async close() {
        state.closed += 1;
      },
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

/** Run the gate over the fakes, returning the pending outcome and the state. */
export function run(fixture: LiveFixture, opts: FakeOptions = {}) {
  const { clients, state } = makeFakeClients(fixture, opts);
  return {
    outcome: runLiveGate({
      fixture,
      thresholds: THRESHOLDS,
      config: CONFIG,
      clients,
      commit: "testcommit",
      generatedAt: "2026-07-22T00:00:00.000Z",
    }),
    state,
  };
}

/** Assert a receipt (serialized) carries no memory-body content. */
export function assertContentFree(receipt: unknown): void {
  const json = JSON.stringify(receipt);
  expect(json).not.toContain("body");
  expect(json).not.toContain("secret");
  expect(json).not.toContain("primary a body");
  expect(json).not.toContain("must never surface");
}

/** Scripted tool caller: name -> queue of results, plus the standard close. */
export function scriptedCaller(
  script: Record<string, ToolCallResult[]>,
): OpenBrainToolCaller {
  const queues: Record<string, ToolCallResult[]> = {};
  for (const [k, v] of Object.entries(script)) queues[k] = [...v];
  return {
    async callTool(name) {
      const q = queues[name];
      if (!q || q.length === 0) {
        throw new Error(`scripted caller has no result for ${name}`);
      }
      const next = q.shift();
      if (next === undefined) {
        throw new Error(`scripted caller queue for ${name} drained`);
      }
      return next;
    },
    async close() {},
  };
}

/** A successful scripted tool result carrying `data`. */
export const ok = (data: string): ToolCallResult => ({
  isError: false,
  denied: false,
  data,
  errorLabel: "",
});
