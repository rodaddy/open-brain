import { describe, expect, it } from "vitest";
import { labelTeardownError, runLiveGate, teardownRecords } from "../gate.ts";
import { LiveTransportError } from "../transport.ts";
import { expectTransportError } from "./transport-test-support.ts";
import {
  CONFIG,
  FIXTURE,
  THRESHOLDS,
  assertContentFree,
  makeFakeClients,
  run,
} from "./gate-test-support.ts";

// Orchestrator suites for runLiveGate (issue #322 seeding/teardown + isolation
// regression, #324 composite gate), driven by the shared structural fake in
// ./gate-test-support.ts so no hosted server is touched. The REAL-transport
// parseHits seam lives in ./gate-transport-boundary.test.ts; the harness and
// what these suites prove are documented on the support module.

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
    // The isolation probe used the PRIMARY caller against the NEGATIVE namespace
    // -- pin the live-proven call shape so a future refactor cannot silently
    // probe the primary namespace (which would prove nothing).
    expect(state.attemptReadNamespaces.length).toBeGreaterThan(0);
    for (const ns of state.attemptReadNamespaces) {
      expect(ns).toBe(CONFIG.negativeNamespace);
    }
    expect(state.attemptReadNamespaces).not.toContain(CONFIG.primaryNamespace);
    // Teardown archived exactly the 3 seeded records, nothing stranded.
    expect(receipt.teardown).toEqual({
      attempted: 3,
      archived: 3,
      already_absent: 0,
      failed: 0,
      // #671: empty on a clean run, and asserted EXACTLY so a label leaking in
      // where nothing failed would fail this test rather than pass unnoticed.
      failure_labels: [],
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

  it("preserves the content-free teardown failed COUNT when the deferred error is rethrown", async () => {
    // A query throws (deferred) AND one archive fails during teardown. The
    // rethrown error must carry the stranded-record count (content-free) so the
    // teardown failure is not lost behind the query error -- but never a record
    // id, body, or raw error string.
    const { outcome } = run(FIXTURE, {
      searchThrows: true,
      archiveFailFor: ["prim-a"],
    });
    const err = expectTransportError(
      await outcome.catch((e) => e as LiveTransportError),
    );
    expect(err).toBeInstanceOf(LiveTransportError);
    // Original redacted label preserved, teardown count appended.
    expect(err.label).toBe("search_brain:timeout;teardown-failed=1");
    expect(err.message).toBe("search_brain:timeout;teardown-failed=1");
    // Content-free: no ids or bodies.
    expect(err.label).not.toContain("srv-");
    expect(err.label).not.toContain("body");
  });

  it("leaves the deferred error unchanged when teardown strands nothing", async () => {
    const { outcome } = run(FIXTURE, { searchThrows: true });
    const err = expectTransportError(
      await outcome.catch((e) => e as LiveTransportError),
    );
    // No teardown failure -> label is untouched (no suffix).
    expect(err.label).toBe("search_brain:timeout");
  });

  it("fails the gate (never PASS) when a teardown archive fails", async () => {
    // Everything else is clean, but archiving prim-a throws. The run must NOT
    // report PASS -- a stranded record is a gate failure, not a silent success.
    const { outcome } = run(FIXTURE, { archiveFailFor: ["prim-a"] });
    const { receipt, passed } = await outcome;
    expect(passed).toBe(false);
    expect(receipt.teardown.failed).toBe(1);
    expect(receipt.teardown.archived).toBe(2);
    expect(receipt.failures.some((f) => f.includes("teardown failed to archive"))).toBe(
      true,
    );
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
    expect(receipt.negative_control.failure).toContain("negative-control read failed");
    expect(receipt.negative_control.failure).not.toContain("body");
    // Teardown still ran for all seeded records.
    expect(state.archived.length).toBe(3);
    assertContentFree(receipt);
  });

  it("fails closed (content-free) on a foreign-namespace hit even with the expected hits present", async () => {
    // The expected primary hits are returned first; a hit from a DIFFERENT
    // namespace is appended. The gate must NOT drop it (which would compress
    // ranks and hide the breach) -- it must fail the run closed. Teardown still
    // archives the 3 seeded records.
    const { outcome, state } = run(FIXTURE, {
      rawExtraPrimaryHits: [{ id: "srv-foreign", namespace: "some-other-ns" }],
    });
    const err = expectTransportError(
      await outcome.catch((e) => e as LiveTransportError),
    );
    expect(err).toBeInstanceOf(LiveTransportError);
    expect(err.label).toBe("search_brain:foreign-namespace");
    // Content-free: the offending namespace value / id never appears.
    expect(err.label).not.toContain("some-other-ns");
    expect(err.label).not.toContain("srv-foreign");
    // Teardown still ran for every seeded record.
    expect(state.archived.length).toBe(3);
  });

  it("fails closed on a hit with NO namespace even with the expected hits present", async () => {
    const { outcome, state } = run(FIXTURE, {
      rawExtraPrimaryHits: [{ id: "srv-nons", namespace: undefined }],
    });
    const err = expectTransportError(
      await outcome.catch((e) => e as LiveTransportError),
    );
    expect(err).toBeInstanceOf(LiveTransportError);
    // A missing namespace is treated as foreign (not exactly the primary ns).
    expect(err.label).toBe("search_brain:foreign-namespace");
    expect(state.archived.length).toBe(3);
  });

  it("fails closed on an UNKNOWN same-namespace id even with the expected hits present", async () => {
    // A hit carrying the correct primary namespace but an id this run never
    // created is unaccountable: our seed map cannot map it, so we cannot know it
    // is not a foreign row surfacing under our namespace. Fail closed rather than
    // discard it (a discard would compress ranks and could hide a real leak).
    const { outcome, state } = run(FIXTURE, {
      rawExtraPrimaryHits: [{ id: "srv-unknown-1234" }], // defaults to primary ns
    });
    const err = expectTransportError(
      await outcome.catch((e) => e as LiveTransportError),
    );
    expect(err).toBeInstanceOf(LiveTransportError);
    expect(err.label).toBe("search_brain:unknown-hit");
    expect(err.label).not.toContain("srv-unknown-1234");
    expect(state.archived.length).toBe(3);
  });

  it("counts a leaked negative id in the primary result as a namespace leak and fails", async () => {
    // Inject the negative fixture id into the PRIMARY probe search result: the
    // gate must count it as a leak (max_namespace_leaks=0 -> fail).
    const { outcome } = run(FIXTURE, { extraPrimaryHits: ["neg-secret"] });
    const { receipt, passed, scorecard } = await outcome;
    expect(receipt.metrics.namespace_leaks).toBe(1);
    expect(scorecard.passed).toBe(false);
    expect(passed).toBe(false);
    expect(receipt.failures.some((f) => f.includes("namespace_leaks"))).toBe(true);
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

// Issue #671: the bare `catch {}` in `teardownRecords` discarded the cleanup
// error, so when the third credentialed #653 verify reported failed=2 the
// throw's label was unrecoverable from the receipt, the log, or anywhere else.
describe("teardownRecords failure labels (#671)", () => {
  it("captures a LiveTransportError's redacted label, one per failure, in order", async () => {
    const tally = await teardownRecords(["ok", "bad-a", "bad-b"], async (record) => {
      if (record === "ok") return "archived";
      throw new LiveTransportError(`archive_entry:${record}`, false);
    });
    expect(tally.attempted).toBe(3);
    expect(tally.archived).toBe(1);
    expect(tally.failed).toBe(2);
    expect(tally.failure_labels).toEqual([
      "archive_entry:bad-a",
      "archive_entry:bad-b",
    ]);
  });

  it("keeps going after a failure — one bad record never strands the rest", async () => {
    const cleaned: string[] = [];
    const tally = await teardownRecords(["a", "b", "c"], async (record) => {
      if (record === "a") throw new Error("boom");
      cleaned.push(record);
      return "archived";
    });
    expect(cleaned).toEqual(["b", "c"]);
    expect(tally.archived).toBe(2);
    expect(tally.failed).toBe(1);
  });

  it("never lets an arbitrary error's MESSAGE into the label — class name only", async () => {
    // A receipt gets pasted into issues and PRs, and an arbitrary Error.message
    // can carry row content, a namespace value, or a token fragment.
    const secret = "namespace=rico row=super-secret-content";
    const tally = await teardownRecords(["x"], async () => {
      throw new Error(secret);
    });
    expect(tally.failure_labels).toEqual(["Error"]);
    expect(tally.failure_labels.join(" ")).not.toContain("rico");
    expect(tally.failure_labels.join(" ")).not.toContain("super-secret-content");
  });

  it("labels a non-Error throw without inventing detail", () => {
    expect(labelTeardownError("just a string")).toBe("unknown");
    expect(labelTeardownError(new LiveTransportError("tool:label", true))).toBe(
      "tool:label",
    );
  });
});
