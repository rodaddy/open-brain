import type { ReflexPointersPayload, ReflexPriorContextRef } from "./transport.ts";
import type {
  ReflexAbFixture,
  ReflexAbSeededRecord,
  ReflexArmVerdict,
} from "./reflex-ab-types.ts";

// Pure helpers extracted from reflex-ab-gate.ts (issue 752 lint sweep). Every
// function here is behavior-identical to the inline code it replaced: the same
// derived counts, the same boolean predicates, the same failure strings in the
// same order. Nothing in this module performs a transport call.

/** Read the emitted pointer items array (opaque records) from a reflex payload. */
export function pointerItemsOf(
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
export function pointerServerId(item: Record<string, unknown>): string | null {
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

export function pointerIsBodyFree(item: Record<string, unknown>): boolean {
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
export interface KnownPointerRefs {
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

/**
 * Build the structural source_ref for one emitted pointer, or undefined when the
 * pointer carries no fully-formed structural reference. Split out of
 * collectKnownPointerRefs so each function stays under the repo complexity bar.
 */
function structuralSourceRef(
  sourceRef: unknown,
): ReflexPriorContextRef["source_ref"] | undefined {
  if (!sourceRef || typeof sourceRef !== "object" || Array.isArray(sourceRef)) {
    return undefined;
  }
  const sr = sourceRef as Record<string, unknown>;
  if (
    typeof sr.source !== "string" ||
    typeof sr.type !== "string" ||
    typeof sr.id !== "string"
  ) {
    return undefined;
  }
  return {
    source: sr.source,
    type: sr.type,
    id: sr.id,
    ...(typeof sr.namespace === "string" ? { namespace: sr.namespace } : {}),
  };
}

/**
 * Build the prior_context reference for one emitted pointer item, or null when
 * the item carries no resolvable identity at all.
 */
function priorContextRefFor(
  item: Record<string, unknown>,
): ReflexPriorContextRef | null {
  const ref: ReflexPriorContextRef = {};
  if (typeof item.citation_id === "string" && item.citation_id.length > 0) {
    ref.citation_id = item.citation_id;
  }
  const sourceRef = structuralSourceRef(item.source_ref);
  if (sourceRef !== undefined) ref.source_ref = sourceRef;
  // Only echo a reference that actually carries a resolvable identity. A known
  // seed emitted without any identity cannot be suppressed by reference; it is
  // simply not sent, and the reference-coverage check fails the contrast rather
  // than letting an un-referenceable known item pass silently.
  return ref.citation_id !== undefined || ref.source_ref !== undefined ? ref : null;
}

export function collectKnownPointerRefs(
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

    const ref = priorContextRefFor(item);
    if (ref === null) continue;
    refs.push(ref);
    emittedKnownFixtureIds.push(record.fixture_id);
    referencedServerIds.add(serverId);
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
export function emittedKnownServerIds(
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
export function serverIdSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Serialized whole-pack budget accounting for one reflex arm. */
export function budgetOf(payload: ReflexPointersPayload): ReflexArmVerdict["budget"] {
  const serialized = JSON.stringify(payload.pointers).length;
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
    Array.isArray(order) && PACK_ALLOCATION_SECTIONS.every((s) => order.includes(s));
  return {
    content_char_limit: charLimit,
    serialized_pointers_chars: serialized,
    within_budget: charLimit === null ? false : serialized <= charLimit,
    allocation_order_complete: orderComplete,
  };
}

/** The three ground-truth server-id sets one arm is verified against. */
export interface ArmGroundTruth {
  netNewServerIds: Set<string>;
  priorKnownServerIds: Set<string>;
  forbiddenServerIds: Set<string>;
}

/** Server ids of the seeded records whose role and fixture id list both match. */
function serverIdsFor(
  seeded: ReflexAbSeededRecord[],
  role: ReflexAbSeededRecord["namespace_role"],
  fixtureIds: readonly string[],
): Set<string> {
  return new Set(
    seeded
      .filter((r) => r.namespace_role === role && fixtureIds.includes(r.fixture_id))
      .map((r) => r.server_id),
  );
}

/** Derive the ground-truth server-id sets for one run's seeded corpus. */
export function armGroundTruth(
  seeded: ReflexAbSeededRecord[],
  fixture: ReflexAbFixture,
): ArmGroundTruth {
  return {
    netNewServerIds: serverIdsFor(seeded, "primary", fixture.net_new_ids),
    priorKnownServerIds: serverIdsFor(seeded, "primary", fixture.prior_known_ids),
    forbiddenServerIds: serverIdsFor(seeded, "negative", fixture.forbidden_ids),
  };
}

/** Content-free tallies derived from one arm's emitted pointer items. */
export interface ArmScan {
  emittedNetNew: Set<string>;
  redundantResurfacing: number;
  leaks: number;
  bodyFree: boolean;
  emittedCitationCounts: Map<string, number>;
}

/**
 * Count a forbidden id that surfaced in a pointer's structural source_ref
 * WITHOUT matching the top-level pointer id, so a leak is caught wherever it
 * appears in the emitted structure and is never double-counted.
 */
function sourceRefLeak(
  item: Record<string, unknown>,
  forbiddenServerIds: Set<string>,
): boolean {
  const ref = item.source_ref;
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return false;
  const refId = (ref as Record<string, unknown>).id;
  if (typeof refId !== "string" || !forbiddenServerIds.has(refId)) return false;
  const serverId = pointerServerId(item);
  // Avoid double-counting when the pointer id itself already matched.
  return serverId === null || !forbiddenServerIds.has(serverId);
}

/** Tally the emitted pointer citation_ids as an occurrence multiset. */
function tallyPointerCitationIds(
  items: Array<Record<string, unknown>>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const cid = item.citation_id;
    if (typeof cid === "string" && cid.length > 0) {
      counts.set(cid, (counts.get(cid) ?? 0) + 1);
    }
  }
  return counts;
}

/** True when every emitted pointer is body-free. */
function allPointersBodyFree(items: Array<Record<string, unknown>>): boolean {
  for (const item of items) {
    if (!pointerIsBodyFree(item)) return false;
  }
  return true;
}

/**
 * Count forbidden ids across the emitted structure. A forbidden id is a leak
 * whether it is the exact pointer id or embedded in the pointer's structural
 * source_ref id; sourceRefLeak avoids double-counting when both match.
 */
function countLeaks(
  items: Array<Record<string, unknown>>,
  forbiddenServerIds: Set<string>,
): number {
  let leaks = 0;
  for (const item of items) {
    const serverId = pointerServerId(item);
    if (serverId !== null && forbiddenServerIds.has(serverId)) leaks += 1;
  }
  // Also scan structural source_ref ids for a forbidden id that surfaced without
  // matching the top-level pointer id (defensive: a leak is a leak wherever it
  // appears in the emitted structure).
  for (const item of items) {
    if (sourceRefLeak(item, forbiddenServerIds)) leaks += 1;
  }
  return leaks;
}

/** Walk one arm's emitted pointers, deriving every content-free tally. */
export function scanArmItems(
  items: Array<Record<string, unknown>>,
  truth: ArmGroundTruth,
): ArmScan {
  const emittedNetNew = new Set<string>();
  let redundantResurfacing = 0;

  for (const item of items) {
    const serverId = pointerServerId(item);
    if (!serverId) continue;
    if (truth.netNewServerIds.has(serverId)) emittedNetNew.add(serverId);
    if (truth.priorKnownServerIds.has(serverId)) redundantResurfacing += 1;
  }

  return {
    emittedNetNew,
    redundantResurfacing,
    leaks: countLeaks(items, truth.forbiddenServerIds),
    bodyFree: allPointersBodyFree(items),
    emittedCitationCounts: tallyPointerCitationIds(items),
  };
}

/** Occurrence-count comparison of emitted pointer citations vs top-level ones. */
export interface CitationBijection {
  dangling: number;
  uncited: number;
  bijective: boolean;
}

/** Tally the payload's top-level citation ids as an occurrence multiset. */
function tallyTopLevelCitationIds(payload: ReflexPointersPayload): Map<string, number> {
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
 * Citation bijection: the top-level citations must be a one-to-one match of the
 * emitted pointer citation_ids (occurrence counts on both sides).
 *
 * A true multiplicity bijection requires the emitted count to EQUAL the cited
 * count for EVERY identity. Any surplus on the citation side is dangling (cited
 * more than emitted); any surplus on the pointer side is uncited (emitted more
 * than cited). Both are counted per identity so a single identity can never mask
 * its own duplicate: emitted=2/cited=1 is one uncited, emitted=1/cited=2 is one
 * dangling, and emitted=2/cited=2 is clean.
 */
export function citationBijection(
  payload: ReflexPointersPayload,
  emittedCitationCounts: Map<string, number>,
): CitationBijection {
  const citationCounts = tallyTopLevelCitationIds(payload);
  const allIds = new Set<string>([
    ...emittedCitationCounts.keys(),
    ...citationCounts.keys(),
  ]);
  let dangling = 0;
  let uncited = 0;
  for (const id of allIds) {
    const emittedN = emittedCitationCounts.get(id) ?? 0;
    const citedN = citationCounts.get(id) ?? 0;
    if (citedN > emittedN) dangling += citedN - emittedN;
    else if (emittedN > citedN) uncited += emittedN - citedN;
  }
  return { dangling, uncited, bijective: dangling === 0 && uncited === 0 };
}

/** The already-derived signals one arm's failure list is written from. */
export interface ArmFailureInputs {
  arm: "on" | "off";
  status: string;
  bijection: CitationBijection;
  bodyFree: boolean;
  placementClientOwned: boolean;
  budget: ReflexArmVerdict["budget"];
  leaks: number;
  netNewMissing: number;
  redundantResurfacing: number;
}

/**
 * Write one arm's failure strings, in the established order. Every message is
 * byte-identical to the inline version it replaced: these strings are part of
 * the gate's stdout interface.
 */
export function armFailures(input: ArmFailureInputs): string[] {
  const { arm } = input;
  const failures = shapeFailures(input);
  budgetFailures(input, failures);
  if (input.leaks > 0) {
    failures.push(
      `${arm}: namespace isolation breach (${input.leaks} forbidden pointer(s))`,
    );
  }
  // Net-new evidence must be present on BOTH arms: suppression never drops a
  // net-new item, and a hollow empty reflex would otherwise hide a broken recall.
  if (input.netNewMissing > 0) {
    failures.push(
      `${arm}: ${input.netNewMissing} expected net-new record(s) missing from pointers`,
    );
  }
  // The ON arm must have suppressed every already-known reference: any resurfaced
  // known item is a suppression failure.
  if (arm === "on" && input.redundantResurfacing > 0) {
    failures.push(
      `on: suppression enabled but ${input.redundantResurfacing} already-known item(s) resurfaced`,
    );
  }
  return failures;
}

/** Status, citation-bijection, body-freedom, and placement failures, in order. */
function shapeFailures(input: ArmFailureInputs): string[] {
  const { arm, bijection } = input;
  const failures: string[] = [];
  // EVAL-3 functional bar, applied per arm.
  if (input.status !== "ok") {
    failures.push(`${arm}: reflex status is not 'ok'`);
  }
  if (!bijection.bijective) {
    failures.push(
      `${arm}: citations not bijective (dangling=${bijection.dangling} uncited=${bijection.uncited})`,
    );
  }
  if (!input.bodyFree) {
    failures.push(`${arm}: a pointer carried a body-bearing field (leakage)`);
  }
  if (!input.placementClientOwned) {
    failures.push(`${arm}: placement is not client_owned`);
  }
  return failures;
}

/** Whole-pack budget failures, appended in the established order. */
function budgetFailures(input: ArmFailureInputs, failures: string[]): void {
  const { arm, budget } = input;
  if (!budget.within_budget) {
    failures.push(
      `${arm}: serialized pointers ${budget.serialized_pointers_chars} exceed whole-pack limit ${budget.content_char_limit ?? "none"}`,
    );
  }
  if (!budget.allocation_order_complete) {
    failures.push(`${arm}: whole-pack allocation order missing or incomplete`);
  }
}

/**
 * Verify one reflex arm against the EVAL-3 functional bar and the A/B ground
 * truth. Content-free: every derived signal is a count/boolean over server ids
 * mapped back to fixture ids, never a pointer body.
 */
export function verifyArm(
  arm: "on" | "off",
  payload: ReflexPointersPayload,
  seeded: ReflexAbSeededRecord[],
  fixture: ReflexAbFixture,
): ReflexArmVerdict {
  const items = pointerItemsOf(payload);
  const truth = armGroundTruth(seeded, fixture);
  const scan = scanArmItems(items, truth);
  const bijection = citationBijection(payload, scan.emittedCitationCounts);

  const netNewPresent = scan.emittedNetNew.size;
  const netNewMissing = truth.netNewServerIds.size - netNewPresent;
  const budget = budgetOf(payload);
  const placementClientOwned = payload.placement === "client_owned";

  const failures = armFailures({
    arm,
    status: payload.status,
    bijection,
    bodyFree: scan.bodyFree,
    placementClientOwned,
    budget,
    leaks: scan.leaks,
    netNewMissing,
    redundantResurfacing: scan.redundantResurfacing,
  });

  return {
    arm,
    pointer_count: items.length,
    net_new_present: netNewPresent,
    net_new_missing: netNewMissing,
    redundant_resurfacing: scan.redundantResurfacing,
    namespace_leaks: scan.leaks,
    citations_bijective: bijection.bijective,
    dangling_citations: bijection.dangling,
    uncited_pointers: bijection.uncited,
    body_free: scan.bodyFree,
    placement_client_owned: placementClientOwned,
    budget,
    failures,
  };
}
