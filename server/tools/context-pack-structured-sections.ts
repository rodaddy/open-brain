/**
 * Admission of the self-contained structured sections of `agent_context_pack`
 * (priorities 5-9): `profile_guidance`, `process_guidance`, `repo_facts`,
 * `pointers`, and `candidate_memory`.
 *
 * All four loaders return a {@link SectionFragment}, so they are admitted
 * through ONE fitter and share a single whole-pack, citation, and truncation
 * reconciliation. Each binds the read namespace, derives selection only from
 * explicit typed metadata (never inferred from raw conversation), returns a
 * defined empty state, and degrades content-free.
 */
import {
  chargeAdmitted,
  servingChars,
  type PackAllocator,
} from "./context-pack-allocator.ts";
import {
  fitItemSection,
  reconcileCitedItemCitations,
  sectionFrameCost,
  serializedLength,
} from "./context-pack-budget.ts";
import type { SectionFragment } from "./context-pack-sections.ts";

/** Everything the structured sections contribute to the finished pack. */
export interface StructuredSectionAccumulator {
  scopeDenials: Array<Record<string, unknown>>;
  degradedSources: Array<Record<string, unknown>>;
  truncation: Array<Record<string, unknown>>;
  citations: Array<Record<string, unknown>>;
  sections: Array<{ key: string; section: Record<string, unknown> }>;
}

export function createStructuredAccumulator(): StructuredSectionAccumulator {
  return {
    scopeDenials: [],
    degradedSources: [],
    truncation: [],
    citations: [],
    sections: [],
  };
}

/**
 * Stamp a trimmed body so it says so on its OWN `truncated` flag.
 *
 * A downstream reader trusts the section body, not just the warnings channel.
 * When the trim empties it but the envelope still fits, `empty_reason` reads as
 * allowance-starved rather than as a genuine no-data result. Stamped BEFORE the
 * overflow checks so the extra keys count against the allowance.
 */
function stampTrimmedBody(body: Record<string, unknown>): void {
  body.truncated = true;
  if ((body.item_count as number) === 0) {
    body.empty_reason = "whole_pack_budget";
  }
}

function pushOverflowMarker(
  accumulator: StructuredSectionAccumulator,
  allocator: PackAllocator,
  key: string,
  starved: boolean,
): void {
  accumulator.truncation.push({
    source: key,
    reason: "whole_pack_budget",
    max_chars: allocator.wholePackBudget,
    ...(starved ? { starved: true } : {}),
  });
}

/**
 * Fit one assembled fragment into the surviving allowance, reconcile its
 * citations to the surviving items, and record its warnings.
 *
 * Trim direction is `"tail"` here, unlike working_set/recovery. Those append
 * stores are oldest-first so the front sheds; these loaders emit
 * newest/current first (`ORDER BY ... DESC`), so the head must survive.
 * Front-dropping would keep stale older guidance and shed the newest rules.
 */
export function admitStructuredSection(options: {
  accumulator: StructuredSectionAccumulator;
  allocator: PackAllocator;
  key: string;
  fragment: SectionFragment;
}): void {
  const { accumulator, allocator, key, fragment } = options;
  // Content-free denials and degraded sources ALWAYS propagate: they carry no
  // body, only a reason, and the caller needs them even when the section is
  // omitted (e.g. no_active_repo, database_unavailable).
  accumulator.scopeDenials.push(...fragment.scopeDenials);
  accumulator.degradedSources.push(...fragment.degradedSources);

  const body = fragment.section;
  // Hard internal error path: no body to fit; the degraded marker above is the
  // whole story.
  if (!body) return;

  if (allocator.wholePackBudget === null) {
    accumulator.sections.push({ key, section: body });
    accumulator.truncation.push(...fragment.truncation);
    accumulator.citations.push(...fragment.citations);
    allocator.firstSectionAdmitted = false;
    return;
  }

  const frame = sectionFrameCost(key, allocator.firstSectionAdmitted);
  const serving = servingChars(allocator, frame);
  const fitted = fitItemSection(
    body as { items: Array<{ id: string }>; item_count: number },
    ["item_count"],
    serving,
    "tail",
  );
  if (fitted.truncated) {
    stampTrimmedBody(fitted.section as Record<string, unknown>);
  }
  if (fitted.starved && serializedLength(fitted.section) > serving) {
    pushOverflowMarker(accumulator, allocator, key, true);
    return;
  }

  const survived = fitted.section as Record<string, unknown>;
  accumulator.sections.push({ key, section: survived });
  chargeAdmitted(allocator, survived, frame);
  // INVARIANT 3: citations reconciled to exactly the surviving items.
  accumulator.citations.push(
    ...reconcileCitedItemCitations(fragment.citations, survived),
  );
  // A section's own truncation notices only make sense when its body was
  // emitted; a fully-starved section is covered by the starved marker above.
  accumulator.truncation.push(...fragment.truncation);
  if (fitted.truncated) {
    pushOverflowMarker(accumulator, allocator, key, false);
  }
}
