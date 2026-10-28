import type { ContextPackPayload } from "./transport.ts";
import {
  COMPLETE_PACK_SECTION_NAMES,
  type BudgetVerdict,
  type CitationVerdict,
  type CompletePackFixture,
  type CompletePackSeededRecord,
  type IsolationVerdict,
} from "./complete-pack-types.ts";

// Citation, budget, and isolation verification for the complete-pack gate,
// extracted from complete-pack-gate.ts (issue 752 lint sweep).
// Behavior-identical: the same counts, the same booleans.

/** Tally one record's `citation_id` occurrence into the multiset when present. */
function addCitationId(counts: Map<string, number>, record: unknown): void {
  if (!record || typeof record !== "object" || Array.isArray(record)) return;
  const cid = (record as Record<string, unknown>).citation_id;
  if (typeof cid === "string" && cid.length > 0) {
    counts.set(cid, (counts.get(cid) ?? 0) + 1);
  }
}

/**
 * Tally every emitted citable unit's `citation_id` across all sections as a
 * MULTISET (id -> occurrence count), not a set. A unit is any record the pack
 * emits with its own citation: durable_memory / pointer items (in `items[]`),
 * and -- for durable_lane_context -- the lane object AND each event in
 * `events[]`. A populated lane emits a `session_lane:<id>` citation for the lane
 * and a `session_event:<id>` citation for each event
 * (server/tools/context-pack-durable-lane.ts).
 *
 * Counting OCCURRENCES rather than distinct ids is what makes the bijection
 * real: two DISTINCT emitted units that share one citation_id, or one unit
 * emitted twice, are a truth defect (the shared id cannot cite both) that a set
 * would silently collapse to a single member and pass. Content-free: only the id
 * strings and their counts, never a body.
 */
export function tallyEmittedItemCitationIds(
  payload: ContextPackPayload,
): Map<string, number> {
  const counts = new Map<string, number>();
  const addFrom = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) addCitationId(counts, item);
  };
  for (const name of COMPLETE_PACK_SECTION_NAMES) {
    const body = payload.sections[name];
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const section = body as Record<string, unknown>;
    addFrom(section.items);
    // durable_lane_context carries its lane citation_id on the lane object, not
    // in an items array; the lane is an emitted, citable unit too.
    addCitationId(counts, section.lane);
    // durable_lane_context also emits its events in an events[] array, each with
    // its own session_event citation_id -- a populated lane cites every event.
    addFrom(section.events);
  }
  return counts;
}

/** Sum a multiset's occurrence counts (total emitted citable units). */
function sumCounts(counts: Map<string, number>): number {
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}

/** Tally the payload's top-level citation ids as an occurrence multiset. */
function tallyTopLevelCitationIds(payload: ContextPackPayload): Map<string, number> {
  const counts = new Map<string, number>();
  for (const citation of payload.citations) {
    const id = citation.id;
    if (typeof id === "string" && id.length > 0) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Verify the top-level citations array is a strict bijection of the emitted
 * citable units, comparing OCCURRENCE COUNTS rather than set membership so
 * duplicate occurrences on either side are caught:
 *
 *  - EXACTLY ONE emitted unit and ONE top-level citation per identity. Two
 *    distinct units sharing one citation_id are ambiguous even if the top-level
 *    array repeats that id twice; matching duplicate counts must still fail.
 *  - A top-level citation occurrence with no emitted occurrence is dangling; an
 *    emitted occurrence with no citation is uncited. Any occurrence beyond the
 *    first on either side is also a defect for that side.
 *
 * dangling + uncited are occurrence counts, so the bijection holds only when
 * every id appears exactly once on both sides.
 */
export function verifyCitations(payload: ContextPackPayload): CitationVerdict {
  const emitted = tallyEmittedItemCitationIds(payload);
  const citationCounts = tallyTopLevelCitationIds(payload);
  const ids = new Set<string>([...emitted.keys(), ...citationCounts.keys()]);
  let dangling = 0;
  let uncited = 0;
  for (const id of ids) {
    const emittedN = emitted.get(id) ?? 0;
    const citedN = citationCounts.get(id) ?? 0;
    // A bijection requires ONE emitted unit and ONE top-level citation for each
    // id. Matching duplicate counts are still ambiguous (two units cannot share
    // one citation identity), so count every occurrence beyond the first as a
    // defect on its own side. If the opposite side is absent, every occurrence is
    // unmatched rather than treating one as the allowed representative.
    dangling += emittedN === 0 ? citedN : Math.max(citedN - 1, 0);
    uncited += citedN === 0 ? emittedN : Math.max(emittedN - 1, 0);
  }
  return {
    citations_total: payload.citations.length,
    emitted_item_citations: sumCounts(emitted),
    dangling_citations: dangling,
    uncited_items: uncited,
    bijective: dangling === 0 && uncited === 0,
  };
}

/** Verify the serialized whole-pack budget was respected. */
export function verifyBudget(payload: ContextPackPayload): BudgetVerdict {
  const serialized = JSON.stringify(payload.sections).length;
  const wholePack =
    payload.budget.whole_pack &&
    typeof payload.budget.whole_pack === "object" &&
    !Array.isArray(payload.budget.whole_pack)
      ? (payload.budget.whole_pack as Record<string, unknown>)
      : null;
  const charLimit =
    wholePack && typeof wholePack.content_char_limit === "number"
      ? wholePack.content_char_limit
      : null;
  const order = wholePack?.allocation_order;
  const orderComplete =
    Array.isArray(order) && COMPLETE_PACK_SECTION_NAMES.every((s) => order.includes(s));
  return {
    content_char_limit: charLimit,
    serialized_sections_chars: serialized,
    within_budget: charLimit === null ? false : serialized <= charLimit,
    allocation_order_complete: orderComplete,
  };
}

/** Add a record's `source_ref` identity string, in either emitted form. */
function addSourceRefIdentity(ref: unknown, into: Set<string>): void {
  if (typeof ref === "string" && ref.length > 0) {
    into.add(ref);
    return;
  }
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return;
  const refId = (ref as Record<string, unknown>).id;
  if (typeof refId === "string" && refId.length > 0) into.add(refId);
}

/**
 * Collect one record's structural identity strings (never a body): its own `id`,
 * and its `source_ref` -- which the pack emits either as an OBJECT carrying an
 * `id` (durable_memory / pointer items) OR as a plain STRING pointer such as
 * `ob_session_events/<id>` (durable_lane_context lane + events). Both forms are
 * captured: object source_refs contribute their `id`, string source_refs the
 * whole pointer string (so an embedded forbidden id is caught by containment).
 */
export function collectIdentityStrings(record: unknown, into: Set<string>): void {
  if (!record || typeof record !== "object" || Array.isArray(record)) return;
  const rec = record as Record<string, unknown>;
  if (typeof rec.id === "string" && rec.id.length > 0) into.add(rec.id);
  addSourceRefIdentity(rec.source_ref, into);
}

/**
 * Walk every emitted identity string across all sections: item ids +
 * source_refs, and durable_lane_context's lane id + each event id/source_ref.
 */
function collectEmittedIdentityStrings(payload: ContextPackPayload): Set<string> {
  const emittedIds = new Set<string>();
  const collectIds = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) collectIdentityStrings(item, emittedIds);
  };
  for (const name of COMPLETE_PACK_SECTION_NAMES) {
    const body = payload.sections[name];
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const section = body as Record<string, unknown>;
    collectIds(section.items);
    // durable_lane_context: the lane object and each event are emitted, citable
    // units with their own identity -- walk them for leaks too.
    collectIdentityStrings(section.lane, emittedIds);
    collectIds(section.events);
  }
  return emittedIds;
}

/** Server ids of the seeded records whose role and fixture id list both match. */
function serverIdsFor(
  seeded: CompletePackSeededRecord[],
  role: CompletePackSeededRecord["namespace_role"],
  fixtureIds: readonly string[],
): Set<string> {
  return new Set(
    seeded
      .filter((r) => r.namespace_role === role && fixtureIds.includes(r.fixture_id))
      .map((r) => r.server_id),
  );
}

/**
 * Count forbidden ids that surfaced anywhere in the emitted identity strings. A
 * forbidden id is a leak whether it is an exact emitted id OR is embedded in a
 * string source_ref pointer (ob_session_events/<forbidden-id>).
 */
function countNamespaceLeaks(
  forbiddenServerIds: Set<string>,
  emittedIds: Set<string>,
): number {
  let leaks = 0;
  for (const forbidden of forbiddenServerIds) {
    for (const id of emittedIds) {
      if (id === forbidden || id.includes(forbidden)) {
        leaks += 1;
        break;
      }
    }
  }
  return leaks;
}

/**
 * Require EVERY expected server id to surface, not merely one of them. Any one
 * seed appearing anywhere would pass a "some" check while the other expected
 * seeds silently never recalled -- a partial-recall defect that hides a broken
 * predicate for the missing ids. The recall is proven only when the whole
 * expected set is present. An empty expected set (a fixture that expects
 * nothing) cannot prove recall reached the seeded namespace, so it fails too.
 */
function allExpectedPresent(
  expectedServerIds: Set<string>,
  emittedIds: Set<string>,
): boolean {
  if (expectedServerIds.size === 0) return false;
  for (const expected of expectedServerIds) {
    if (!emittedIds.has(expected)) return false;
  }
  return true;
}

/**
 * Verify isolation: durable_lane_context reports its exact-scope defined-empty,
 * no forbidden (negative-namespace) server id surfaces anywhere in the pack, and
 * the expected primary recall ids surfaced in durable_memory items or pointers.
 *
 * Forbidden ids are checked by their SERVER ids (the ids this run seeded into the
 * negative namespace), matched against every emitted identity string across the
 * pack -- item ids and item source_ref ids, AND the durable_lane_context lane id
 * plus every event id and event source_ref pointer. A forbidden id is a leak
 * whether it appears as an exact identity id or is embedded in a string
 * source_ref pointer (e.g. `ob_session_events/<forbidden-id>`), so leaks are
 * detected structurally without inspecting any body.
 */
export function verifyIsolation(
  payload: ContextPackPayload,
  seeded: CompletePackSeededRecord[],
  fixture: CompletePackFixture,
): IsolationVerdict {
  const emittedIds = collectEmittedIdentityStrings(payload);

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
    namespace_leaks: countNamespaceLeaks(
      serverIdsFor(seeded, "negative", fixture.forbidden_ids),
      emittedIds,
    ),
    expected_recall_present: allExpectedPresent(
      serverIdsFor(seeded, "primary", fixture.expected_recall_ids),
      emittedIds,
    ),
  };
}
