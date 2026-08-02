/**
 * `pointers` and `candidate_memory` — the two lightweight, non-authoritative
 * views over the single durable recall (#329).
 *
 * Design authority: `docs/agent-context-pack-contract.md` ("Response Shape",
 * "Reflex Pointer Surface").
 *
 * READ THIS BEFORE CHANGING THE PREDICATE OR THE SHAPE.
 *
 * Both builders are PURE TRANSFORMS over rows the durable_memory loader already
 * fetched and already authorized. They issue no query, open no connection, and
 * run no second retrieval stack — the loader over-fetches one bounded pool in
 * its single `executeSearch` call and hands it here by reference.
 *
 *   1. `pointers` — resolvable references a client MAY choose to fetch through
 *      the authorized read path. A pointer carries the exact durable identity
 *      (`brain_record:${source_type}:${id}`), the STRUCTURAL source_ref
 *      (source/type/id/namespace — identity coordinates only), and lightweight
 *      structural metadata. It carries NOTHING that reproduces the memory body:
 *      no `content`, `content_preview`, `label`, or `preview`. Those are body
 *      leakage, and the entire value of a pointer is that it is cheap and
 *      body-free. A pointer duplicating a durable_memory item is dropped, so the
 *      same evidence is never double-listed or double-counted against budget.
 *
 *   2. `candidate_memory` — items that are NOT confirmed durable memory.
 *
 *      NO PREDICATE YET, documented rather than invented. The current recall
 *      surface (`SearchRow`) carries no explicit candidate/unconfirmed lifecycle
 *      predicate — no confidence, no candidate flag, no candidate tier. Every
 *      row the recall returns IS a confirmed durable record. So this builder
 *      returns a truthful EMPTY section rather than relabeling confirmed rows as
 *      unconfirmed candidates (fabrication) or emitting a triage preview body
 *      (leakage). The `empty_reason` string alone is the discoverable marker of
 *      the missing write-side contract.
 *
 * ISOLATION. The only server-enforceable predicate on these rows is the
 * auth-derived `namespace` column, which the durable loader already bound on the
 * recall that produced this pool. These builders add no widening: they only
 * remove and re-shape rows already scoped to the caller. There is no path here
 * by which a caller could override the namespace.
 */
import type { SearchRow } from "./search-engine.ts";
import {
  recordCitationId,
  recordStructuralSourceRef,
} from "./context-pack-durable-memory.ts";
import {
  resolveItemBudget,
  type SectionBudget,
  type SectionFragment,
} from "./context-pack-sections.ts";

export const POINTERS_SECTION_NAME = "pointers" as const;
export const CANDIDATES_SECTION_NAME = "candidate_memory" as const;

/** Hard ceiling on emitted pointers regardless of pool size or budget. */
const POINTERS_MAX_ITEMS = 20;

/**
 * The canonical identity a pointer dedupes on. Byte-identical to the durable
 * item's `citation_id` and to the identity sets threaded through the pack, by
 * reusing {@link recordCitationId} rather than re-deriving the string here —
 * two spellings of the same identity is exactly how a dedupe silently stops
 * working.
 */
function identityOf(row: SearchRow): string {
  return recordCitationId(row);
}

/**
 * A single pointer: identity, structural source_ref, and lightweight structural
 * metadata. No body, no preview, no full text.
 *
 * `source_ref.type` carries the SINGULAR source_type (e.g. "decision"). To
 * resolve through `get_entry`, derive the table by appending "s" (e.g.
 * "decisions") and pass `source_ref.id`.
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
   * ALL net-new authorized recall rows in rank order — already
   * namespace-scoped, already prior-context-suppressed. Never re-queried here.
   */
  pool: readonly SearchRow[];
  /**
   * Identities ACTUALLY RETAINED in the final fitted durable_memory output.
   * Pointers matching any of these are dropped, because durable owns that
   * evidence. This is the POST-fit set, not the loader's pre-fit emitted set: a
   * whole-pack-trimmed durable row is absent here and therefore stays
   * pointer-eligible rather than vanishing from the pack entirely.
   */
  durableIdentities: Iterable<string>;
  budget?: SectionBudget;
}

/**
 * Build the `pointers` fragment. Pure transform: dedupe against durable_memory
 * by identity and within itself, emit lightweight cited references with no body,
 * and return a defined empty envelope when nothing survives.
 *
 * The returned fragment matches {@link SectionFragment} so the pack admits it
 * through the SAME fitter as guidance and repo_facts — one whole-pack budget,
 * one citation reconciliation, no parallel path to drift.
 */
export function buildPointerSection(
  input: PointerBuilderInput,
): SectionFragment {
  // Pointers carry no per-item text body, so only the item COUNT is budgeted.
  // `maxItemChars` is irrelevant here but keeps the shared budget-shape contract.
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
    // Dedupe against durable_memory FIRST: it owns this evidence, so the row is
    // never re-listed AND never counted against the pointer budget.
    if (durableIdentities.has(identity)) {
      dedupedAgainstDurable += 1;
      continue;
    }
    // Dedupe within the pool: keep the first (highest-ranked) occurrence.
    if (seen.has(identity)) continue;
    seen.add(identity);

    if (items.length >= maxItems) {
      itemsTruncated = true;
      break;
    }

    const citationId = recordCitationId(row);
    // Identity-only source_ref: same coordinates the durable item carries, with
    // every display/body field stripped.
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
    citations.push({ id: citationId, kind: "pointer", source_ref: sourceRef });
  }

  const truncation: Array<Record<string, unknown>> = [];
  if (itemsTruncated) {
    truncation.push({
      source: `${POINTERS_SECTION_NAME}.items`,
      max_items: maxItems,
    });
  }

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
    budget: {
      max_items: maxItems,
      deduped_against_durable: dedupedAgainstDurable,
      items_emitted: items.length,
    },
    citations,
  };
}

/**
 * Stable, content-free empty reason for `candidate_memory`. The reason string
 * alone is the discoverable marker of the missing write-side contract; no
 * verbose public missing-contract payload is emitted.
 */
const CANDIDATE_PREDICATE_UNAVAILABLE =
  "candidate_predicate_unavailable" as const;

/**
 * Build the `candidate_memory` fragment: a truthful empty state by design.
 *
 * It carries the standing candidate invariants (`confidence: "unconfirmed"`,
 * `auto_promotable: false`) with no items and no citations. It never relabels
 * confirmed recall as a candidate, never infers candidacy, and never emits a
 * body.
 *
 * Critically it takes NO pool and drives NO recall. A candidate_memory request
 * must not trigger the hybrid retrieval stack merely to compute a synthetic
 * dedupe count against rows it can never emit. The full dedupe contract —
 * candidates would dedupe against retained durable AND emitted pointer
 * identities — is documented here and enforced only once a real write-side
 * candidate predicate exists.
 */
export function buildCandidateSection(): SectionFragment {
  return {
    section: {
      label: CANDIDATES_SECTION_NAME,
      namespace_scoped: true,
      confidence: "unconfirmed",
      auto_promotable: false,
      items: [],
      item_count: 0,
      // Distinct from a budget-starved empty (`whole_pack_budget`), which the
      // pack stamps instead. The two mean different things to a caller.
      empty_reason: CANDIDATE_PREDICATE_UNAVAILABLE,
      truncated: false,
    },
    scopeDenials: [],
    truncation: [],
    degradedSources: [],
    budget: { max_items: 0, items_emitted: 0 },
    citations: [],
  };
}
