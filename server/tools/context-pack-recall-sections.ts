/**
 * Admission of the two recall-backed sections of `agent_context_pack`:
 * `durable_lane_context` (priority 3) and `durable_memory` (priority 4).
 *
 * Both are loaded with a content allowance, then RE-FITTED, because the loader
 * trims raw content chars while the serialized section also carries metadata,
 * per-item wrappers, and citation ids. Both drop their citations when they are
 * starved out, so no citation ever references an unemitted section, and both
 * reconcile the reported `content_chars_used` to what actually survived.
 *
 * They are separate functions rather than one parameterized helper because they
 * differ where it matters: the lane path trims oldest-first and finally trims
 * the checkpoint, while durable_memory is relevance-ordered and sheds the
 * LOWEST-ranked tail so the best recall survives.
 */
import {
  chargeAdmitted,
  noteBudgetTruncation,
  type PackAllocator,
} from "./context-pack-allocator.ts";
import {
  durableLaneContentChars,
  durableMemoryContentChars,
  fitDurableLaneSection,
  fitRankedItemSection,
  reconcileDurableMemoryCitations,
  serializedLength,
  type DurableLaneSection,
  type DurableMemorySection,
} from "./context-pack-budget.ts";

/** What one recall section contributes to the pack after re-fitting. */
export interface RecallAdmission<TSection> {
  section: TSection | null;
  citations: Array<Record<string, unknown>>;
  /**
   * True only when a LOADED section was dropped by the re-fit, so the
   * reconciled allocation can report zero content emitted rather than the
   * loader's pre-fit selection.
   */
  starvedOut: boolean;
}

/**
 * Reconcile a loader's reported allocation to what actually survived.
 *
 * A starved-out section reports zero, so the reported block never claims usage
 * for content the caller did not receive.
 */
export function reconcileSectionBudget<TSection>(options: {
  allocator: PackAllocator;
  loaded: Record<string, unknown> | undefined;
  section: TSection | null;
  starvedOut: boolean;
  contentChars: (section: TSection) => number;
}): Record<string, unknown> | undefined {
  const { allocator, loaded, section, starvedOut, contentChars } = options;
  if (allocator.wholePackBudget === null || !loaded) return loaded;
  if (section) {
    return { ...loaded, content_chars_used: contentChars(section) };
  }
  return starvedOut ? { ...loaded, content_chars_used: 0 } : loaded;
}

/** Fit `durable_lane_context` into the surviving allowance. */
export function admitDurableLaneSection(options: {
  allocator: PackAllocator;
  section: DurableLaneSection | null;
  citations: Array<Record<string, unknown>>;
  frame: number;
  serving: number;
}): RecallAdmission<DurableLaneSection> {
  const { allocator, section, citations, frame, serving } = options;
  if (!section) return { section: null, citations: [], starvedOut: false };

  if (allocator.wholePackBudget === null) {
    chargeAdmitted(allocator, section, frame);
    return { section, citations, starvedOut: false };
  }

  const fitted = fitDurableLaneSection(section, citations, serving);
  if (fitted.truncated && serializedLength(fitted.section) > serving) {
    // Even the trimmed section overflows: omit it AND drop its citations.
    noteBudgetTruncation(allocator, "durable_lane_context", true);
    return { section: null, citations: [], starvedOut: true };
  }

  chargeAdmitted(allocator, fitted.section, frame);
  if (fitted.truncated) noteBudgetTruncation(allocator, "durable_lane_context");
  return {
    section: fitted.section,
    citations: fitted.citations,
    starvedOut: false,
  };
}

/** Fit `durable_memory` into the surviving allowance. */
export function admitDurableMemorySection(options: {
  allocator: PackAllocator;
  section: DurableMemorySection | null;
  citations: Array<Record<string, unknown>>;
  frame: number;
  serving: number;
}): RecallAdmission<DurableMemorySection> {
  const { allocator, section, citations, frame, serving } = options;
  if (!section) return { section: null, citations: [], starvedOut: false };

  if (allocator.wholePackBudget === null) {
    chargeAdmitted(allocator, section, frame);
    return { section, citations, starvedOut: false };
  }

  const fitted = fitRankedItemSection(
    section as { items: Array<{ citation_id?: unknown }>; item_count: number },
    ["item_count"],
    serving,
  );
  if (fitted.starved && serializedLength(fitted.section) > serving) {
    noteBudgetTruncation(allocator, "durable_memory", true);
    return { section: null, citations: [], starvedOut: true };
  }

  const survived = fitted.section as DurableMemorySection;
  chargeAdmitted(allocator, survived, frame);
  if (fitted.truncated) noteBudgetTruncation(allocator, "durable_memory");
  return {
    section: survived,
    citations: reconcileDurableMemoryCitations(citations, survived.items ?? []),
    starvedOut: false,
  };
}

export { durableLaneContentChars, durableMemoryContentChars };
