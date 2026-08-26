/**
 * Envelope assembly for `agent_context_pack`: the sections map, the #535
 * sections receipt, the warnings channel, the reported allocation, and the
 * citation list.
 *
 * Split out of the pack builder so the ORDER of the sections map and the
 * composition of each warnings channel are readable in one place. Every field
 * here is contract surface (docs/agent-context-pack-contract.md); nothing in
 * this module decides WHAT was retrieved, only how the finished pieces are
 * named in the answer.
 */
import { SECTION_NAMES } from "./context-pack-args.ts";
import {
  charsUsed,
  wholePackSerializedLimitFor,
  type PackAllocator,
} from "./context-pack-allocator.ts";
import { CONTEXT_PACK_SECTION_PRIORITY } from "./context-pack-budget.ts";

type Warnings = Array<Record<string, unknown>>;
/** Any section's warning list, whatever its own element type is named. */
type WarningInput = ReadonlyArray<unknown>;

/** One section's contribution to the three warnings channels. */
export interface WarningSource {
  scopeDenials?: WarningInput;
  degradedSources?: WarningInput;
  truncation?: WarningInput;
}

/**
 * Build the sections map in allocation-priority order.
 *
 * Insertion order IS the emitted key order, so this is the one place section
 * ordering is decided.
 */
export function assembleSections(options: {
  workingSet: Record<string, unknown> | null;
  recovery: Record<string, unknown> | null;
  durableLane: Record<string, unknown> | null;
  durableMemory: Record<string, unknown> | null;
  structured: Array<{ key: string; section: Record<string, unknown> }>;
}): Record<string, unknown> {
  const sections: Record<string, unknown> = {};
  if (options.workingSet) sections.working_set = options.workingSet;
  if (options.recovery) sections.recovery = options.recovery;
  if (options.durableLane) sections.durable_lane_context = options.durableLane;
  if (options.durableMemory) sections.durable_memory = options.durableMemory;
  for (const { key, section } of options.structured) sections[key] = section;
  return sections;
}

/**
 * #535 receipt: name what was asked for against what came back, so a section
 * that was requested and did NOT arrive is visible in the answer itself.
 *
 * An unknown top-level KEY is already rejected by name at parse time, and an
 * unknown VALUE inside `requested_sections` is already rejected by the enum
 * with the accepted set listed. What neither catches is a section that was
 * spelled correctly, accepted, and then dropped downstream -- allowance
 * eviction being the live case. That still reads as a success-shaped short
 * answer, so the receipt states the difference rather than leaving the caller
 * to diff `sections` against their own request from memory.
 *
 * `requested: null` means the caller sent no `requested_sections` and took the
 * documented working_set-only default -- distinct from an explicit empty array.
 */
export function sectionsReceipt(
  requestedSections: string[] | null,
  servedSections: string[],
): Record<string, unknown> {
  return {
    requested: requestedSections,
    served: servedSections,
    requested_not_served:
      requestedSections === null
        ? []
        : requestedSections.filter((name) => !servedSections.includes(name)),
    // What a BARE call (no requested_sections) did not consult.
    //
    // `requested_not_served` is empty for a bare call and always will be:
    // nothing was requested, so by its own definition nothing was withheld.
    // That is truthful and useless. The caller receives an `ok` envelope
    // listing only `working_set` and has no way to distinguish "the durable
    // corpus was searched and had nothing" from "the durable corpus was never
    // consulted at all" -- and every default-shaped recall takes the second
    // path.
    //
    // This field states the omission plainly instead. It changes no selection
    // behaviour: which sections a bare call serves is a contract decision
    // (docs/agent-context-pack-contract.md), not a receipt concern. It only
    // stops the receipt from implying completeness it never had.
    not_consulted_by_default:
      requestedSections === null
        ? SECTION_NAMES.filter((name: string) => !servedSections.includes(name))
        : [],
  };
}

function asWarnings(input: WarningInput | undefined): Warnings {
  return (input ?? []) as Warnings;
}

/** Concatenate the three warnings channels in source order. */
export function assembleWarnings(
  sources: ReadonlyArray<WarningSource>,
): Record<string, unknown> {
  const scopeDenials: Warnings = [];
  const degradedSources: Warnings = [];
  const truncation: Warnings = [];
  for (const source of sources) {
    scopeDenials.push(...asWarnings(source.scopeDenials));
    degradedSources.push(...asWarnings(source.degradedSources));
    truncation.push(...asWarnings(source.truncation));
  }
  return {
    scope_denials: scopeDenials,
    degraded_sources: degradedSources,
    truncation,
  };
}

/** The reported whole-pack allocation block, present only when one applies. */
export function wholePackReport(
  allocator: PackAllocator,
): Record<string, unknown> {
  if (allocator.wholePackBudget === null) return {};
  return {
    whole_pack: {
      content_char_limit: wholePackSerializedLimitFor(
        allocator.wholePackBudget,
      ),
      content_chars_used: charsUsed(allocator),
      allocation_order: [...CONTEXT_PACK_SECTION_PRIORITY],
    },
  };
}
