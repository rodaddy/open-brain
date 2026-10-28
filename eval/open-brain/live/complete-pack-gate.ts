import type { LiveEvalConfig } from "./config.ts";
import {
  LiveTransportError,
  type ContextPackPayload,
  type ContextPackScope,
  type OpenBrainLiveClient,
} from "./transport.ts";
import { withTeardownFailedCount } from "./gate.ts";
import {
  COMPLETE_PACK_SECTION_NAMES,
  type CompletePackFixture,
  type CompletePackReceipt,
  type CompletePackSeededRecord,
  type NegativeControlVerdict,
} from "./complete-pack-types.ts";
import { classifySection } from "./complete-pack-gate-sections.ts";
import {
  verifyBudget,
  verifyCitations,
  verifyIsolation,
} from "./complete-pack-gate-verify.ts";
import {
  budgetFailures,
  citationFailures,
  isolationFailures,
  negativeControlFailures,
  sectionFailures,
  statusFailures,
} from "./complete-pack-gate-failures.ts";

// Live COMPLETE CONTEXT PACK gate orchestrator (EVAL-3, issue #330).
//
// One run: seed a unique throwaway namespace (and a sibling negative namespace)
// with the sealed synthetic corpus, call the real `agent_context_pack` tool
// under the primary namespace requesting ALL NINE sections and one whole-pack
// budget, verify the assembled pack against six functional properties, and
// ALWAYS tear down exactly the records this run created -- even when the pack
// call or a verification fails partway through.
//
// The six properties, all functional (no assertions about SQL shape or
// internal call counts):
//   1. Presence-or-defined-emptiness: every requested section either carries
//      items or is in its DEFINED-EMPTY state (a recognized empty/denial marker,
//      or a legitimately-empty RAM-only section, or a defined scope-denial).
//   2. Exact-scope isolation: durable_lane_context reports its exact-scope
//      defined-empty for the fresh throwaway scope, no negative-namespace record
//      surfaces in any section item, lane, event, source_ref, or citation, and
//      the expected primary recall IS present (a hollow empty recall would
//      otherwise hide a broken predicate).
//   3. Citation truth: the top-level citations array is a bijection of the
//      emitted item citation_ids (durable_memory/pointer items, the lane, AND
//      each durable_lane_context event) -- no dangling citation, no uncited item.
//   4. Serialized budget: JSON.stringify(sections) stays within the reported
//      whole-pack content_char_limit, and an allocation order covering all nine
//      sections is present.
//   5. Per-section contribution: the serialized-character contribution and item
//      count of every section is recorded in the receipt.
//   6. Explicit cross-namespace denial: the PRIMARY caller attempts a
//      primary-identity read against the NEGATIVE namespace and the server MUST
//      deny it. A leak-scan over the emitted pack only catches a forbidden id
//      that happened to surface; a forbidden record ranked below the result cut
//      would still pass. The denial probe proves the boundary REFUSES the read
//      outright -- an allowed-but-empty read (which looks identical to a working
//      boundary) is NOT proof and fails the gate. Reuses the recall gate's
//      attemptRead probe transport.
//
// Teardown reuses the recall gate's discipline: per-record, namespace-scoped
// archive_entry only, never a bulk or query-shaped delete, so it can only touch
// records this run created. The receipt is content-free: labels, ids, counts,
// booleans -- never a memory body.
//
// The pure verification helpers live in complete-pack-gate-sections.ts (section
// classification), complete-pack-gate-verify.ts (citations, budget, isolation),
// and complete-pack-gate-failures.ts (the run-level failure lists); this module
// owns the live orchestration.

export interface CompletePackGateClients {
  /** Reads/writes/archives the primary throwaway namespace and builds the pack. */
  primary: OpenBrainLiveClient;
  /** Seeds/archives the negative sibling namespace (mandatory isolation control). */
  negative: OpenBrainLiveClient;
}

export interface RunCompletePackGateOptions {
  fixture: CompletePackFixture;
  config: LiveEvalConfig;
  clients: CompletePackGateClients;
  /** Whole-pack budget in tokens for the single pack build. */
  budgetMaxTokens: number;
  /** Exact non-namespace scope coordinates for the pack call. */
  scope: {
    agent: string;
    platform: string;
    server_id: string;
    channel_id: string;
    thread_id?: string | null;
    session_key: string;
  };
  commit: string;
  generatedAt: string;
}

export interface CompletePackGateOutcome {
  receipt: CompletePackReceipt;
  passed: boolean;
}

interface TeardownTally {
  attempted: number;
  archived: number;
  already_absent: number;
  failed: number;
}

/**
 * Seed one entry with the owning client for its namespace role. Both clients
 * always exist (the negative control is mandatory), so seeding never silently
 * skips a corpus entry. Mirrors the recall gate's seedEntry.
 */
async function seedEntry(
  entry: CompletePackFixture["corpus"][number],
  config: LiveEvalConfig,
  clients: CompletePackGateClients,
): Promise<CompletePackSeededRecord> {
  const isNegative = entry.namespace_role === "negative";
  const client = isNegative ? clients.negative : clients.primary;
  const namespace = isNegative ? config.negativeNamespace : config.primaryNamespace;

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
 * failures so one bad archive never strands the rest. Identical discipline to
 * the recall gate's teardown.
 */
async function teardown(
  seeded: CompletePackSeededRecord[],
  clients: CompletePackGateClients,
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
      // Content-free: the count is the only signal the receipt needs.
      tally.failed += 1;
    }
  }
  return tally;
}

/** Fixed top-k for the cross-namespace denial probe read. */
const NEGATIVE_CONTROL_PROBE_TOP_K = 10;

/**
 * Explicit cross-namespace denial proof, mirroring the recall gate's
 * probeNegativeControl. The PRIMARY caller attempts a primary-identity read of
 * the NEGATIVE namespace (which the negative control seeded), and the server
 * must DENY it. An allowed-but-empty read is NOT proof: the namespace being
 * empty for the primary caller looks identical to a working isolation boundary,
 * so we require an actual permission denial. This closes the gap the emitted-pack
 * leak walk leaves open -- a forbidden record ranked below the result cut never
 * surfaces in the pack, so the walk passes, but the denial probe still fails
 * closed because the read is refused outright.
 *
 * The probe reuses the pack's recall `query` (the query the forbidden negative
 * records are most likely to match if isolation were broken). Runs after seeding
 * (records exist) and before teardown. Content-free: only booleans, a count, and
 * a redacted failure label -- never a hit body.
 */
async function probeNegativeControl(
  fixture: CompletePackFixture,
  config: LiveEvalConfig,
  clients: CompletePackGateClients,
): Promise<NegativeControlVerdict> {
  const proof: NegativeControlVerdict = {
    ran: true,
    denied: false,
    observed_hit_count: 0,
    cross_token: config.negativeTokenIsDistinct,
  };

  let result;
  try {
    result = await clients.primary.attemptRead({
      query: fixture.query,
      namespace: config.negativeNamespace,
      limit: NEGATIVE_CONTROL_PROBE_TOP_K,
      searchMode: config.searchMode,
    });
  } catch (error) {
    // A non-denial transport error means we could not establish the proof.
    const label =
      error instanceof LiveTransportError ? error.label : "attempt-read-error";
    proof.denied = false;
    proof.failure = `negative-control read failed: ${label}`;
    return proof;
  }

  proof.observed_hit_count = result.hitCount;
  // Isolation is proven ONLY by an actual denial. A successful read -- empty or
  // not -- fails: allowed-empty proves nothing and allowed-nonempty is a breach.
  proof.denied = result.denied;
  if (!proof.denied) {
    proof.failure =
      result.hitCount > 0
        ? "primary caller was permitted to read the negative namespace (non-empty)"
        : "primary caller's read of the negative namespace was allowed (empty), not denied";
  }
  return proof;
}

/** What the live phase produced, once teardown has run and errors are cleared. */
interface LivePhaseResult {
  seeded: CompletePackSeededRecord[];
  payload: ContextPackPayload;
  negativeControl: NegativeControlVerdict;
  teardownTally: TeardownTally;
}

/**
 * Seed, build the pack, and probe the denial control. Wrapped so teardown always
 * runs; a thrown error is re-raised only AFTER teardown, with the content-free
 * teardown failed count preserved (shared with the recall gate via
 * withTeardownFailedCount).
 */
async function runLivePhase(
  opts: RunCompletePackGateOptions,
): Promise<LivePhaseResult> {
  const { fixture, config, clients, budgetMaxTokens, scope } = opts;

  const seeded: CompletePackSeededRecord[] = [];
  let deferredError: unknown = null;
  let payload: ContextPackPayload | null = null;
  // Default proof: did-not-run. Only replaced by a real probe result when
  // seeding + the pack call complete without a deferred error.
  let negativeControl: NegativeControlVerdict = {
    ran: false,
    denied: false,
    observed_hit_count: 0,
    cross_token: config.negativeTokenIsDistinct,
    failure: "negative-control proof did not run",
  };

  const packScope: ContextPackScope = {
    namespace: config.primaryNamespace,
    agent: scope.agent,
    platform: scope.platform,
    server_id: scope.server_id,
    channel_id: scope.channel_id,
    thread_id: scope.thread_id ?? null,
    session_key: scope.session_key,
  };

  try {
    for (const entry of fixture.corpus) {
      seeded.push(await seedEntry(entry, config, clients));
    }

    payload = await clients.primary.contextPack({
      scope: packScope,
      query: fixture.query,
      requestedSections: COMPLETE_PACK_SECTION_NAMES,
      budgetMaxTokens,
    });

    // --- Explicit cross-namespace denial proof (after seeding, before teardown) ---
    negativeControl = await probeNegativeControl(fixture, config, clients);
  } catch (error) {
    deferredError = error;
  }

  const teardownTally = await teardown(seeded, clients);

  if (deferredError) {
    throw withTeardownFailedCount(deferredError, teardownTally.failed);
  }
  // Unreachable when deferredError is null: payload is set. Guard for the type.
  if (!payload) {
    throw new LiveTransportError("agent_context_pack:no-payload", false);
  }

  return { seeded, payload, negativeControl, teardownTally };
}

/**
 * Run the full complete-pack gate. Seeding, the pack call, and the
 * cross-namespace denial probe are wrapped so teardown always runs; a thrown
 * error is re-raised only AFTER teardown, with the content-free teardown failed
 * count preserved (shared with the recall gate via withTeardownFailedCount).
 * PASS requires all six properties AND clean teardown.
 */
export async function runCompletePackGate(
  opts: RunCompletePackGateOptions,
): Promise<CompletePackGateOutcome> {
  const { fixture, config, commit } = opts;
  const live = await runLivePhase(opts);
  const { seeded, payload, teardownTally } = live;

  // --- Verify the five functional properties ---
  const sections = COMPLETE_PACK_SECTION_NAMES.map((name) =>
    classifySection(name, payload),
  );
  const citations = verifyCitations(payload);
  const budget = verifyBudget(payload);
  const isolation = verifyIsolation(payload, seeded, fixture);

  const failures: string[] = [
    ...sectionFailures(sections),
    ...statusFailures(payload),
    ...citationFailures(citations),
    ...budgetFailures(budget),
    ...isolationFailures(isolation),
    ...negativeControlFailures(live.negativeControl),
  ];

  // Teardown discipline.
  if (teardownTally.failed !== 0) {
    failures.push(
      `teardown failed to archive ${teardownTally.failed} of ${teardownTally.attempted} seeded records`,
    );
  }

  const passed = failures.length === 0;

  const receipt: CompletePackReceipt = {
    schema: "openbrain.complete_pack_gate.v1",
    generated_at: opts.generatedAt,
    commit,
    fixture_id: fixture.fixture_id,
    primary_namespace: config.primaryNamespace,
    negative_namespace: config.negativeNamespace,
    requested_sections: [...COMPLETE_PACK_SECTION_NAMES],
    seeded: {
      primary: seeded.filter((r) => r.namespace_role === "primary").length,
      negative: seeded.filter((r) => r.namespace_role === "negative").length,
    },
    sections,
    budget,
    citations,
    isolation,
    negative_control: live.negativeControl,
    passed,
    failures,
    teardown: teardownTally,
  };

  return { receipt, passed };
}
