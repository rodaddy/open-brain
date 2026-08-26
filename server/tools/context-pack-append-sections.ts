/**
 * Admission of the two append-store sections of `agent_context_pack`:
 * `working_set` (priority 1) and `recovery` (priority 2).
 *
 * They were two near-identical inline blocks in the pack builder, differing
 * only in their key and in which counts must reconcile after a trim. Two copies
 * of one admission rule is how the two sections drift apart under a later edit,
 * so they share one function and name their differences as arguments.
 *
 * Trim direction is the fitter's default (front): these stores are oldest-first,
 * so the front sheds and the newest entries survive.
 */
import {
  chargeAdmitted,
  noteBudgetTruncation,
  servingChars,
  type PackAllocator,
} from "./context-pack-allocator.ts";
import {
  fitItemSection,
  sectionFrameCost,
  serializedLength,
} from "./context-pack-budget.ts";

/**
 * The shape the fitter reconciles: the items it trims, plus whichever counts
 * this section must keep in step with them (`recovery` also carries
 * `pending_count`).
 */
type CountedItemSection = {
  items: Array<{ id: string }>;
  item_count: number;
  [count: string]: unknown;
};

/**
 * Fit one append-store section into the surviving allowance.
 *
 * Returns the section to emit, or null when even its empty envelope does not
 * fit — in which case it is OMITTED to hold the hard allowance, is not
 * admitted, and so leaves the first-member slot available to the next section.
 */
export function admitAppendSection(options: {
  allocator: PackAllocator;
  key: string;
  section: Record<string, unknown> | null;
  /** Counts that must reconcile to what actually survived the trim. */
  reconciledCounts: Array<keyof CountedItemSection>;
}): Record<string, unknown> | null {
  const { allocator, key, section, reconciledCounts } = options;
  if (!section) return null;

  const frame = sectionFrameCost(key, allocator.firstSectionAdmitted);
  const serving = servingChars(allocator, frame);
  const fitted = fitItemSection(
    section as unknown as CountedItemSection,
    reconciledCounts,
    serving,
  );

  const starvedOut =
    fitted.starved && serializedLength(fitted.section) > serving;
  let admitted: Record<string, unknown> | null = null;
  if (!starvedOut) {
    admitted = fitted.section as unknown as Record<string, unknown>;
    chargeAdmitted(allocator, fitted.section, frame);
  }

  if (fitted.truncated) {
    noteBudgetTruncation(allocator, key, fitted.starved);
  }
  return admitted;
}
