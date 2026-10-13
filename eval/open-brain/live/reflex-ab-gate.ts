import type { LiveEvalConfig } from "./config.ts";
import {
  LiveTransportError,
  type ContextPackScope,
  type OpenBrainLiveClient,
  type ReflexPointersPayload,
} from "./transport.ts";
import { withTeardownFailedCount } from "./gate.ts";
import type {
  ReflexAbFixture,
  ReflexAbNegativeControl,
  ReflexAbReceipt,
  ReflexAbSeededRecord,
} from "./reflex-ab-types.ts";
import {
  collectKnownPointerRefs,
  verifyArm,
  type KnownPointerRefs,
} from "./reflex-ab-gate-support.ts";
import {
  buildComparison,
  contrastFailures,
  negativeControlFailures,
  seededCounts,
} from "./reflex-ab-gate-comparison.ts";

// Live REFLEX A/B suppression gate orchestrator (REFLEX-4, issue #335).
//
// One run:
//   1. Seed a unique throwaway namespace (and a mandatory sibling negative
//      namespace) with the sealed synthetic corpus.
//   2. Call the real `agent_reflex_pointers` tool THREE times over the SAME
//      seeded evidence and exact scope:
//        - OFF arm: no prior_context. Every net-new authorized durable record
//          surfaces as a body-free cited pointer -- including the "already-known"
//          seeds (that is the redundant-resurfacing baseline).
//        - CONTROL arm: a SECOND unsuppressed call (no prior_context) over the
//          same seed/query. It exists so the gate can prove the known items
//          resurface STABLY across two unsuppressed calls; without it, a variable
//          ranked recall that dropped the known items on its own could be
//          misattributed to suppression on the ON arm.
//        - ON arm: the ALREADY-KNOWN seeds' OWN emitted pointer references
//          (the exact citation_id + source_ref the OFF arm returned for them) are
//          echoed back as prior_context, so the shared recall suppresses them
//          before any pointer is emitted.
//   3. Compare: the two unsuppressed arms (OFF/CONTROL) must resurface the SAME
//      non-vacuous already-known set (stable baseline), the gate must have fed the
//      ON arm a non-empty prior_context that EXACTLY covers that emitted known
//      set, and suppression ENABLED must then return zero redundant resurfacing
//      while preserving the net-new evidence every arm shares.
//   4. Prove cross-namespace denial with an explicit negative control.
//   5. ALWAYS tear down exactly this run's records -- even on partial failure.
//
// The A/B contrast is built from the REAL references the tool emitted for the
// known seeds, not a fabricated citation string: a real agent echoes back the
// identities it was handed, so feeding the OFF arm's own known-seed pointers as
// the ON arm's prior_context exercises the exact suppression bijection.
//
// Both arms independently clear the established EVAL-3 functional bar: every
// pointer cited (citation bijection), body-free (identity/source_ref only),
// whole-pack budget respected with a complete allocation order, exact-scope
// authorized, and no negative-namespace leak. The receipt is content-free:
// labels, ids, counts, booleans -- never a memory body. Placement stays
// client-owned; the gate never injects into an MCP _meta channel.
//
// The pure verification helpers live in reflex-ab-gate-support.ts (per-arm
// verdicts) and reflex-ab-gate-comparison.ts (the A/B comparison and the
// run-level failure lists); this module owns the live orchestration.

export interface ReflexAbGateClients {
  /** Reads/writes/archives the primary throwaway namespace and runs the reflex. */
  primary: OpenBrainLiveClient;
  /** Seeds/archives the negative sibling namespace (mandatory isolation control). */
  negative: OpenBrainLiveClient;
}

export interface RunReflexAbGateOptions {
  fixture: ReflexAbFixture;
  config: LiveEvalConfig;
  clients: ReflexAbGateClients;
  /** Whole-pack budget in tokens for each reflex build (shared by both arms). */
  budgetMaxTokens: number;
  /** Exact non-namespace scope coordinates for the reflex call. */
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

export interface ReflexAbGateOutcome {
  receipt: ReflexAbReceipt;
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
 * skips a corpus entry. Mirrors the complete-pack gate's seedEntry.
 */
async function seedEntry(
  entry: ReflexAbFixture["corpus"][number],
  config: LiveEvalConfig,
  clients: ReflexAbGateClients,
): Promise<ReflexAbSeededRecord> {
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
    prior_known: entry.prior_known === true,
  };
}

/**
 * Archive every seeded record through its owning client, tolerating individual
 * failures so one bad archive never strands the rest. Identical discipline to the
 * recall/complete-pack gates' teardown.
 */
async function teardown(
  seeded: ReflexAbSeededRecord[],
  clients: ReflexAbGateClients,
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
 * Explicit cross-namespace denial proof, mirroring the complete-pack gate's
 * probeNegativeControl. The PRIMARY caller attempts a primary-identity read of
 * the NEGATIVE namespace, and the server must DENY it. An allowed-but-empty read
 * is NOT proof. Runs after seeding, before teardown. Content-free.
 */
async function probeNegativeControl(
  fixture: ReflexAbFixture,
  config: LiveEvalConfig,
  clients: ReflexAbGateClients,
): Promise<ReflexAbNegativeControl> {
  const proof: ReflexAbNegativeControl = {
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
    const label =
      error instanceof LiveTransportError ? error.label : "attempt-read-error";
    proof.denied = false;
    proof.failure = `negative-control read failed: ${label}`;
    return proof;
  }

  proof.observed_hit_count = result.hitCount;
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
  seeded: ReflexAbSeededRecord[];
  offPayload: ReflexPointersPayload;
  controlPayload: ReflexPointersPayload;
  onPayload: ReflexPointersPayload;
  knownRefs: KnownPointerRefs;
  negativeControl: ReflexAbNegativeControl;
  teardownTally: TeardownTally;
}

/**
 * Seed, run the three reflex arms, and probe the denial control. Wrapped so
 * teardown ALWAYS runs; a thrown error is re-raised only AFTER teardown, with the
 * content-free teardown failed count preserved.
 */
async function runLivePhase(opts: RunReflexAbGateOptions): Promise<LivePhaseResult> {
  const { fixture, config, clients, budgetMaxTokens, scope } = opts;

  const seeded: ReflexAbSeededRecord[] = [];
  const serverIdToRecord = new Map<string, ReflexAbSeededRecord>();
  let deferredError: unknown = null;
  let offPayload: ReflexPointersPayload | null = null;
  let controlPayload: ReflexPointersPayload | null = null;
  let onPayload: ReflexPointersPayload | null = null;
  let knownRefs: KnownPointerRefs = {
    refs: [],
    emittedKnownFixtureIds: [],
    referencedServerIds: new Set<string>(),
  };
  let negativeControl: ReflexAbNegativeControl = {
    ran: false,
    denied: false,
    observed_hit_count: 0,
    cross_token: config.negativeTokenIsDistinct,
    failure: "negative-control proof did not run",
  };

  const reflexScope: ContextPackScope = {
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
      const record = await seedEntry(entry, config, clients);
      seeded.push(record);
      serverIdToRecord.set(record.server_id, record);
    }

    // --- OFF arm: no prior_context. Establishes the resurfacing baseline. ---
    offPayload = await clients.primary.reflexPointers({
      scope: reflexScope,
      query: fixture.query,
      budgetMaxTokens,
    });

    // --- CONTROL arm: a SECOND unsuppressed call over the SAME seed/query, still
    // with no prior_context. It exists solely to prove the known items resurface
    // STABLY across two unsuppressed calls, so a variable ranked recall that
    // happened to drop the known items cannot be misattributed to suppression on
    // the ON arm. It shares the OFF arm's exact scope, query, and budget. ---
    controlPayload = await clients.primary.reflexPointers({
      scope: reflexScope,
      query: fixture.query,
      budgetMaxTokens,
    });

    // Build the ON arm's prior_context from the EXACT references the OFF arm
    // emitted for the already-known seeds -- the identities a model would echo
    // back. This exercises the real suppression bijection, not a fabricated key.
    knownRefs = collectKnownPointerRefs(offPayload, serverIdToRecord);

    // --- ON arm: prior_context set to the already-known seeds' own references. ---
    onPayload = await clients.primary.reflexPointers({
      scope: reflexScope,
      query: fixture.query,
      priorContext: knownRefs.refs,
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
  if (!offPayload || !controlPayload || !onPayload) {
    throw new LiveTransportError("agent_reflex_pointers:no-payload", false);
  }

  return {
    seeded,
    offPayload,
    controlPayload,
    onPayload,
    knownRefs,
    negativeControl,
    teardownTally,
  };
}

/**
 * Run the full reflex A/B gate. Seeding, both reflex calls, and the denial probe
 * are wrapped so teardown always runs; a thrown error is re-raised only AFTER
 * teardown, with the content-free teardown failed count preserved. PASS requires
 * both arms clear the EVAL-3 bar, the A/B contrast holds, the net-new evidence is
 * preserved, the denial control ran and denied, and teardown is clean.
 */
export async function runReflexAbGate(
  opts: RunReflexAbGateOptions,
): Promise<ReflexAbGateOutcome> {
  const { fixture, config, commit } = opts;
  const live = await runLivePhase(opts);
  const { seeded, teardownTally } = live;

  // --- Verify each arm against the EVAL-3 functional bar + ground truth ---
  const armOff = verifyArm("off", live.offPayload, seeded, fixture);
  // The control arm is unsuppressed, so it is verified as an "off" arm: it must
  // clear the exact same functional bar (cited, body-free, budgeted, no leaks,
  // net-new present) as the OFF arm.
  const armControl = verifyArm("off", live.controlPayload, seeded, fixture);
  const armOn = verifyArm("on", live.onPayload, seeded, fixture);

  // --- A/B comparison: the REFLEX-4 acceptance signal ---
  const comparison = buildComparison({
    offPayload: live.offPayload,
    controlPayload: live.controlPayload,
    armOff,
    armControl,
    armOn,
    knownRefs: live.knownRefs,
    seeded,
    fixture,
  });

  const failures: string[] = [
    ...armOff.failures,
    ...armControl.failures,
    ...armOn.failures,
    ...contrastFailures(comparison, armOff),
    ...negativeControlFailures(live.negativeControl),
  ];

  // Teardown discipline.
  if (teardownTally.failed !== 0) {
    failures.push(
      `teardown failed to archive ${teardownTally.failed} of ${teardownTally.attempted} seeded records`,
    );
  }

  const passed = failures.length === 0;

  const receipt: ReflexAbReceipt = {
    schema: "openbrain.reflex_ab_gate.v1",
    generated_at: opts.generatedAt,
    commit,
    fixture_id: fixture.fixture_id,
    primary_namespace: config.primaryNamespace,
    negative_namespace: config.negativeNamespace,
    seeded: seededCounts(seeded, fixture),
    arm_off: armOff,
    arm_control: armControl,
    arm_on: armOn,
    comparison,
    negative_control: live.negativeControl,
    passed,
    failures,
    teardown: teardownTally,
  };

  return { receipt, passed };
}
