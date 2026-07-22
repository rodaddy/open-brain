import type { LiveEvalConfig } from "./config.ts";
import { buildScorecard } from "./metrics.ts";
import { LiveTransportError, type OpenBrainLiveClient } from "./transport.ts";
import type {
  LiveCorpusEntry,
  LiveFixture,
  LiveGateReceipt,
  LiveScorecard,
  LiveThresholds,
  NegativeControlProof,
  SeededRecord,
} from "./types.ts";

// Live recall gate orchestrator.
//
// One run: seed a unique throwaway namespace (and a sibling negative namespace)
// with the sealed synthetic fixture, run each recall probe under the primary
// namespace, score deterministic ranking metrics, apply versioned thresholds,
// and ALWAYS tear down exactly the records this run created -- even when a
// probe or a threshold check fails partway through.
//
// Teardown is mutation-safe: it archives only server ids that this run created,
// each under its own table, through the namespace-scoped archive_entry tool. It
// never issues a bulk or query-shaped delete, so it cannot touch a record it
// did not create.

export interface GateClients {
  /** Reads/writes/archives the primary throwaway namespace. */
  primary: OpenBrainLiveClient;
  /**
   * Seeds/reads/archives the negative sibling namespace. This is a MANDATORY
   * real negative control: it is bound to a distinct X-Namespace (optionally a
   * distinct token too), so the primary caller must not be able to read what it
   * writes. It is never optional -- the gate cannot prove isolation without it.
   */
  negative: OpenBrainLiveClient;
}

export interface RunGateOptions {
  fixture: LiveFixture;
  thresholds: LiveThresholds;
  config: LiveEvalConfig;
  clients: GateClients;
  commit: string;
  generatedAt: string;
}

export interface GateOutcome {
  scorecard: LiveScorecard;
  receipt: LiveGateReceipt;
  /**
   * Composite verdict. True only when scorecard thresholds are met AND the
   * negative-control isolation proof ran and denied AND teardown stranded no
   * seeded record. Never true on a metrics-only pass.
   */
  passed: boolean;
}

interface TeardownTally {
  attempted: number;
  archived: number;
  already_absent: number;
  failed: number;
}

/**
 * Seed one entry with the owning client for its namespace role and record the
 * resulting server id for scoring + teardown. Both the primary and negative
 * clients always exist (the negative control is mandatory), so seeding never
 * silently skips a corpus entry.
 */
async function seedEntry(
  entry: LiveCorpusEntry,
  config: LiveEvalConfig,
  clients: GateClients,
): Promise<SeededRecord> {
  const isNegative = entry.namespace_role === "negative";
  const client = isNegative ? clients.negative : clients.primary;
  const namespace = isNegative
    ? config.negativeNamespace
    : config.primaryNamespace;

  const result = await client.logMemory({
    table: entry.table,
    content: entry.content,
    tags: entry.tags,
    namespace,
  });
  return {
    fixture_id: entry.id,
    table: entry.table,
    server_id: result.id,
    namespace,
    namespace_role: entry.namespace_role,
  };
}

/**
 * Archive every seeded record through its owning client, tolerating individual
 * failures so one bad archive never strands the rest. Negative-namespace records
 * are archived with the negative client (the only token that owns them).
 */
async function teardown(
  seeded: SeededRecord[],
  clients: GateClients,
): Promise<TeardownTally> {
  const tally: TeardownTally = {
    attempted: 0,
    archived: 0,
    already_absent: 0,
    failed: 0,
  };
  for (const record of seeded) {
    const client =
      record.namespace_role === "negative" ? clients.negative : clients.primary;
    tally.attempted += 1;
    try {
      const outcome = await client.archive({
        table: record.table,
        id: record.server_id,
      });
      if (outcome === "archived") tally.archived += 1;
      else tally.already_absent += 1;
    } catch {
      // Content-free: never surface the record body or an error string that
      // could carry one. The count is the only signal the receipt needs.
      tally.failed += 1;
    }
  }
  return tally;
}

/**
 * Preserve the content-free teardown failed COUNT when a deferred seed/query
 * error is rethrown after teardown. When nothing was stranded (failed === 0),
 * the original error passes through unchanged. When records were stranded, a new
 * LiveTransportError carries the original (already-redacted) label with a
 * `;teardown-failed=<n>` suffix -- only the integer count, never a record id,
 * body, or raw error string -- and preserves the original `denied` flag. A
 * non-LiveTransportError is left untouched so we never widen an unknown error's
 * content-free guarantees.
 */
export function withTeardownFailedCount(
  error: unknown,
  teardownFailed: number,
): unknown {
  if (teardownFailed <= 0) return error;
  if (error instanceof LiveTransportError) {
    return new LiveTransportError(
      `${error.label};teardown-failed=${teardownFailed}`,
      error.denied,
    );
  }
  return error;
}

/**
 * Build the fixture-local retrieved-id list for one probe from live search hits.
 * Maps server ids back to fixture ids using the seed map, and appends any
 * forbidden (negative-namespace) server id that leaked so the metric can count
 * it. Preserves rank order.
 */
function toFixtureRetrieval(
  hits: { id: string }[],
  serverIdToFixtureId: Map<string, string>,
): string[] {
  const out: string[] = [];
  for (const hit of hits) {
    const fixtureId = serverIdToFixtureId.get(hit.id);
    if (fixtureId) out.push(fixtureId);
  }
  return out;
}

/**
 * Explicit negative-control proof. The PRIMARY caller attempts to read the
 * NEGATIVE namespace (which the negative control seeded) and the server must
 * DENY that read. An empty-but-successful read is NOT proof of denial -- the
 * namespace being empty for the primary caller looks identical to a working
 * isolation boundary, so we require an actual permission denial.
 *
 * The probe queries are the forbidden-bearing probe queries from the fixture,
 * chosen because they are the ones most likely to surface the negative records
 * if isolation were broken. Runs after seeding (records exist) and before
 * teardown. Content-free: only booleans and counts, never hit bodies.
 */
async function probeNegativeControl(
  fixture: LiveFixture,
  config: LiveEvalConfig,
  clients: GateClients,
  topK: number,
): Promise<NegativeControlProof> {
  const proof: NegativeControlProof = {
    ran: true,
    denied: false,
    observed_hit_count: 0,
    cross_token: config.negativeTokenIsDistinct,
  };

  // Prefer probes that declare a forbidden (negative) id; fall back to all
  // probes so the proof always exercises at least one read.
  const withForbidden = fixture.probes.filter(
    (p) => p.forbidden_ids.length > 0,
  );
  const probes = withForbidden.length > 0 ? withForbidden : fixture.probes;

  let anyDenied = false;
  let anyAllowed = false;
  let totalHits = 0;
  for (const probe of probes) {
    let result;
    try {
      result = await clients.primary.attemptRead({
        query: probe.query,
        namespace: config.negativeNamespace,
        limit: topK,
        searchMode: config.searchMode,
      });
    } catch (error) {
      // A non-denial transport error means we could not establish the proof.
      const label =
        error instanceof LiveTransportError
          ? error.label
          : "attempt-read-error";
      proof.denied = false;
      proof.failure = `negative-control read failed: ${label}`;
      return proof;
    }
    if (result.denied) {
      anyDenied = true;
    } else {
      anyAllowed = true;
      totalHits += result.hitCount;
    }
  }

  proof.observed_hit_count = totalHits;
  // Isolation is proven ONLY when every read was denied and none was allowed.
  proof.denied = anyDenied && !anyAllowed;
  if (!proof.denied) {
    proof.failure = anyAllowed
      ? "primary caller was permitted to read the negative namespace"
      : "no negative-namespace read was denied";
  }
  return proof;
}

/**
 * Run the full gate. Seeding and querying failures are caught so teardown still
 * runs; the thrown error (if any) is re-raised only AFTER teardown completes.
 * PASS requires all three: scorecard thresholds met, the negative-control proof
 * denied, and teardown left nothing behind.
 */
export async function runLiveGate(opts: RunGateOptions): Promise<GateOutcome> {
  const { fixture, thresholds, config, clients, commit, generatedAt } = opts;

  if (thresholds.applies_to_fixture_id !== fixture.fixture_id) {
    throw new Error(
      `thresholds ${thresholds.thresholds_id} apply to fixture ${thresholds.applies_to_fixture_id}, not ${fixture.fixture_id}`,
    );
  }

  const seeded: SeededRecord[] = [];
  const serverIdToFixtureId = new Map<string, string>();
  let deferredError: unknown = null;
  let retrievedByProbe: Record<string, string[]> = {};
  // Default proof: did-not-run. Only replaced by a real probe result when
  // seeding + querying complete without a deferred error.
  let negativeControl: NegativeControlProof = {
    ran: false,
    denied: false,
    observed_hit_count: 0,
    cross_token: config.negativeTokenIsDistinct,
    failure: "negative-control proof did not run",
  };

  try {
    // --- Seed (both namespaces; negative control is mandatory) ---
    for (const entry of fixture.corpus) {
      const record = await seedEntry(entry, config, clients);
      seeded.push(record);
      serverIdToFixtureId.set(record.server_id, record.fixture_id);
    }

    // --- Query + collect fixture-local retrievals per probe ---
    const collected: Record<string, string[]> = {};
    for (const probe of fixture.probes) {
      const hits = await clients.primary.search({
        query: probe.query,
        namespace: config.primaryNamespace,
        limit: thresholds.top_k,
        searchMode: config.searchMode,
      });
      collected[probe.id] = toFixtureRetrieval(hits, serverIdToFixtureId);
    }
    retrievedByProbe = collected;

    // --- Explicit negative-control isolation proof (before teardown) ---
    negativeControl = await probeNegativeControl(
      fixture,
      config,
      clients,
      thresholds.top_k,
    );
  } catch (error) {
    // Defer: teardown must still run before we surface the failure.
    deferredError = error;
  }

  // --- Teardown (always, even after a partial failure) ---
  const teardownTally = await teardown(seeded, clients);

  if (deferredError) {
    // Re-raise the original (already content-free) seed/query error, but preserve
    // the teardown failed COUNT so a partial-failure run that also stranded
    // records does not silently lose that signal. Only the integer count is
    // attached -- never a record id, body, or raw error string.
    throw withTeardownFailedCount(deferredError, teardownTally.failed);
  }

  // --- Score + threshold ---
  const scorecard = buildScorecard(fixture, thresholds, retrievedByProbe);

  const primarySeeded = seeded.filter(
    (r) => r.namespace_role === "primary",
  ).length;
  const negativeSeeded = seeded.filter(
    (r) => r.namespace_role === "negative",
  ).length;

  // Composite gate verdict. A metrics-only pass is never enough: the isolation
  // proof must have denied, and teardown must have stranded nothing.
  const teardownClean = teardownTally.failed === 0;
  const gateFailures = [...scorecard.failures];
  if (!negativeControl.ran) {
    gateFailures.push(
      `negative-control proof did not run: ${negativeControl.failure ?? "unknown"}`,
    );
  } else if (!negativeControl.denied) {
    gateFailures.push(
      `negative-control not denied: ${negativeControl.failure ?? "isolation not proven"}`,
    );
  }
  if (!teardownClean) {
    gateFailures.push(
      `teardown failed to archive ${teardownTally.failed} of ${teardownTally.attempted} seeded records`,
    );
  }
  const passed =
    scorecard.passed &&
    negativeControl.ran &&
    negativeControl.denied &&
    teardownClean;

  const receipt: LiveGateReceipt = {
    schema: "openbrain.live_recall_gate.v1",
    generated_at: generatedAt,
    commit,
    fixture_id: fixture.fixture_id,
    thresholds_id: thresholds.thresholds_id,
    top_k: thresholds.top_k,
    primary_namespace: config.primaryNamespace,
    negative_namespace: config.negativeNamespace,
    seeded: { primary: primarySeeded, negative: negativeSeeded },
    metrics: {
      recall_at_k: scorecard.recall_at_k,
      precision_at_k: scorecard.precision_at_k,
      mrr: scorecard.mrr,
      namespace_leaks: scorecard.namespace_leaks,
    },
    thresholds: thresholds.thresholds,
    probes: scorecard.probes.map((p) => ({
      probe_id: p.probe_id,
      recall_at_k: p.recall_at_k,
      precision_at_k: p.precision_at_k,
      reciprocal_rank: p.reciprocal_rank,
      namespace_leaks: p.namespace_leaks,
    })),
    negative_control: {
      ran: negativeControl.ran,
      denied: negativeControl.denied,
      observed_hit_count: negativeControl.observed_hit_count,
      cross_token: negativeControl.cross_token,
      failure: negativeControl.failure,
    },
    passed,
    failures: gateFailures,
    teardown: teardownTally,
  };

  return { scorecard, receipt, passed };
}
