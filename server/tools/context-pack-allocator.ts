/**
 * Whole-pack char allocation state for `agent_context_pack`.
 *
 * INVARIANT 2 lives here. Allocation walks a fixed priority order and each
 * section sees only what its predecessors left. The three values that make that
 * work — the surviving chars, whether the next admitted member still gets the
 * comma-free first slot, and the accumulated `whole_pack_budget` markers — used
 * to be three mutable locals inside one 535-line builder, which is why no
 * section could be lifted out of it. Passing them as ONE object is what lets
 * each section become its own function while the arithmetic stays identical.
 */
import {
  CHARS_PER_TOKEN,
  sectionFrameCost,
  serializedLength,
} from "./context-pack-budget.ts";
import { CONTEXT_PACK_ENVELOPE_CHAR_RESERVE } from "./context-pack-shared.ts";

/** The running whole-pack allocation, mutated in section-priority order. */
export interface PackAllocator {
  /**
   * The declared whole-pack char allowance, or null when `max_tokens` was not
   * requested and every section keeps its independent per-section behavior.
   */
  readonly wholePackBudget: number | null;
  /** Chars still available to section MEMBERS. Infinite when unbounded. */
  remainingChars: number;
  /**
   * Object framing is position-sensitive: the first admitted member costs
   * `"key":<body>`, each subsequent one adds a comma. Flips only when a section
   * is ACTUALLY admitted, so a starved candidate never consumes the comma-free
   * first slot and mis-charges the next section.
   */
  firstSectionAdmitted: boolean;
  /** `whole_pack_budget` markers, in the order the sections were walked. */
  readonly truncation: Array<Record<string, unknown>>;
}

/**
 * Derive the whole-pack allowance from the requested token budget.
 *
 * Absent `max_tokens` => no whole-pack bound.
 */
export function wholePackBudgetFor(
  maxTokens: number | undefined,
): number | null {
  return maxTokens !== undefined
    ? Math.max(
        0,
        maxTokens * CHARS_PER_TOKEN - CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
      )
    : null;
}

/**
 * The REPORTED allowance.
 *
 * It must always admit the irreducible two-character `{}` that JSON.stringify
 * emits even when every section is omitted. At tiny budgets the allowance
 * clamps to 0, so the reported number is raised to that floor; section MEMBERS
 * still get zero of it, so no body is admitted.
 */
export function wholePackSerializedLimitFor(
  wholePackBudget: number | null,
): number | null {
  return wholePackBudget !== null ? Math.max(2, wholePackBudget) : null;
}

/**
 * Open an allocator, reserving the enclosing `{}` once so the running total
 * bounds the serialized `sections` object rather than merely the summed bodies.
 */
export function createAllocator(wholePackBudget: number | null): PackAllocator {
  return {
    wholePackBudget,
    remainingChars:
      wholePackBudget !== null
        ? Math.max(0, wholePackBudget - 2)
        : Number.POSITIVE_INFINITY,
    firstSectionAdmitted: true,
    truncation: [],
  };
}

/** Chars this section may serve once its own framing is paid for. */
export function servingChars(allocator: PackAllocator, frame: number): number {
  return Math.max(0, allocator.remainingChars - frame);
}

/** Charge an admitted body plus its framing against the running total. */
export function chargeAdmitted(
  allocator: PackAllocator,
  body: unknown,
  frame: number,
): void {
  allocator.remainingChars = Math.max(
    0,
    allocator.remainingChars - serializedLength(body) - frame,
  );
  allocator.firstSectionAdmitted = false;
}

/** Record one `whole_pack_budget` marker for a trimmed or starved section. */
export function noteBudgetTruncation(
  allocator: PackAllocator,
  source: string,
  starved = false,
): void {
  allocator.truncation.push({
    source,
    reason: "whole_pack_budget",
    max_chars: allocator.wholePackBudget,
    ...(starved ? { starved: true } : {}),
  });
}

/**
 * The content allowance handed to a loader that trims raw content chars before
 * the serialized section is re-fitted.
 */
export interface SectionServing {
  frame: number;
  serving: number;
  contentLimit: number | undefined;
}

export function sectionServing(
  allocator: PackAllocator,
  key: string,
): SectionServing {
  const frame = sectionFrameCost(key, allocator.firstSectionAdmitted);
  const serving =
    allocator.wholePackBudget === null
      ? Number.POSITIVE_INFINITY
      : servingChars(allocator, frame);
  return {
    frame,
    serving,
    contentLimit:
      allocator.wholePackBudget === null || !Number.isFinite(serving)
        ? undefined
        : Math.floor(serving),
  };
}

/** Chars the pack actually spent, for the reported `content_chars_used`. */
export function charsUsed(allocator: PackAllocator): number {
  return allocator.wholePackBudget === null
    ? 0
    : allocator.wholePackBudget - Math.max(0, allocator.remainingChars);
}
