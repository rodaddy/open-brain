import type { LiveEvalConfig } from "./config.ts";
import {
  LiveTransportError,
  type ContextPackScope,
  type OpenBrainLiveClient,
  type ReflexPointersPayload,
  type ReflexPriorContextRef,
} from "./transport.ts";
import { withTeardownFailedCount } from "./gate.ts";
import type {
  ReflexAbComparison,
  ReflexAbFixture,
  ReflexAbNegativeControl,
  ReflexAbReceipt,
  ReflexAbSeededRecord,
  ReflexArmVerdict,
} from "./reflex-ab-types.ts";

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

/** Read the emitted pointer items array (opaque records) from a reflex payload. */
function pointerItemsOf(
  payload: ReflexPointersPayload,
): Array<Record<string, unknown>> {
  const items = payload.pointers.items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (row): row is Record<string, unknown> =>
      !!row && typeof row === "object" && !Array.isArray(row),
  );
}

/** Extract a pointer item's server id (the durable record's own id). */
function pointerServerId(item: Record<string, unknown>): string | null {
  const id = item.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * True when a pointer item is body-free: it carries ONLY identity/structural
 * coordinates and NO body-bearing field. Any of content/content_preview/label/
 * preview/text/rationale/title on a pointer is body leakage and fails the arm.
 * The structural source_ref is allowed (it is identity coordinates only); a
 * source_ref carrying a display/body field is itself a leak.
 */
const BODY_BEARING_FIELDS = [
  "content",
  "content_preview",
  "label",
  "preview",
  "text",
  "rationale",
  "title",
  "body",
];

function pointerIsBodyFree(item: Record<string, unknown>): boolean {
  for (const field of BODY_BEARING_FIELDS) {
    if (field in item) return false;
  }
  const ref = item.source_ref;
  if (ref && typeof ref === "object" && !Array.isArray(ref)) {
    const refRec = ref as Record<string, unknown>;
    for (const field of BODY_BEARING_FIELDS) {
      if (field in refRec) return false;
    }
  }
  return true;
}

/** The nine canonical pack sections the whole-pack allocation order must cover. */
const PACK_ALLOCATION_SECTIONS = [
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
 * The prior-context references (citation_id + structural source_ref) the OFF arm
 * emitted for the already-known seeds. These exact references are fed back to the
 * ON arm as prior_context -- the real identities a model would echo back -- so
 * the ON arm exercises the actual suppression bijection rather than a fabricated
 * citation string.
 */
interface KnownPointerRefs {
  refs: ReflexPriorContextRef[];
  /** Fixture ids of known seeds that were actually emitted by the OFF arm. */
  emittedKnownFixtureIds: string[];
  /**
   * Server ids of the known seeds the gate built a resolvable prior_context
   * reference for. This is the set the ON arm's prior_context actually covers,
   * and it must exactly equal the OFF arm's emitted-known server id set for the
   * suppression contrast to be attributable (a known item emitted without any
   * resolvable identity would be un-referenceable and break coverage).
   */
  referencedServerIds: Set<string>;
}

function collectKnownPointerRefs(
  offPayload: ReflexPointersPayload,
  serverIdToRecord: Map<string, ReflexAbSeededRecord>,
): KnownPointerRefs {
  const refs: ReflexPriorContextRef[] = [];
  const emittedKnownFixtureIds: string[] = [];
  const referencedServerIds = new Set<string>();
  for (const item of pointerItemsOf(offPayload)) {
    const serverId = pointerServerId(item);
    if (!serverId) continue;
    const record = serverIdToRecord.get(serverId);
    if (!record || !record.prior_known) continue;

    const ref: ReflexPriorContextRef = {};
    if (typeof item.citation_id === "string" && item.citation_id.length > 0) {
      ref.citation_id = item.citation_id;
    }
    const sourceRef = item.source_ref;
    if (
      sourceRef &&
      typeof sourceRef === "object" &&
      !Array.isArray(sourceRef)
    ) {
      const sr = sourceRef as Record<string, unknown>;
      if (
        typeof sr.source === "string" &&
        typeof sr.type === "string" &&
        typeof sr.id === "string"
      ) {
        ref.source_ref = {
          source: sr.source,
          type: sr.type,
          id: sr.id,
          ...(typeof sr.namespace === "string"
            ? { namespace: sr.namespace }
            : {}),
        };
      }
    }
    // Only echo a reference that actually carries a resolvable identity. A known
    // seed emitted without any identity cannot be suppressed by reference; it is
    // simply not sent, and the reference-coverage check below fails the contrast
    // rather than letting an un-referenceable known item pass silently.
    if (ref.citation_id !== undefined || ref.source_ref !== undefined) {
      refs.push(ref);
      emittedKnownFixtureIds.push(record.fixture_id);
      referencedServerIds.add(serverId);
    }
  }
  return { refs, emittedKnownFixtureIds, referencedServerIds };
}

/**
 * The set of prior-known SERVER ids a reflex arm actually emitted as pointers.
 * Content-free (server ids only, never a body). Used to prove the OFF and
 * CONTROL arms resurfaced the SAME known set (stability) and that the
 * prior_context the gate sent the ON arm exactly covers the OFF arm's emitted
 * known set.
 */
function emittedKnownServerIds(
  payload: ReflexPointersPayload,
  priorKnownServerIds: Set<string>,
): Set<string> {
  const emitted = new Set<string>();
  for (const item of pointerItemsOf(payload)) {
    const serverId = pointerServerId(item);
    if (serverId && priorKnownServerIds.has(serverId)) emitted.add(serverId);
  }
  return emitted;
}

/** True when two content-free server-id sets are exactly equal (same members). */
function serverIdSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Serialized whole-pack budget accounting for one reflex arm. */
function budgetOf(payload: ReflexPointersPayload): ReflexArmVerdict["budget"] {
  const serialized = JSON.stringify(payload.pointers).length;
  const wholePack =
    payload.budget.whole_pack &&
    typeof payload.budget.whole_pack === "object" &&
    !Array.isArray(payload.budget.whole_pack)
      ? (payload.budget.whole_pack as Record<string, unknown>)
      : null;
  const limit =
    wholePack && typeof wholePack.content_char_limit === "number"
      ? wholePack.content_char_limit
      : null;
  const order = wholePack?.allocation_order;
  const orderComplete =
    Array.isArray(order) &&
    PACK_ALLOCATION_SECTIONS.every((s) => order.includes(s));
  return {
    content_char_limit: limit,
    serialized_pointers_chars: serialized,
    within_budget: limit === null ? false : serialized <= limit,
    allocation_order_complete: orderComplete,
  };
}

/**
 * Verify one reflex arm against the EVAL-3 functional bar and the A/B ground
 * truth. Content-free: every derived signal is a count/boolean over server ids
 * mapped back to fixture ids, never a pointer body.
 */
function verifyArm(
  arm: "on" | "off",
  payload: ReflexPointersPayload,
  seeded: ReflexAbSeededRecord[],
  fixture: ReflexAbFixture,
  serverIdToRecord: Map<string, ReflexAbSeededRecord>,
): ReflexArmVerdict {
  const items = pointerItemsOf(payload);

  const netNewServerIds = new Set(
    seeded
      .filter(
        (r) =>
          r.namespace_role === "primary" &&
          fixture.net_new_ids.includes(r.fixture_id),
      )
      .map((r) => r.server_id),
  );
  const priorKnownServerIds = new Set(
    seeded
      .filter(
        (r) =>
          r.namespace_role === "primary" &&
          fixture.prior_known_ids.includes(r.fixture_id),
      )
      .map((r) => r.server_id),
  );
  const forbiddenServerIds = new Set(
    seeded
      .filter(
        (r) =>
          r.namespace_role === "negative" &&
          fixture.forbidden_ids.includes(r.fixture_id),
      )
      .map((r) => r.server_id),
  );

  const emittedNetNew = new Set<string>();
  let redundantResurfacing = 0;
  let leaks = 0;
  let bodyFree = true;
  // Multiset of emitted pointer citation ids for the bijection check.
  const emittedCitationCounts = new Map<string, number>();

  for (const item of items) {
    if (!pointerIsBodyFree(item)) bodyFree = false;
    const cid = item.citation_id;
    if (typeof cid === "string" && cid.length > 0) {
      emittedCitationCounts.set(cid, (emittedCitationCounts.get(cid) ?? 0) + 1);
    }
    const serverId = pointerServerId(item);
    if (!serverId) continue;
    if (netNewServerIds.has(serverId)) emittedNetNew.add(serverId);
    if (priorKnownServerIds.has(serverId)) redundantResurfacing += 1;
    // A forbidden id is a leak whether it is the exact pointer id or embedded in
    // the pointer's structural source_ref id.
    if (forbiddenServerIds.has(serverId)) leaks += 1;
  }
  // Also scan structural source_ref ids for a forbidden id that surfaced without
  // matching the top-level pointer id (defensive: a leak is a leak wherever it
  // appears in the emitted structure).
  for (const item of items) {
    const ref = item.source_ref;
    if (ref && typeof ref === "object" && !Array.isArray(ref)) {
      const refId = (ref as Record<string, unknown>).id;
      if (typeof refId === "string" && forbiddenServerIds.has(refId)) {
        const serverId = pointerServerId(item);
        // Avoid double-counting when the pointer id itself already matched.
        if (serverId === null || !forbiddenServerIds.has(serverId)) leaks += 1;
      }
    }
  }

  // Citation bijection: the top-level citations must be a one-to-one match of the
  // emitted pointer citation_ids (occurrence counts on both sides).
  const citationCounts = new Map<string, number>();
  for (const citation of payload.citations) {
    const id = citation.id;
    if (typeof id === "string" && id.length > 0) {
      citationCounts.set(id, (citationCounts.get(id) ?? 0) + 1);
    }
  }
  const allIds = new Set<string>([
    ...emittedCitationCounts.keys(),
    ...citationCounts.keys(),
  ]);
  // A true multiplicity bijection requires the emitted count to EQUAL the cited
  // count for EVERY identity. Any surplus on the citation side is dangling
  // (cited more than emitted); any surplus on the pointer side is uncited
  // (emitted more than cited). Both are counted per identity so a single
  // identity can never mask its own duplicate: emitted=2/cited=1 is one uncited,
  // emitted=1/cited=2 is one dangling, and emitted=2/cited=2 is clean.
  let dangling = 0;
  let uncited = 0;
  for (const id of allIds) {
    const emittedN = emittedCitationCounts.get(id) ?? 0;
    const citedN = citationCounts.get(id) ?? 0;
    if (citedN > emittedN) dangling += citedN - emittedN;
    else if (emittedN > citedN) uncited += emittedN - citedN;
  }
  const bijective = dangling === 0 && uncited === 0;

  const netNewPresent = emittedNetNew.size;
  const netNewMissing = netNewServerIds.size - netNewPresent;

  const budget = budgetOf(payload);
  const placementClientOwned = payload.placement === "client_owned";

  const failures: string[] = [];
  // EVAL-3 functional bar, applied per arm.
  if (payload.status !== "ok") {
    failures.push(`${arm}: reflex status is not 'ok'`);
  }
  if (!bijective) {
    failures.push(
      `${arm}: citations not bijective (dangling=${dangling} uncited=${uncited})`,
    );
  }
  if (!bodyFree) {
    failures.push(`${arm}: a pointer carried a body-bearing field (leakage)`);
  }
  if (!placementClientOwned) {
    failures.push(`${arm}: placement is not client_owned`);
  }
  if (!budget.within_budget) {
    failures.push(
      `${arm}: serialized pointers ${budget.serialized_pointers_chars} exceed whole-pack limit ${budget.content_char_limit ?? "none"}`,
    );
  }
  if (!budget.allocation_order_complete) {
    failures.push(`${arm}: whole-pack allocation order missing or incomplete`);
  }
  if (leaks > 0) {
    failures.push(
      `${arm}: namespace isolation breach (${leaks} forbidden pointer(s))`,
    );
  }
  // Net-new evidence must be present on BOTH arms: suppression never drops a
  // net-new item, and a hollow empty reflex would otherwise hide a broken recall.
  if (netNewMissing > 0) {
    failures.push(
      `${arm}: ${netNewMissing} expected net-new record(s) missing from pointers`,
    );
  }
  // The ON arm must have suppressed every already-known reference: any resurfaced
  // known item is a suppression failure.
  if (arm === "on" && redundantResurfacing > 0) {
    failures.push(
      `on: suppression enabled but ${redundantResurfacing} already-known item(s) resurfaced`,
    );
  }

  return {
    arm,
    pointer_count: items.length,
    net_new_present: netNewPresent,
    net_new_missing: netNewMissing,
    redundant_resurfacing: redundantResurfacing,
    namespace_leaks: leaks,
    citations_bijective: bijective,
    dangling_citations: dangling,
    uncited_pointers: uncited,
    body_free: bodyFree,
    placement_client_owned: placementClientOwned,
    budget,
    failures,
  };
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
  const { fixture, config, clients, budgetMaxTokens, scope, commit } = opts;

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

  // --- Verify each arm against the EVAL-3 functional bar + ground truth ---
  const armOff = verifyArm(
    "off",
    offPayload,
    seeded,
    fixture,
    serverIdToRecord,
  );
  // The control arm is unsuppressed, so it is verified as an "off" arm: it must
  // clear the exact same functional bar (cited, body-free, budgeted, no leaks,
  // net-new present) as the OFF arm.
  const armControl = verifyArm(
    "off",
    controlPayload,
    seeded,
    fixture,
    serverIdToRecord,
  );
  const armOn = verifyArm("on", onPayload, seeded, fixture, serverIdToRecord);

  // Content-free emitted prior-known server id sets for the stability/coverage
  // controls. `priorKnownServerIds` is the ground-truth known set (primary-role,
  // prior_known seeds); the emitted sets are what each unsuppressed arm surfaced.
  const priorKnownServerIds = new Set(
    seeded
      .filter(
        (r) =>
          r.namespace_role === "primary" &&
          fixture.prior_known_ids.includes(r.fixture_id),
      )
      .map((r) => r.server_id),
  );
  const offKnownEmitted = emittedKnownServerIds(
    offPayload,
    priorKnownServerIds,
  );
  const controlKnownEmitted = emittedKnownServerIds(
    controlPayload,
    priorKnownServerIds,
  );
  const knownResurfacingStable =
    offKnownEmitted.size > 0 &&
    serverIdSetsEqual(offKnownEmitted, controlKnownEmitted);
  // The prior_context the gate sent must EXACTLY cover the OFF arm's emitted
  // known set: every emitted known item is referenced and no reference points at
  // a known item the OFF arm did not resurface.
  const referencesCoverOffKnown =
    knownRefs.referencedServerIds.size > 0 &&
    serverIdSetsEqual(knownRefs.referencedServerIds, offKnownEmitted);

  // --- A/B comparison: the REFLEX-4 acceptance signal ---
  const comparison: ReflexAbComparison = {
    known_resurfaced_off: armOff.redundant_resurfacing,
    known_resurfaced_control: armControl.redundant_resurfacing,
    known_resurfaced_on: armOn.redundant_resurfacing,
    known_suppressed_delta:
      armOff.redundant_resurfacing - armOn.redundant_resurfacing,
    fewer_known_when_enabled:
      armOn.redundant_resurfacing < armOff.redundant_resurfacing,
    known_resurfacing_stable: knownResurfacingStable,
    stable_known_count: knownResurfacingStable ? offKnownEmitted.size : 0,
    references_sent: knownRefs.refs.length,
    references_cover_off_known: referencesCoverOffKnown,
    net_new_preserved: Math.min(
      armOff.net_new_present,
      armControl.net_new_present,
      armOn.net_new_present,
    ),
    net_new_preserved_on_both:
      armOff.net_new_missing === 0 &&
      armControl.net_new_missing === 0 &&
      armOn.net_new_missing === 0,
  };

  const primarySeeded = seeded.filter(
    (r) => r.namespace_role === "primary",
  ).length;
  const negativeSeeded = seeded.filter(
    (r) => r.namespace_role === "negative",
  ).length;
  const priorKnownSeeded = seeded.filter(
    (r) => r.namespace_role === "primary" && r.prior_known,
  ).length;
  const netNewSeeded = seeded.filter(
    (r) =>
      r.namespace_role === "primary" &&
      fixture.net_new_ids.includes(r.fixture_id),
  ).length;

  const failures: string[] = [
    ...armOff.failures,
    ...armControl.failures,
    ...armOn.failures,
  ];

  // A/B contrast: suppression ENABLED must return strictly fewer already-known
  // items. The OFF arm must ACTUALLY have resurfaced at least one known item,
  // otherwise there is nothing to suppress and the contrast is vacuous.
  if (armOff.redundant_resurfacing === 0) {
    failures.push(
      "off arm resurfaced zero already-known items: the A/B contrast is vacuous (suppression had nothing to remove)",
    );
  }
  // Stability control: the two UNSUPPRESSED arms (OFF and CONTROL) must resurface
  // the SAME non-vacuous already-known set. If they disagree, a variable ranked
  // recall dropped known items on its own and the ON arm's zero cannot be
  // attributed to suppression.
  if (!comparison.known_resurfacing_stable) {
    failures.push(
      `unsuppressed known resurfacing is not stable across off/control (off=${comparison.known_resurfaced_off} control=${comparison.known_resurfaced_control} stable_known=${comparison.stable_known_count}): a variable recall could masquerade as suppression`,
    );
  }
  // Reference-coverage control: the prior_context the gate fed the ON arm must be
  // non-empty AND exactly cover the OFF arm's emitted known set, so suppression
  // is acting on precisely the items that were resurfaced.
  if (comparison.references_sent === 0) {
    failures.push(
      "no prior_context references were sent to the suppression arm: suppression had nothing to act on",
    );
  }
  if (!comparison.references_cover_off_known) {
    failures.push(
      `prior_context references (${comparison.references_sent}) do not exactly cover the off arm's emitted already-known set (${armOff.redundant_resurfacing}): the suppression contrast is not attributable`,
    );
  }
  if (!comparison.fewer_known_when_enabled) {
    failures.push(
      `suppression did not return fewer already-known items (off=${comparison.known_resurfaced_off} on=${comparison.known_resurfaced_on})`,
    );
  }
  if (comparison.known_resurfaced_on !== 0) {
    failures.push(
      `suppression enabled still resurfaced ${comparison.known_resurfaced_on} already-known item(s)`,
    );
  }
  if (!comparison.net_new_preserved_on_both) {
    failures.push(
      "suppression did not preserve the net-new evidence on all arms (off/control/on)",
    );
  }

  // Cross-namespace denial control.
  if (!negativeControl.ran) {
    failures.push(
      `negative-control proof did not run: ${negativeControl.failure ?? "unknown"}`,
    );
  } else if (!negativeControl.denied) {
    failures.push(
      `negative-control not denied: ${negativeControl.failure ?? "isolation not proven"}`,
    );
  }

  // Teardown discipline.
  const teardownClean = teardownTally.failed === 0;
  if (!teardownClean) {
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
    seeded: {
      primary: primarySeeded,
      negative: negativeSeeded,
      prior_known: priorKnownSeeded,
      net_new: netNewSeeded,
    },
    arm_off: armOff,
    arm_control: armControl,
    arm_on: armOn,
    comparison,
    negative_control: negativeControl,
    passed,
    failures,
    teardown: teardownTally,
  };

  return { receipt, passed };
}
