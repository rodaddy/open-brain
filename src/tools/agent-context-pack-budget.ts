/**
 * Whole-pack budget allocation and section-fitting helpers for
 * `agent_context_pack`. These are pure, store-agnostic functions that fit each
 * assembled section inside a shared serialized-character budget in a fixed
 * priority order, plus the narrow shared types/constants they operate on.
 * Registration and tool behavior live in `agent-context-pack.ts`.
 */

/**
 * Approximate serialized characters per token. Kept in sync with the
 * durable-lane accounting so the whole-pack char budget derived here matches
 * the per-section content accounting the durable-lane loader reuses.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Deterministic whole-pack allocation order, highest value first. working_set
 * is the exact-scope hot active state, recovery is the explicit opt-in
 * interrupted-session trace, durable_lane_context is the broader recallable
 * lane context, and durable_memory is the query-driven hybrid recall over durable
 * brain records — the lowest-priority section, allocated last against whatever
 * budget survives. A lower-priority section is only assembled against whatever
 * pack budget the higher-priority sections leave behind, so one large section
 * cannot starve a higher-value one. This order is stable for identical inputs.
 */
export const CONTEXT_PACK_SECTION_PRIORITY = [
  "working_set",
  "recovery",
  "durable_lane_context",
  "durable_memory",
] as const;

/** Serialized size, in characters, of a section's content payload. */
export function serializedLength(value: unknown): number {
  if (value === undefined) return 0;
  return JSON.stringify(value).length;
}

/**
 * Serialized framing a section adds to the enclosing `sections` object beyond
 * its own body. The outer `{}` is reserved once up front (2 chars). Within
 * those braces JSON writes members as `"key":<body>` joined by a single `,`
 * between adjacent members — so in `{"a":1,"b":2}` member `a` is framed by just
 * `"a":` (the `"`, key, `"`, `:` = keyLen + 3) and member `b` by a leading comma
 * plus `"b":` (keyLen + 3 + 1).
 *
 * The framing therefore depends on member position, not just the key:
 * - the FIRST admitted member charges `keyLen + 3` (quoted key + colon only);
 * - each SUBSEQUENT admitted member charges `keyLen + 3 + 1` (add one comma).
 *
 * Charging a comma for the first member (the prior behavior) overcounted one
 * character and could falsely truncate content that fit at the exact boundary.
 * `isFirstAdmitted` MUST reflect whether any earlier candidate was actually
 * admitted — a starved or omitted candidate does not consume the first-member
 * slot, so the next admitted section still frames as the first.
 */
export function sectionFrameCost(
  key: string,
  isFirstAdmitted: boolean,
): number {
  // '"' + key + '"' + ':' = key.length + 3, plus one ',' for non-first members.
  return key.length + 3 + (isFirstAdmitted ? 0 : 1);
}

export type DurableLaneEvent = { content?: unknown; citation_id?: unknown };
export type DurableLaneSection = {
  lane?: { current_context_md?: unknown };
  events?: DurableLaneEvent[];
  event_count?: number;
  truncated?: boolean;
};

/**
 * Sum of durable-lane content-body characters (checkpoint + retained event
 * bodies) for reconciling `budget.durable_lane_context.content_chars_used` to
 * whatever survives the whole-pack re-fit.
 */
export function durableLaneContentChars(section: DurableLaneSection): number {
  const context =
    typeof section.lane?.current_context_md === "string"
      ? section.lane.current_context_md.length
      : 0;
  let events = 0;
  for (const event of section.events ?? []) {
    if (typeof event.content === "string") events += event.content.length;
  }
  return context + events;
}

/**
 * Fit a loaded durable-lane section inside the remaining whole-pack budget by
 * its *serialized* size, not its content-body total. The loader already bounds
 * raw content chars, but the serialized section additionally carries lane
 * metadata, per-event wrappers, and citation ids that must be counted against
 * the surviving whole-pack budget. Events are chronological oldest-first (the
 * loader fetches newest-first then reverses), so trailing entries are the
 * newest highest-value ones; drop the oldest (front) first, then trim the
 * checkpoint, so the freshest lane evidence is preserved under pressure.
 *
 * Citations for dropped events are removed so no citation references evidence
 * that is no longer present, and `event_count`/`truncated` are reconciled to
 * the retained events.
 */
export function fitDurableLaneSection(
  section: Record<string, unknown>,
  citations: Array<Record<string, unknown>>,
  remainingChars: number,
): {
  section: Record<string, unknown>;
  citations: Array<Record<string, unknown>>;
  truncated: boolean;
} {
  if (serializedLength(section) <= remainingChars) {
    return { section, citations, truncated: false };
  }

  const events = Array.isArray(section.events)
    ? [...(section.events as DurableLaneEvent[])]
    : [];
  const lane =
    section.lane && typeof section.lane === "object"
      ? { ...(section.lane as Record<string, unknown>) }
      : undefined;

  const rebuild = (
    keptEvents: DurableLaneEvent[],
    contextMd: unknown,
  ): Record<string, unknown> => {
    const next: Record<string, unknown> = {
      ...section,
      events: keptEvents,
      event_count: keptEvents.length,
    };
    if (lane) next.lane = { ...lane, current_context_md: contextMd };
    next.truncated = true;
    return next;
  };

  let contextMd = lane?.current_context_md ?? null;

  // Drop the oldest event (index 0) until the serialized section fits.
  const kept = [...events];
  while (kept.length > 0) {
    kept.shift();
    if (serializedLength(rebuild(kept, contextMd)) <= remainingChars) {
      return {
        section: rebuild(kept, contextMd),
        citations: reconcileDurableCitations(citations, kept),
        truncated: true,
      };
    }
  }

  // No events left: shrink the checkpoint text until the section fits, or empty
  // it entirely.
  if (typeof contextMd === "string" && contextMd.length > 0) {
    let low = 0;
    let high = contextMd.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = rebuild([], contextMd.slice(0, mid));
      if (serializedLength(candidate) <= remainingChars) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    contextMd = low > 0 ? (contextMd as string).slice(0, low) : null;
  }

  return {
    section: rebuild([], contextMd),
    citations: reconcileDurableCitations(citations, []),
    truncated: true,
  };
}

/**
 * Keep the lane citation and only the event citations whose events survived the
 * whole-pack re-fit, so citations never reference dropped evidence.
 */
export function reconcileDurableCitations(
  citations: Array<Record<string, unknown>>,
  keptEvents: DurableLaneEvent[],
): Array<Record<string, unknown>> {
  const keptEventCitationIds = new Set(
    keptEvents
      .map((event) => event.citation_id)
      .filter((id): id is string => typeof id === "string"),
  );
  return citations.filter((citation) => {
    if (citation.kind === "session_event") {
      return (
        typeof citation.id === "string" && keptEventCitationIds.has(citation.id)
      );
    }
    return true;
  });
}

/**
 * Deterministically fit an item-bearing section (working_set/recovery) inside a
 * remaining whole-pack char budget by dropping the oldest items until the
 * serialized section fits. Both stores order items oldest-first: `append`
 * pushes the newest item to the end, and store trimming removes index 0
 * (`splice(0, …)` / `shift()`), so the newest highest-value items live at the
 * tail. Whole-pack pressure must match that recency ordering — drop from the
 * front (oldest) and preserve the newest — so the enforced budget never
 * sacrifices the freshest working state to keep stale entries.
 *
 * The section is measured by its serialized length (`JSON.stringify`), not by
 * summed content-body characters, so metadata, ids, and per-item wrappers are
 * counted against the whole-pack section budget rather than allowed to
 * overshoot it. Counts are reconciled to the retained items so citations and
 * counters stay consistent with the emitted content.
 */
export function fitItemSection<T extends { items: Array<{ id: string }> }>(
  section: T,
  countKeys: Array<keyof T>,
  remainingChars: number,
): { section: T; truncated: boolean; starved: boolean } {
  if (serializedLength(section) <= remainingChars) {
    return { section, truncated: false, starved: false };
  }

  // Drop the oldest item (index 0) one at a time until the section fits or is
  // emptied, preserving the newest tail items. A section is "starved" whenever
  // no item body survives (items: []), whether it fit only once empty or was
  // exhausted — the empty envelope may still exceed remainingChars, so the
  // caller decides whether to emit it or omit the section to hold the budget.
  const kept = [...section.items];
  while (kept.length > 0) {
    kept.shift();
    const candidate = { ...section, items: kept } as T;
    for (const countKey of countKeys) {
      (candidate as Record<keyof T, unknown>)[countKey] = kept.length;
    }
    if (serializedLength(candidate) <= remainingChars) {
      return {
        section: candidate,
        truncated: true,
        starved: kept.length === 0,
      };
    }
  }

  const emptied = { ...section, items: [] as T["items"] } as T;
  for (const countKey of countKeys) {
    (emptied as Record<keyof T, unknown>)[countKey] = 0;
  }
  return { section: emptied, truncated: true, starved: true };
}

export type DurableMemoryItem = { citation_id?: unknown; content?: unknown };
export type DurableMemorySection = {
  items?: DurableMemoryItem[];
  item_count?: number;
};

/**
 * Sum of durable-memory content-body characters (retained item content) for
 * reconciling `budget.durable_memory.content_chars_used` to whatever survives
 * the whole-pack re-fit.
 */
export function durableMemoryContentChars(
  section: DurableMemorySection,
): number {
  let total = 0;
  for (const item of section.items ?? []) {
    if (typeof item.content === "string") total += item.content.length;
  }
  return total;
}

/**
 * Fit a ranked item-bearing section (durable_memory) inside a remaining
 * whole-pack char budget by dropping the LOWEST-ranked items first. Unlike the
 * recency-ordered stores fit by {@link fitItemSection} (newest at the tail, drop
 * the front), hybrid-RRF recall orders items highest-relevance-first, so the
 * lowest-priority items live at the tail. Dropping the tail preserves the
 * highest-ranked recall under budget pressure, matching the issue's
 * "oldest/lowest-priority trimming" contract for a relevance-ordered section.
 *
 * The section is measured by its serialized length (`JSON.stringify`), so
 * per-item metadata, ids, and wrappers are counted against the whole-pack
 * budget. `item_count` is reconciled to the retained items so counters and
 * citations stay consistent with the emitted content. A section is "starved"
 * whenever no item body survives (items: []); the caller decides whether to
 * emit the empty envelope or omit the section to hold the budget.
 */
export function fitRankedItemSection<
  T extends { items: Array<{ citation_id?: unknown }> },
>(
  section: T,
  countKeys: Array<keyof T>,
  remainingChars: number,
): { section: T; truncated: boolean; starved: boolean } {
  if (serializedLength(section) <= remainingChars) {
    return { section, truncated: false, starved: false };
  }

  // Drop the lowest-ranked item (last index) one at a time until the section
  // fits or is emptied, preserving the highest-ranked head items.
  const kept = [...section.items];
  while (kept.length > 0) {
    kept.pop();
    const candidate = { ...section, items: kept } as T;
    for (const countKey of countKeys) {
      (candidate as Record<keyof T, unknown>)[countKey] = kept.length;
    }
    if (serializedLength(candidate) <= remainingChars) {
      return {
        section: candidate,
        truncated: true,
        starved: kept.length === 0,
      };
    }
  }

  const emptied = { ...section, items: [] as T["items"] } as T;
  for (const countKey of countKeys) {
    (emptied as Record<keyof T, unknown>)[countKey] = 0;
  }
  return { section: emptied, truncated: true, starved: true };
}

/**
 * Keep only the citations whose durable-memory items survived the whole-pack
 * re-fit, so citations never reference dropped records.
 */
export function reconcileDurableMemoryCitations(
  citations: Array<Record<string, unknown>>,
  keptItems: DurableMemoryItem[],
): Array<Record<string, unknown>> {
  const keptCitationIds = new Set(
    keptItems
      .map((item) => item.citation_id)
      .filter((id): id is string => typeof id === "string"),
  );
  return citations.filter(
    (citation) =>
      typeof citation.id === "string" && keptCitationIds.has(citation.id),
  );
}
