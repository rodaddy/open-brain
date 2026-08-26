/**
 * Whole-pack budget allocation and section fitting.
 *
 * Design authority: `docs/agent-context-pack-contract.md` ("Response Shape" →
 * whole-pack allocation, starvation and omission).
 *
 * These are pure, store-agnostic functions. The orchestrator walks the sections
 * in a fixed priority order and hands each one only the serialized budget its
 * predecessors left behind, so a large low-priority section can never starve a
 * higher-value one. Everything here measures SERIALIZED length rather than
 * summed body characters, because the thing that has to fit inside the caller's
 * token budget is the JSON that goes over the wire — item wrappers, ids, and
 * metadata included. Budgeting bodies alone reliably overshoots.
 */

/**
 * Approximate serialized characters per token. Kept in lockstep with the
 * durable-lane accounting so the whole-pack char budget derived here matches the
 * per-section content accounting the loaders reuse.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Deterministic allocation order, highest value first.
 *
 * `working_set` is the exact-scope hot active state, `recovery` the explicit
 * opt-in interrupted-session trace, `durable_lane_context` the broader
 * recallable lane, and `durable_memory` the query-driven hybrid recall. The
 * structured guidance/repo_facts sections follow, and `pointers` +
 * `candidate_memory` are LAST — lightweight reference views that must never
 * starve a body-bearing section. Stable for identical inputs.
 */
export const CONTEXT_PACK_SECTION_PRIORITY = [
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

/** Serialized size, in characters, of a section payload. */
export function serializedLength(value: unknown): number {
  if (value === undefined) return 0;
  return JSON.stringify(value).length;
}

/**
 * Serialized framing a section adds to the enclosing `sections` object beyond
 * its own body.
 *
 * The outer `{}` is reserved once by the caller. Within those braces JSON writes
 * members as `"key":<body>` joined by a single `,` — so in `{"a":1,"b":2}`
 * member `a` is framed by `"a":` (keyLen + 3) and member `b` by that plus one
 * leading comma.
 *
 * The framing is therefore POSITION-sensitive, not just key-sensitive. Charging
 * a comma for the first member overcounts by one character and can falsely
 * truncate content that fits exactly at the boundary. `isFirstAdmitted` must
 * reflect whether an earlier candidate was ACTUALLY admitted — a starved or
 * omitted candidate does not consume the first-member slot.
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
 * bodies), for reconciling `budget.durable_lane_context.content_chars_used` to
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
 * Options for rebuilding a durable-lane section from what survived fitting.
 */
type DurableLaneRebuildOptions = {
  section: Record<string, unknown>;
  lane: Record<string, unknown> | undefined;
  keptEvents: DurableLaneEvent[];
  contextMd: unknown;
};

/**
 * Rebuild the section around the events and checkpoint that survived, marking
 * it truncated and reconciling `event_count` to what remains.
 */
function rebuildDurableLaneSection(
  options: DurableLaneRebuildOptions,
): Record<string, unknown> {
  const { section, lane, keptEvents, contextMd } = options;
  const next: Record<string, unknown> = {
    ...section,
    events: keptEvents,
    event_count: keptEvents.length,
  };
  if (lane) next.lane = { ...lane, current_context_md: contextMd };
  next.truncated = true;
  return next;
}

/**
 * Options for the oldest-first event drop pass.
 */
type DurableLaneDropOptions = {
  section: Record<string, unknown>;
  lane: Record<string, unknown> | undefined;
  events: DurableLaneEvent[];
  contextMd: unknown;
  remainingChars: number;
};

/**
 * Drop the OLDEST event (index 0) until the serialized section fits, so the
 * freshest lane evidence survives pressure. Returns the surviving events once a
 * prefix drop fits, or `null` when even an empty event list does not.
 */
function dropOldestDurableLaneEvents(
  options: DurableLaneDropOptions,
): DurableLaneEvent[] | null {
  const { section, lane, events, contextMd, remainingChars } = options;
  const kept = [...events];
  while (kept.length > 0) {
    kept.shift();
    const candidate = rebuildDurableLaneSection({
      section,
      lane,
      keptEvents: kept,
      contextMd,
    });
    if (serializedLength(candidate) <= remainingChars) return kept;
  }
  return null;
}

/**
 * Options for shrinking the lane checkpoint to the largest prefix that fits.
 */
type DurableLaneCheckpointOptions = {
  section: Record<string, unknown>;
  lane: Record<string, unknown> | undefined;
  contextMd: unknown;
  remainingChars: number;
};

/**
 * Binary-search the largest checkpoint prefix that fits, or drop the checkpoint
 * entirely. Linear shrinking here would be O(n) serializations of a potentially
 * very large checkpoint.
 */
function shrinkDurableLaneCheckpoint(
  options: DurableLaneCheckpointOptions,
): unknown {
  const { section, lane, contextMd, remainingChars } = options;
  if (typeof contextMd !== "string" || contextMd.length === 0) return contextMd;
  let low = 0;
  let high = contextMd.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = rebuildDurableLaneSection({
      section,
      lane,
      keptEvents: [],
      contextMd: contextMd.slice(0, mid),
    });
    if (serializedLength(candidate) <= remainingChars) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? contextMd.slice(0, low) : null;
}

/**
 * Fit a loaded durable-lane section inside the remaining budget by its
 * SERIALIZED size.
 *
 * Events arrive chronological oldest-first (the loader fetches newest-first then
 * reverses), so the trailing entries are the newest and most valuable: drop the
 * OLDEST (front) first, then trim the checkpoint, so the freshest lane evidence
 * survives pressure. Citations for dropped events are removed so no citation
 * references evidence that is no longer present, and `event_count`/`truncated`
 * are reconciled to what remains.
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

  const contextMd = lane?.current_context_md ?? null;

  const kept = dropOldestDurableLaneEvents({
    section,
    lane,
    events,
    contextMd,
    remainingChars,
  });
  if (kept) {
    return {
      section: rebuildDurableLaneSection({
        section,
        lane,
        keptEvents: kept,
        contextMd,
      }),
      citations: reconcileDurableCitations(citations, kept),
      truncated: true,
    };
  }

  const fittedContextMd = shrinkDurableLaneCheckpoint({
    section,
    lane,
    contextMd,
    remainingChars,
  });

  return {
    section: rebuildDurableLaneSection({
      section,
      lane,
      keptEvents: [],
      contextMd: fittedContextMd,
    }),
    citations: reconcileDurableCitations(citations, []),
    truncated: true,
  };
}

/**
 * Keep the lane citation and only the event citations whose events survived, so
 * citations never reference dropped evidence.
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
 * Fit an item-bearing section by dropping items until the serialized section
 * fits.
 *
 * `dropFrom` selects which end sheds first, and the two directions are not
 * interchangeable:
 *
 *   - `"head"` (default) drops the OLDEST item and preserves the newest tail.
 *     This matches `working_set`/`recovery`, whose append stores push newest to
 *     the end, so the newest highest-value items live at the tail.
 *   - `"tail"` drops the last item and preserves the head — for the structured
 *     loaders (guidance, repo_facts) that emit newest/current first
 *     (`ORDER BY created_at DESC` / `updated_at DESC`). Head-dropping there
 *     would keep stale older guidance and shed the newest current rules.
 *
 * A section is "starved" whenever no item body survives. The empty envelope may
 * itself still exceed `remainingChars`, so the CALLER decides whether to emit it
 * or omit the section entirely to hold the hard budget.
 */
export function fitItemSection<T extends { items: Array<{ id: string }> }>(
  section: T,
  countKeys: Array<keyof T>,
  remainingChars: number,
  dropFrom: "head" | "tail" = "head",
): { section: T; truncated: boolean; starved: boolean } {
  if (serializedLength(section) <= remainingChars) {
    return { section, truncated: false, starved: false };
  }

  const kept = [...section.items];
  while (kept.length > 0) {
    if (dropFrom === "tail") kept.pop();
    else kept.shift();
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
 * Sum of durable-memory content-body characters, for reconciling
 * `budget.durable_memory.content_chars_used` to what survives the re-fit.
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
 * Fit a RELEVANCE-ordered section (durable_memory) by dropping the LOWEST-ranked
 * items first.
 *
 * Hybrid-RRF recall orders highest-relevance-first, so the lowest-priority items
 * live at the tail — dropping the tail preserves the best recall under pressure.
 * That is the opposite end from the recency-ordered stores fit by
 * {@link fitItemSection}, and getting it backwards would shed exactly the rows
 * the query ranked highest.
 *
 * Whenever any item is dropped the section's own `truncated` flag is set, so it
 * never reports a stale `false` while its content was trimmed. When trimming
 * empties the list, `empty_reason` is stamped `whole_pack_budget` so the emitted
 * empty envelope states WHY it is empty rather than reading as a genuine
 * no-matches result.
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

  const reconcile = (candidate: T): T => {
    (candidate as Record<string, unknown>).truncated = true;
    if ((candidate.items as unknown[]).length === 0) {
      (candidate as Record<string, unknown>).empty_reason = "whole_pack_budget";
    }
    return candidate;
  };

  const kept = [...section.items];
  while (kept.length > 0) {
    kept.pop();
    const candidate = { ...section, items: kept } as T;
    for (const countKey of countKeys) {
      (candidate as Record<keyof T, unknown>)[countKey] = kept.length;
    }
    if (serializedLength(candidate) <= remainingChars) {
      return {
        section: reconcile(candidate),
        truncated: true,
        starved: kept.length === 0,
      };
    }
  }

  const emptied = { ...section, items: [] as T["items"] } as T;
  for (const countKey of countKeys) {
    (emptied as Record<keyof T, unknown>)[countKey] = 0;
  }
  return { section: reconcile(emptied), truncated: true, starved: true };
}

/**
 * Keep only the citations whose durable-memory items survived the re-fit, so
 * citations never reference dropped records.
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

/** An item-bearing section whose items each carry a `citation_id`. */
export type CitedItemSection = {
  items?: Array<{ citation_id?: unknown }>;
};

/**
 * Keep only the citations whose section items survived, keyed on the item's
 * `citation_id` matching the citation's `id`.
 *
 * This is the generic reconciler for the guidance/repo_facts/pointer sections.
 * Every emitted item carries a `citation_id` and every citation carries that
 * same value as its `id`, so after fitting drops items the surviving citation
 * set is exactly the BIJECTION of the surviving item set: no citation references
 * a trimmed item, and no surviving item loses its citation.
 */
export function reconcileCitedItemCitations(
  citations: Array<Record<string, unknown>>,
  section: CitedItemSection,
): Array<Record<string, unknown>> {
  const keptCitationIds = new Set(
    (section.items ?? [])
      .map((item) => item.citation_id)
      .filter((id): id is string => typeof id === "string"),
  );
  return citations.filter(
    (citation) =>
      typeof citation.id === "string" && keptCitationIds.has(citation.id),
  );
}
