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
  type BudgetVerdict,
  type CitationVerdict,
  type CompletePackFixture,
  type CompletePackReceipt,
  type CompletePackSeededRecord,
  type CompletePackSectionName,
  type IsolationVerdict,
  type SectionVerdict,
} from "./complete-pack-types.ts";

// Live COMPLETE CONTEXT PACK gate orchestrator (EVAL-3, issue #330).
//
// One run: seed a unique throwaway namespace (and a sibling negative namespace)
// with the sealed synthetic corpus, call the real `agent_context_pack` tool
// under the primary namespace requesting ALL NINE sections and one whole-pack
// budget, verify the assembled pack against five functional properties, and
// ALWAYS tear down exactly the records this run created -- even when the pack
// call or a verification fails partway through.
//
// The five properties, all functional (no assertions about SQL shape or
// internal call counts):
//   1. Presence-or-defined-emptiness: every requested section either carries
//      items or is in its DEFINED-EMPTY state (a recognized empty/denial marker,
//      or a legitimately-empty RAM-only section, or a defined scope-denial).
//   2. Exact-scope isolation: durable_lane_context reports its exact-scope
//      defined-empty for the fresh throwaway scope, no negative-namespace record
//      surfaces in any section item or citation, and the expected primary recall
//      IS present (a hollow empty recall would otherwise hide a broken predicate).
//   3. Citation truth: the top-level citations array is a bijection of the
//      emitted item citation_ids -- no dangling citation, no uncited item.
//   4. Serialized budget: JSON.stringify(sections) stays within the reported
//      whole-pack content_char_limit, and an allocation order covering all nine
//      sections is present.
//   5. Per-section contribution: the serialized-character contribution and item
//      count of every section is recorded in the receipt.
//
// Teardown reuses the recall gate's discipline: per-record, namespace-scoped
// archive_entry only, never a bulk or query-shaped delete, so it can only touch
// records this run created. The receipt is content-free: labels, ids, counts,
// booleans -- never a memory body.

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

/** A recognized non-empty item container: has an integer item_count > 0. */
function itemCountOf(section: Record<string, unknown>): number {
  const count = section.item_count;
  return typeof count === "number" && Number.isFinite(count) && count >= 0
    ? count
    : Array.isArray(section.items)
      ? section.items.length
      : 0;
}

/**
 * The set of content-free empty/denial markers each section is allowed to carry
 * when it holds zero items. A section with zero items is DEFINED-EMPTY only when
 * it carries one of these (or, for the RAM-only sections, is simply empty on a
 * fresh scope). This is what turns "empty" into "defined-empty" -- an empty
 * section with no recognized marker is a defect, not a pass.
 */
const RECOGNIZED_EMPTY_REASONS = new Set<string>([
  // durable_memory
  "no_query",
  "no_readable_tables",
  "recall_failed",
  "no_matches",
  "all_suppressed",
  "content_unavailable",
  // candidate_memory
  "candidate_predicate_unavailable",
  // whole-pack starvation stamped by the fitter on any trimmed-to-empty section
  "whole_pack_budget",
]);

/** RAM-only sections that are legitimately empty on a fresh remote scope. */
const RAM_ONLY_SECTIONS = new Set<CompletePackSectionName>([
  "working_set",
  "recovery",
]);

/**
 * Opt-in sections the pack only emits when their explicit opt-in was requested.
 * `recovery` is only assembled when `include_unreviewed_recovery: true` is sent
 * (requesting the section name alone is not enough), so on a pack built without
 * that flag `recovery` is legitimately ABSENT — not a missing-section defect.
 * The gate treats an absent opt-in section as defined-empty; a present-empty one
 * still flows through the normal present-empty checks (RAM_ONLY).
 */
const OPT_IN_ABSENT_OK = new Set<CompletePackSectionName>(["recovery"]);

/**
 * Sections whose production builders emit a TRUTHFUL empty body carrying NO
 * `empty_reason` when they are genuinely empty: the guidance loaders
 * (no promoted user_preference / process_rule) and the pointer builder (no
 * surplus durable pool after dedupe). Their defined-empty state is declared by
 * construction via a namespace-binding flag (`namespace_scoped` /
 * `namespace_bound: true`) and an empty items array, not an empty_reason string.
 * durable_memory is deliberately EXCLUDED: it is a recall section that always
 * stamps a recognized `empty_reason` (no_matches/no_query/...) when empty, so a
 * marker-less empty durable_memory stays a defect.
 */
const DEFINED_EMPTY_WITHOUT_MARKER = new Set<CompletePackSectionName>([
  "profile_guidance",
  "process_guidance",
  "pointers",
]);

/** True only for the exact truthful namespace-bound empty envelope. */
function isNamespaceBoundEmpty(section: Record<string, unknown>): boolean {
  return section.namespace_scoped === true || section.namespace_bound === true;
}

/**
 * Classify one requested section's disposition against the emitted pack. A
 * section passes when it is PRESENT-with-items, or in a recognized DEFINED-EMPTY
 * state (empty items + a recognized marker, or a legitimately-empty RAM-only
 * section), or reported through a defined scope-denial / degraded-source in the
 * warnings channel (durable_lane_context exact_scope, repo_facts no_active_repo,
 * a database_unavailable degrade). Everything else fails the present-or-empty
 * check. Records the serialized-character contribution either way.
 */
function classifySection(
  name: CompletePackSectionName,
  payload: ContextPackPayload,
): SectionVerdict {
  const body = payload.sections[name];
  const present = body !== undefined;
  const section =
    present && body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  const serializedChars = present ? JSON.stringify(body).length : 0;

  // A defined scope-denial or degraded-source for this section is itself a
  // defined-empty disposition even when the section body is omitted.
  const scopeDenial = payload.warnings.scope_denials.find(
    (d) => d.source === name,
  );
  const degraded = payload.warnings.degraded_sources.find(
    (d) => d.source === name,
  );

  if (!section) {
    // Body omitted. Legitimate ONLY when a defined denial/degrade explains it,
    // OR the whole-pack budget starved it out (recorded as a truncation marker
    // with starved:true on this source).
    const starved = payload.warnings.truncation.some(
      (t) => t.source === name && t.starved === true,
    );
    if (scopeDenial) {
      const reasons = Array.isArray(scopeDenial.reasons)
        ? scopeDenial.reasons.map(String).join(",")
        : "scope_denied";
      return {
        section: name,
        present: false,
        has_items: false,
        defined_empty: true,
        item_count: 0,
        disposition: reasons || "scope_denied",
        serialized_chars: 0,
      };
    }
    if (degraded) {
      const reason =
        typeof degraded.reason === "string" ? degraded.reason : "degraded";
      return {
        section: name,
        present: false,
        has_items: false,
        defined_empty: true,
        item_count: 0,
        disposition: reason,
        serialized_chars: 0,
      };
    }
    if (starved) {
      return {
        section: name,
        present: false,
        has_items: false,
        defined_empty: true,
        item_count: 0,
        disposition: "whole_pack_budget",
        serialized_chars: 0,
      };
    }
    if (OPT_IN_ABSENT_OK.has(name)) {
      // Opt-in section legitimately absent: the pack only assembles it when its
      // explicit opt-in was requested (recovery -> include_unreviewed_recovery).
      // Its absence is the defined state, not a dropped section.
      return {
        section: name,
        present: false,
        has_items: false,
        defined_empty: true,
        item_count: 0,
        disposition: "opt_in_absent",
        serialized_chars: 0,
      };
    }
    return {
      section: name,
      present: false,
      has_items: false,
      defined_empty: false,
      item_count: 0,
      disposition: "missing",
      serialized_chars: 0,
      failure: `${name}: not present and no defined scope-denial/degrade/starve`,
    };
  }

  const itemCount = itemCountOf(section);
  if (itemCount > 0) {
    return {
      section: name,
      present: true,
      has_items: true,
      defined_empty: false,
      item_count: itemCount,
      disposition: "items",
      serialized_chars: serializedChars,
    };
  }

  // Present with zero items: must be a recognized defined-empty.
  const emptyReason =
    typeof section.empty_reason === "string" ? section.empty_reason : null;
  if (emptyReason && RECOGNIZED_EMPTY_REASONS.has(emptyReason)) {
    return {
      section: name,
      present: true,
      has_items: false,
      defined_empty: true,
      item_count: 0,
      disposition: emptyReason,
      serialized_chars: serializedChars,
    };
  }
  // durable_lane_context present-but-empty is reported through its scope-denial
  // (exact_scope), so a present empty lane body with no items and a matching
  // denial is defined-empty too.
  if (scopeDenial) {
    return {
      section: name,
      present: true,
      has_items: false,
      defined_empty: true,
      item_count: 0,
      disposition: "exact_scope",
      serialized_chars: serializedChars,
    };
  }
  // Guidance loaders and the pointer builder emit a truthful empty body with NO
  // empty_reason when genuinely empty; their defined-empty state is declared by
  // construction through the namespace-binding flag on an empty items array.
  // Require the binding flag so a body that merely dropped its marker (a real
  // defect) is not silently accepted.
  if (
    DEFINED_EMPTY_WITHOUT_MARKER.has(name) &&
    isNamespaceBoundEmpty(section)
  ) {
    return {
      section: name,
      present: true,
      has_items: false,
      defined_empty: true,
      item_count: 0,
      disposition: "namespace_bound_empty",
      serialized_chars: serializedChars,
    };
  }
  // RAM-only sections are legitimately empty on a fresh remote scope: an empty
  // items array with no reason is their defined state, not a defect.
  if (RAM_ONLY_SECTIONS.has(name)) {
    return {
      section: name,
      present: true,
      has_items: false,
      defined_empty: true,
      item_count: 0,
      disposition: "ram_only_empty",
      serialized_chars: serializedChars,
    };
  }
  // Present, empty, no recognized marker: a defect (an empty section that does
  // not truthfully state WHY it is empty).
  return {
    section: name,
    present: true,
    has_items: false,
    defined_empty: false,
    item_count: 0,
    disposition: emptyReason ?? "unmarked_empty",
    serialized_chars: serializedChars,
    failure: `${name}: present but empty with no recognized empty marker`,
  };
}

/**
 * Collect every emitted item's `citation_id` across all sections, plus the
 * lane's own citation_id. Content-free: only the id strings, never a body.
 */
function collectEmittedItemCitationIds(
  payload: ContextPackPayload,
): Set<string> {
  const ids = new Set<string>();
  const addFrom = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const cid = (item as Record<string, unknown>).citation_id;
        if (typeof cid === "string" && cid.length > 0) ids.add(cid);
      }
    }
  };
  for (const name of COMPLETE_PACK_SECTION_NAMES) {
    const body = payload.sections[name];
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const section = body as Record<string, unknown>;
    addFrom(section.items);
    // durable_lane_context carries its lane citation_id on the lane object, not
    // in an items array; it is an emitted, citable unit too.
    const lane = section.lane;
    if (lane && typeof lane === "object" && !Array.isArray(lane)) {
      const cid = (lane as Record<string, unknown>).citation_id;
      if (typeof cid === "string" && cid.length > 0) ids.add(cid);
    }
  }
  return ids;
}

/** Verify the citations array is a bijection of the emitted item citation_ids. */
function verifyCitations(payload: ContextPackPayload): CitationVerdict {
  const emitted = collectEmittedItemCitationIds(payload);
  const citationIds = new Set<string>();
  for (const citation of payload.citations) {
    const id = citation.id;
    if (typeof id === "string" && id.length > 0) citationIds.add(id);
  }
  let dangling = 0;
  for (const id of citationIds) {
    if (!emitted.has(id)) dangling += 1;
  }
  let uncited = 0;
  for (const id of emitted) {
    if (!citationIds.has(id)) uncited += 1;
  }
  return {
    citations_total: payload.citations.length,
    emitted_item_citations: emitted.size,
    dangling_citations: dangling,
    uncited_items: uncited,
    bijective: dangling === 0 && uncited === 0,
  };
}

/** Verify the serialized whole-pack budget was respected. */
function verifyBudget(payload: ContextPackPayload): BudgetVerdict {
  const serialized = JSON.stringify(payload.sections).length;
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
    COMPLETE_PACK_SECTION_NAMES.every((s) => order.includes(s));
  return {
    content_char_limit: limit,
    serialized_sections_chars: serialized,
    within_budget: limit === null ? false : serialized <= limit,
    allocation_order_complete: orderComplete,
  };
}

/**
 * Verify isolation: durable_lane_context reports its exact-scope defined-empty,
 * no forbidden (negative-namespace) server id surfaces anywhere in the pack, and
 * the expected primary recall ids surfaced in durable_memory items or pointers.
 *
 * Forbidden ids are checked by their SERVER ids (the ids this run seeded into the
 * negative namespace), matched against every item id and source_ref id in the
 * pack -- so a leak is detected structurally, without inspecting any body.
 */
function verifyIsolation(
  payload: ContextPackPayload,
  seeded: CompletePackSeededRecord[],
  fixture: CompletePackFixture,
): IsolationVerdict {
  const forbiddenServerIds = new Set(
    seeded
      .filter(
        (r) =>
          r.namespace_role === "negative" &&
          fixture.forbidden_ids.includes(r.fixture_id),
      )
      .map((r) => r.server_id),
  );
  const expectedServerIds = new Set(
    seeded
      .filter(
        (r) =>
          r.namespace_role === "primary" &&
          fixture.expected_recall_ids.includes(r.fixture_id),
      )
      .map((r) => r.server_id),
  );

  // Walk every emitted item id + source_ref id across all sections.
  const emittedIds = new Set<string>();
  const collectIds = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.id === "string") emittedIds.add(rec.id);
      const ref = rec.source_ref;
      if (ref && typeof ref === "object" && !Array.isArray(ref)) {
        const refId = (ref as Record<string, unknown>).id;
        if (typeof refId === "string") emittedIds.add(refId);
      }
    }
  };
  for (const name of COMPLETE_PACK_SECTION_NAMES) {
    const body = payload.sections[name];
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    collectIds((body as Record<string, unknown>).items);
  }

  let leaks = 0;
  for (const id of emittedIds) {
    if (forbiddenServerIds.has(id)) leaks += 1;
  }
  let expectedPresent = false;
  for (const id of emittedIds) {
    if (expectedServerIds.has(id)) {
      expectedPresent = true;
      break;
    }
  }

  // durable_lane_context exact-scope defined-empty: reported through its
  // scope-denial (exact_scope) on a fresh throwaway scope.
  const exactScopeDenied = payload.warnings.scope_denials.some(
    (d) =>
      d.source === "durable_lane_context" &&
      Array.isArray(d.reasons) &&
      d.reasons.map(String).includes("exact_scope"),
  );

  return {
    exact_scope_denied: exactScopeDenied,
    namespace_leaks: leaks,
    expected_recall_present: expectedPresent,
  };
}

/**
 * Run the full complete-pack gate. Seeding and the pack call are wrapped so
 * teardown always runs; a thrown error is re-raised only AFTER teardown, with
 * the content-free teardown failed count preserved (shared with the recall gate
 * via withTeardownFailedCount). PASS requires all five properties AND clean
 * teardown.
 */
export async function runCompletePackGate(
  opts: RunCompletePackGateOptions,
): Promise<CompletePackGateOutcome> {
  const { fixture, config, clients, budgetMaxTokens, scope, commit } = opts;

  const seeded: CompletePackSeededRecord[] = [];
  let deferredError: unknown = null;
  let payload: ContextPackPayload | null = null;

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

  // --- Verify the five functional properties ---
  const sections = COMPLETE_PACK_SECTION_NAMES.map((name) =>
    classifySection(name, payload as ContextPackPayload),
  );
  const citations = verifyCitations(payload);
  const budget = verifyBudget(payload);
  const isolation = verifyIsolation(payload, seeded, fixture);

  const primarySeeded = seeded.filter(
    (r) => r.namespace_role === "primary",
  ).length;
  const negativeSeeded = seeded.filter(
    (r) => r.namespace_role === "negative",
  ).length;

  const failures: string[] = [];
  // 1. Presence-or-defined-emptiness for all nine.
  for (const verdict of sections) {
    if (!verdict.has_items && !verdict.defined_empty) {
      failures.push(verdict.failure ?? `${verdict.section}: not defined-empty`);
    }
  }
  if (payload.status !== "ok") {
    failures.push(`pack status is '${payload.status}', expected 'ok'`);
  }
  // 3. Citation truth.
  if (!citations.bijective) {
    failures.push(
      `citations not bijective: dangling=${citations.dangling_citations} uncited=${citations.uncited_items}`,
    );
  }
  // 4. Serialized budget.
  if (!budget.within_budget) {
    failures.push(
      `serialized sections ${budget.serialized_sections_chars} exceed whole-pack limit ${budget.content_char_limit ?? "none"}`,
    );
  }
  if (!budget.allocation_order_complete) {
    failures.push(
      "whole-pack allocation order missing or does not cover all nine sections",
    );
  }
  // 2. Exact-scope isolation.
  if (!isolation.exact_scope_denied) {
    failures.push(
      "durable_lane_context did not report its exact-scope defined-empty",
    );
  }
  if (isolation.namespace_leaks > 0) {
    failures.push(
      `namespace isolation breach: ${isolation.namespace_leaks} forbidden record(s) surfaced in the pack`,
    );
  }
  if (!isolation.expected_recall_present) {
    failures.push(
      "expected primary recall did not surface in durable_memory/pointers (hollow recall would hide a broken predicate)",
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

  const receipt: CompletePackReceipt = {
    schema: "openbrain.complete_pack_gate.v1",
    generated_at: opts.generatedAt,
    commit,
    fixture_id: fixture.fixture_id,
    primary_namespace: config.primaryNamespace,
    negative_namespace: config.negativeNamespace,
    requested_sections: [...COMPLETE_PACK_SECTION_NAMES],
    seeded: { primary: primarySeeded, negative: negativeSeeded },
    sections,
    budget,
    citations,
    isolation,
    passed,
    failures,
    teardown: teardownTally,
  };

  return { receipt, passed };
}
