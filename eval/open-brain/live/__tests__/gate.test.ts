import { describe, expect, it } from "bun:test";
import { runLiveGate, type GateClients } from "../gate.ts";
import type { LiveEvalConfig } from "../config.ts";
import { LiveTransportError, type OpenBrainLiveClient } from "../transport.ts";
import type { LiveFixture, LiveThresholds, SearchHit } from "../types.ts";

// Orchestrator tests for runLiveGate (issue #322 seeding/teardown + isolation
// regression, #324 composite gate). These drive a structural fake at the
// OpenBrainLiveClient seam so no hosted server is touched. What they prove:
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
// booleans, and scores. These tests also assert no memory body leaks into the
// receipt.

const CONFIG: LiveEvalConfig = {
  baseUrl: "http://127.0.0.1:3100",
  primaryToken: "primary-token",
  negativeToken: "primary-token",
  negativeTokenIsDistinct: false,
  primaryNamespace: "eval-live-recall-run-test",
  negativeNamespace: "eval-live-recall-run-test-negative",
  searchMode: "hybrid",
  timeoutMs: 1000,
};

const THRESHOLDS: LiveThresholds = {
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
const FIXTURE: LiveFixture = {
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

interface FakeOptions {
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
}

interface FakeState {
  seeded: Map<string, { table: string; namespace: string }>;
  archived: string[];
  closed: number;
}

/**
 * Build a pair of fake OpenBrainLiveClients (primary + negative) plus the shared
 * state they mutate. The fakes model just enough server behavior for the gate:
 * seeding assigns a stable server id ("srv-<fixtureId>"), primary search returns
 * the seeded primary records (best-first) mapped through their server ids, and
 * archive records the id. Negative-namespace behavior is driven by FakeOptions.
 */
function makeFakeClients(
  fixture: LiveFixture,
  opts: FakeOptions = {},
): {
  clients: GateClients;
  state: FakeState;
} {
  const state: FakeState = { seeded: new Map(), archived: [], closed: 0 };
  const serverId = (fixtureId: string) => `srv-${fixtureId}`;

  const seedFail = new Set(opts.seedFailFor ?? []);
  const archiveFail = new Set(opts.archiveFailFor ?? []);

  // Reverse index: server id -> fixture id, for building search hits.
  const byServerId = (id: string) => id.replace(/^srv-/, "");

  function makeClient(role: "primary" | "negative"): OpenBrainLiveClient {
    const fake = {
      async logMemory(o: {
        table: string;
        content: string;
        tags: string[];
        namespace: string;
      }) {
        // Which fixture entry is this? Match by content (unique per entry).
        const entry = fixture.corpus.find((c) => c.content === o.content);
        const fixtureId = entry?.id ?? "unknown";
        if (seedFail.has(fixtureId)) {
          throw new LiveTransportError(`log:${fixtureId}:error`, false);
        }
        const id = serverId(fixtureId);
        state.seeded.set(id, { table: o.table, namespace: o.namespace });
        return { id, namespace: o.namespace };
      },
      async search(o: { namespace: string }): Promise<SearchHit[]> {
        if (opts.searchThrows) {
          throw new LiveTransportError("search_brain:timeout", false);
        }
        // Return the seeded PRIMARY records as ranked hits (best-first: a then b),
        // plus any injected extra hits (e.g. a leaked negative id).
        const primaryFixtureIds = fixture.corpus
          .filter((c) => c.namespace_role === "primary")
          .map((c) => c.id);
        const hitFixtureIds = [
          ...primaryFixtureIds,
          ...(opts.extraPrimaryHits ?? []),
        ];
        return hitFixtureIds
          .filter((fid) => state.seeded.has(serverId(fid)))
          .map((fid) => ({
            id: serverId(fid),
            source_type: "thoughts",
            namespace: o.namespace,
          }));
      },
      async attemptRead(): Promise<{ denied: boolean; hitCount: number }> {
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

function run(fixture: LiveFixture, opts: FakeOptions = {}) {
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
function assertContentFree(receipt: unknown): void {
  const json = JSON.stringify(receipt);
  expect(json).not.toContain("body");
  expect(json).not.toContain("secret");
  expect(json).not.toContain("primary a body");
  expect(json).not.toContain("must never surface");
}

describe("runLiveGate happy path", () => {
  it("seeds, scores, proves isolation, tears down, and reports PASS", async () => {
    const { outcome, state } = run(FIXTURE);
    const { receipt, passed, scorecard } = await outcome;

    expect(passed).toBe(true);
    expect(scorecard.passed).toBe(true);
    // Seeded counts split by role.
    expect(receipt.seeded).toEqual({ primary: 2, negative: 1 });
    // Metrics reflect both relevant primary records at ranks 1 and 2.
    expect(receipt.metrics.recall_at_k).toBe(1);
    expect(receipt.metrics.mrr).toBe(1);
    expect(receipt.metrics.namespace_leaks).toBe(0);
    // Negative control ran and denied.
    expect(receipt.negative_control.ran).toBe(true);
    expect(receipt.negative_control.denied).toBe(true);
    expect(receipt.negative_control.cross_token).toBe(false);
    // Teardown archived exactly the 3 seeded records, nothing stranded.
    expect(receipt.teardown).toEqual({
      attempted: 3,
      archived: 3,
      already_absent: 0,
      failed: 0,
    });
    expect(state.archived.sort()).toEqual(
      ["srv-neg-secret", "srv-prim-a", "srv-prim-b"].sort(),
    );
    expect(receipt.failures).toEqual([]);
    assertContentFree(receipt);
  });

  it("maps server ids back to fixture ids for citation/count scoring", async () => {
    const { outcome } = run(FIXTURE);
    const { receipt } = await outcome;
    // The single probe found both relevant records: recall 1, precision 2/5.
    const probe = receipt.probes.find((p) => p.probe_id === "probe-1");
    expect(probe).toBeDefined();
    expect(probe?.recall_at_k).toBe(1);
    expect(probe?.precision_at_k).toBe(0.4);
    expect(probe?.namespace_leaks).toBe(0);
  });
});

describe("runLiveGate teardown discipline", () => {
  it("tears down the records seeded so far when seeding fails partway", async () => {
    // Fail seeding the negative record (last). prim-a + prim-b are already
    // seeded and MUST be archived even though the run throws.
    const { outcome, state } = run(FIXTURE, { seedFailFor: ["neg-secret"] });
    await expect(outcome).rejects.toThrow(LiveTransportError);
    // The two successfully-seeded records were torn down; the failed one never
    // got a server id, so it is not stranded.
    expect(state.archived.sort()).toEqual(["srv-prim-a", "srv-prim-b"].sort());
  });

  it("tears down all seeded records when a query throws", async () => {
    const { outcome, state } = run(FIXTURE, { searchThrows: true });
    await expect(outcome).rejects.toThrow(LiveTransportError);
    // All 3 records were seeded before the query failed -> all 3 archived.
    expect(state.archived.length).toBe(3);
  });

  it("fails the gate (never PASS) when a teardown archive fails", async () => {
    // Everything else is clean, but archiving prim-a throws. The run must NOT
    // report PASS -- a stranded record is a gate failure, not a silent success.
    const { outcome } = run(FIXTURE, { archiveFailFor: ["prim-a"] });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.teardown.failed).toBe(1);
    expect(receipt.teardown.archived).toBe(2);
    expect(
      receipt.failures.some((f) => f.includes("teardown failed to archive")),
    ).toBe(true);
    // Metrics still computed and content-free.
    expect(receipt.metrics.recall_at_k).toBe(1);
    assertContentFree(receipt);
  });
});

describe("runLiveGate negative-control (isolation) discipline", () => {
  it("fails when the negative read is allowed but empty (not a denial)", async () => {
    const { outcome } = run(FIXTURE, { negativeRead: "empty" });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.negative_control.ran).toBe(true);
    expect(receipt.negative_control.denied).toBe(false);
    expect(
      receipt.failures.some((f) => f.includes("negative-control not denied")),
    ).toBe(true);
  });

  it("fails when the negative read leaks a record (allowed, non-empty)", async () => {
    const { outcome } = run(FIXTURE, { negativeRead: "leak" });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.negative_control.denied).toBe(false);
    expect(receipt.negative_control.observed_hit_count).toBe(1);
    expect(
      receipt.failures.some((f) => f.includes("negative-control not denied")),
    ).toBe(true);
  });

  it("fails (content-free) and tears down when the negative read throws a non-denial error", async () => {
    // A non-denial transport error during the isolation probe means the proof
    // could not be established. probeNegativeControl catches it and reports
    // denied=false with a redacted failure label, so the gate does NOT throw --
    // it completes, tears down, and reports FAIL (isolation unproven).
    const { outcome, state } = run(FIXTURE, { negativeRead: "throws" });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.negative_control.ran).toBe(true);
    expect(receipt.negative_control.denied).toBe(false);
    // The failure label is content-free (redacted transport label only).
    expect(receipt.negative_control.failure).toContain(
      "negative-control read failed",
    );
    expect(receipt.negative_control.failure).not.toContain("body");
    // Teardown still ran for all seeded records.
    expect(state.archived.length).toBe(3);
    assertContentFree(receipt);
  });

  it("counts a leaked negative id in the primary result as a namespace leak and fails", async () => {
    // Inject the negative fixture id into the PRIMARY probe search result: the
    // gate must count it as a leak (max_namespace_leaks=0 -> fail).
    const { outcome } = run(FIXTURE, { extraPrimaryHits: ["neg-secret"] });
    const { receipt, passed, scorecard } = await outcome;
    expect(receipt.metrics.namespace_leaks).toBe(1);
    expect(scorecard.passed).toBe(false);
    expect(passed).toBe(false);
    expect(receipt.failures.some((f) => f.includes("namespace_leaks"))).toBe(
      true,
    );
    assertContentFree(receipt);
  });
});

describe("runLiveGate composite verdict", () => {
  it("requires clean teardown AND denial AND thresholds for PASS", async () => {
    // Baseline PASS already proven above; here confirm no single failure mode
    // slips through: a clean metrics + denial run with a stranded record fails.
    const { outcome } = run(FIXTURE, { archiveFailFor: ["neg-secret"] });
    const { passed, receipt } = await outcome;
    expect(receipt.negative_control.denied).toBe(true);
    expect(receipt.metrics.recall_at_k).toBe(1);
    expect(receipt.teardown.failed).toBe(1);
    // Even with metrics + isolation green, the stranded record blocks PASS.
    expect(passed).toBe(false);
  });

  it("throws before any live write when thresholds do not apply to the fixture", async () => {
    const { clients, state } = makeFakeClients(FIXTURE);
    await expect(
      runLiveGate({
        fixture: FIXTURE,
        thresholds: {
          ...THRESHOLDS,
          applies_to_fixture_id: "some-other-fixture",
        },
        config: CONFIG,
        clients,
        commit: "c",
        generatedAt: "2026-07-22T00:00:00.000Z",
      }),
    ).rejects.toThrow(/apply to fixture/);
    // No seeding happened, so nothing to tear down.
    expect(state.seeded.size).toBe(0);
    expect(state.archived.length).toBe(0);
  });
});
