// Pointer + candidate_memory context-pack section builders (#329).
//
// Semantic boundary — READ THIS BEFORE CHANGING THE PREDICATE OR THE SHAPE.
//
// These two sections extend the durable-memory recall surface (#327) with two
// strictly lightweight, strictly non-authoritative views. Both are PURE
// transformers over rows the durable_memory loader ALREADY fetched and ALREADY
// authorized: they issue no query, open no connection, and run no second
// retrieval stack. The durable_memory loader over-fetches one bounded pool in
// its single `executeSearch` call and hands the surplus net-new rows here by
// reference (see agent-context-pack-durable-memory.ts).
//
//   1. `pointers` — resolvable references to memory a client MAY choose to fetch
//      through the authorized read path. A pointer carries the EXACT durable
//      identity (`brain_record:${source_type}:${id}`), the STRUCTURAL source_ref
//      object (source/type/id/namespace — identity coordinates only), and
//      lightweight structural metadata (source_type/id/namespace/tier/timestamps)
//      and NOTHING that reproduces the memory body. In particular it never emits
//      `content`, `content_preview`, `label`, `preview`, or any full text: those
//      are body leakage. A pointer that duplicates a `durable_memory` item (by
//      canonical `brain_record:${source_type}:${id}` identity) is dropped so the
//      same evidence is never double-listed or double-counted against budget.
//
//   2. `candidate_memory` — items that are NOT confirmed durable memory. Every
//      candidate would be explicitly `confidence: "unconfirmed"` with
//      `auto_promotable: false`, carry identity/citation/source_ref, and be
//      deduped against BOTH the retained durable_memory identities and the
//      emitted pointer identities before any candidate count/budget. Candidates
//      are never promoted here. Because no predicate exists yet, the section is
//      always empty and therefore does NOT drive recall on its own: a
//      candidate-only request runs no hybrid retrieval stack (nothing to dedupe
//      against, nothing to emit).
//
//      NO PREDICATE YET (documented, not invented): the current recall surface
//      (`SearchRow` from executeSearch) carries NO explicit candidate/unconfirmed
//      lifecycle predicate — no confidence, no candidate flag, no candidate tier,
//      no `memory_lifecycle_action`. Every row the durable recall returns IS a
//      confirmed durable brain record. Per #329's explicit instruction, when no
//      safe explicit candidate predicate exists, this builder returns a truthful
//      EMPTY candidate section (`items: []`, `item_count: 0`,
//      `empty_reason: "candidate_predicate_unavailable"`, `confidence:
//      "unconfirmed"`, `auto_promotable: false`, no citations) rather than
//      relabeling confirmed recall rows as unconfirmed candidates (fabrication)
//      or emitting a triage preview body (body leakage). No verbose public
//      missing-contract detail is emitted; the empty_reason string alone is the
//      discoverable marker.
//
// Isolation predicate. The only real, server-enforceable isolation predicate on
// these rows is the auth-derived `namespace` column, which the durable_memory
// loader already bound on the recall that produced this pool. These builders add
// no widening: they only remove and re-shape rows already scoped to the caller.
// A caller cannot override the namespace here — there is no path to.
//
// No body copy, no body fetch. Neither builder copies a durable-memory body and
// neither fetches a pointer's body. Resolution is deferred to the client via the
// authorized read path; that is a non-goal of this issue by design.

import type { SearchRow } from "./search-brain.ts";
import {
  recordCitationId,
  recordStructuralSourceRef,
} from "./agent-context-pack-durable-memory.ts";
import {
  resolveItemBudget,
  type SectionBudget,
  type SectionFragment,
} from "./agent-context-pack-sections.ts";

export const POINTERS_SECTION_NAME = "pointers" as const;
export const CANDIDATES_SECTION_NAME = "candidate_memory" as const;

/** Hard ceiling on emitted pointers regardless of pool size or budget. */
const POINTERS_MAX_ITEMS = 20;

/**
 * The canonical `brain_record:${source_type}:${id}` identity a pointer/candidate
 * dedupes on. This is byte-identical to the durable_memory item's `citation_id`
 * and to the retained-durable / emitted-pointer identity sets threaded through
 * the pack, so a pointer never re-lists a retained durable item and a candidate
 * never re-lists a retained durable item OR a pointer. Reusing
 * {@link recordCitationId} keeps the one canonical identity shape in a single
 * place; there is no bare `${source_type}:${id}` key anywhere in the contract.
 */
function identityOf(row: SearchRow): string {
  return recordCitationId(row);
}

/**
 * A single pointer. Resolvable reference ONLY — identity, structural source_ref,
 * and lightweight structural metadata. No body, content_preview, or full text.
 *
 * source_ref.type carries the SINGULAR source_type executeSearch emits
 * (e.g. "decision"). To resolve a pointer through get_entry, derive the table by
 * appending "s" (get_entry table = source_ref.type + "s", e.g. "decisions") and
 * pass source_ref.id as the entry id.
 */
export interface PointerItem {
  id: string;
  source_type: string;
  namespace: string | null;
  tier: string | null;
  created_at: string;
  updated_at: string | null;
  citation_id: string;
  source_ref: {
    source: string;
    type: string;
    id: string;
    namespace?: string;
  };
}

export interface PointerBuilderInput {
  /**
   * ALL net-new authorized recall rows in rank order — the durable loader's
   * already namespace-scoped, already prior-context-suppressed pool. Never
   * re-queried here. It includes rows the durable section emitted; the
   * `durableIdentities` exclusion below decides which are pointer-eligible.
   */
  pool: readonly SearchRow[];
  /**
   * Canonical `brain_record:${source_type}:${id}` identities ACTUALLY RETAINED
   * in the final fitted durable_memory output. Pointers matching any of these are
   * dropped (durable owns that evidence). This is the post-fit set, not the
   * loader's pre-fit emitted set: a suppressed or whole-pack-trimmed durable row
   * is absent here and therefore stays pointer-eligible.
   */
  durableIdentities: Iterable<string>;
  budget?: SectionBudget;
}

/**
 * Build the `pointers` section fragment from the durable loader's net-new
 * surplus pool. Pure transform: dedupe against durable_memory (by identity) and
 * within itself, emit lightweight cited references with NO body, and return a
 * defined empty envelope when nothing citable survives dedupe.
 *
 * The returned fragment matches the shared {@link SectionFragment} shape so the
 * pack admits it through the SAME `admitStructuredSection` path as guidance and
 * repo_facts — one whole-pack fitter, one citation/budget reconciliation.
 */
export function buildPointerSection(
  input: PointerBuilderInput,
): SectionFragment {
  // Pointers carry no per-item text body, so only the item COUNT is budgeted.
  // `maxItemChars` is irrelevant (there is no item text field) but resolveItemBudget
  // keeps the shared budget-shape contract.
  const { maxItems } = resolveItemBudget(input.budget, {
    maxItems: POINTERS_MAX_ITEMS,
    maxItemChars: 0,
  });

  const durableIdentities = new Set(input.durableIdentities);
  const seen = new Set<string>();
  const items: PointerItem[] = [];
  const citations: Array<Record<string, unknown>> = [];
  let dedupedAgainstDurable = 0;
  let itemsTruncated = false;

  for (const row of input.pool) {
    const identity = identityOf(row);
    // Dedupe against durable_memory FIRST: the durable section owns this
    // evidence, so it is never re-listed nor counted against the pointer budget.
    if (durableIdentities.has(identity)) {
      dedupedAgainstDurable += 1;
      continue;
    }
    // Dedupe within the pointer pool: keep the first (highest-ranked)
    // occurrence, never re-list the same record twice.
    if (seen.has(identity)) continue;
    seen.add(identity);

    if (items.length >= maxItems) {
      itemsTruncated = true;
      break;
    }

    const citationId = recordCitationId(row);
    // Identity-only structural source_ref: same coordinates the durable item's
    // source_ref carries, with every display/body field (label/preview) stripped.
    const sourceRef = recordStructuralSourceRef(row);
    items.push({
      id: row.id,
      source_type: row.source_type,
      namespace: row.namespace ?? null,
      tier: row.tier ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at ?? null,
      citation_id: citationId,
      source_ref: sourceRef,
    });
    citations.push({
      id: citationId,
      kind: "pointer",
      source_ref: sourceRef,
    });
  }

  const truncation: Array<Record<string, unknown>> = [];
  if (itemsTruncated) {
    truncation.push({
      source: `${POINTERS_SECTION_NAME}.items`,
      max_items: maxItems,
    });
  }

  const budget = {
    max_items: maxItems,
    deduped_against_durable: dedupedAgainstDurable,
    items_emitted: items.length,
  };

  return {
    section: {
      label: POINTERS_SECTION_NAME,
      namespace_scoped: true,
      // Standing invariant: a pointer carries no memory body, only a resolvable
      // reference a client may fetch through the authorized read path.
      resolvable_reference_only: true,
      items,
      item_count: items.length,
      truncated: itemsTruncated,
    },
    scopeDenials: [],
    truncation,
    degradedSources: [],
    budget,
    citations,
  };
}

/**
 * Stable, content-free empty reason for `candidate_memory`: the current recall
 * surface (`SearchRow` from executeSearch) exposes no explicit
 * unconfirmed/candidate lifecycle predicate — no confidence, candidate flag,
 * candidate tier, or `memory_lifecycle_action` — so every recalled row is a
 * confirmed durable record. Per #329, when no safe explicit candidate predicate
 * exists the section stays truthfully empty with this exact reason rather than
 * inferring candidacy from raw recall (fabrication) or emitting a triage body
 * (leakage). No verbose public payload is emitted; the reason string alone is
 * the discoverable marker of the missing write-side contract.
 */
const CANDIDATE_PREDICATE_UNAVAILABLE =
  "candidate_predicate_unavailable" as const;

/**
 * Build the `candidate_memory` section fragment.
 *
 * Truthful empty state by design (#329): no explicit candidate predicate exists
 * in the current recall surface, so this returns a defined empty candidate
 * envelope carrying the standing candidate invariants (`confidence:
 * "unconfirmed"`, `auto_promotable: false`) with `items: []`, `item_count: 0`,
 * `empty_reason: "candidate_predicate_unavailable"`, and NO citations. It never
 * relabels confirmed recall as a candidate, never infers candidacy, and never
 * emits a body or a verbose public missing-contract payload.
 *
 * The section owns no real selection or dedupe behavior yet: with no predicate
 * it emits nothing, so it takes no pool and no dedupe set. Critically, a
 * candidate_memory request MUST NOT trigger durable recall just to compute a
 * synthetic dedupe count against rows it can never emit (that would run the
 * hybrid retrieval stack for a section that is always empty). The dedupe
 * contract (candidates would dedupe against retained durable AND pointer
 * identities) is documented here and enforced only once a real write-side
 * candidate predicate exists.
 */
export function buildCandidateSection(): SectionFragment {
  return {
    section: {
      label: CANDIDATES_SECTION_NAME,
      namespace_scoped: true,
      // Standing invariants surfaced for consumers: every candidate this section
      // could ever emit is unconfirmed and never auto-promotable.
      confidence: "unconfirmed",
      auto_promotable: false,
      items: [],
      item_count: 0,
      // No safe explicit candidate predicate exists yet, so the section is
      // truthfully empty for this exact reason. Distinct from a budget-starved
      // empty (whole_pack_budget), which the pack stamps instead.
      empty_reason: CANDIDATE_PREDICATE_UNAVAILABLE,
      truncated: false,
    },
    scopeDenials: [],
    truncation: [],
    degradedSources: [],
    budget: {
      max_items: 0,
      items_emitted: 0,
    },
    citations: [],
  };
}
