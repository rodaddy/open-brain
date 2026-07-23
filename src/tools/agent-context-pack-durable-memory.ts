import type { ToolDeps } from "./index.ts";
import type { AuthInfo, Table } from "../types.ts";
import type { AgentContextPackArgs } from "./agent-context-pack.ts";
import { canRead } from "../permissions.ts";
import { namespaceFilterFor } from "../read-policy.ts";
import { ALL_TABLES } from "./table-constants.ts";
import { executeSearch, type SearchRow } from "./search-brain.ts";
import {
  CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
  boundedText,
} from "./agent-context-pack-durable-lane.ts";
import {
  suppressReferencedRecords,
  type PriorContextReference,
} from "../prior-context-suppression.ts";

const DURABLE_MEMORY_MAX_CONTENT_CHARS = 8_000;
const DURABLE_MEMORY_MAX_ITEMS = 8;
const DURABLE_MEMORY_MAX_ITEM_CHARS = 1_000;

/**
 * Resolve the durable-memory content char budget.
 *
 * When the whole-pack allocator supplies an explicit `contentCharLimit`, the
 * recall content is bounded by the pack-level allocation it was granted (still
 * clamped by the durable-memory hard cap). Otherwise the historical per-section
 * derivation from `budget.max_tokens` applies, preserving compatibility when no
 * whole-pack allocation is in effect.
 */
function resolveDurableMemoryContentChars(
  args: AgentContextPackArgs,
  contentCharLimit: number | undefined,
): number {
  if (contentCharLimit !== undefined) {
    return Math.max(
      0,
      Math.min(DURABLE_MEMORY_MAX_CONTENT_CHARS, contentCharLimit),
    );
  }
  return Math.max(
    0,
    Math.min(
      DURABLE_MEMORY_MAX_CONTENT_CHARS,
      (args.budget?.max_tokens ?? 4000) * 4 -
        CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
    ),
  );
}

export type DurableMemoryContextFragment = {
  section?: Record<string, unknown>;
  scopeDenials: Array<Record<string, unknown>>;
  truncation: Array<Record<string, unknown>>;
  degradedSources: Array<Record<string, unknown>>;
  budget: Record<string, unknown>;
  citations: Array<Record<string, unknown>>;
};

/**
 * The stable citation id emitted for a recalled brain record. Kept in one place
 * so prior-context suppression keys off the EXACT string that becomes the item's
 * `citation_id`, and the emitted item derives its id from the same call.
 */
function recordCitationId(row: SearchRow): string {
  return `brain_record:${row.source_type}:${row.id}`;
}

/**
 * The bounded structural source_ref emitted for a recalled brain record: the
 * store's own source_ref when present, else a derived `brain_record` pointer.
 * Its identity coordinates (source/type/id/namespace) are what suppression
 * canonicalizes on; `label`/`preview` are display-only and never affect matching.
 */
function recordSourceRef(row: SearchRow) {
  return (
    row.source_ref ?? {
      source: "brain",
      type: row.source_type,
      id: row.id,
      namespace: row.namespace,
      label: (row.content_preview ?? "").slice(0, 120),
      preview: (row.content_preview ?? "").slice(0, 300),
    }
  );
}

/**
 * Build the `durable_memory` section: query-driven hybrid-RRF recall over the
 * caller's readable durable brain records, isolated to the auth-derived
 * namespace. This is distinct from `durable_lane_context`, which returns the
 * exact seven-coordinate active lane. durable_memory answers "what durable
 * records are relevant to this query" within the namespace security boundary.
 *
 * The section is only assembled when a `query` is supplied — recall has no
 * meaning without one — and always returns a defined envelope (empty
 * `items: []` with a reason when there is no query or no matching record), so a
 * caller can distinguish "not requested" (section omitted) from "requested, no
 * durable recall" (section present, empty).
 *
 * Every returned item carries a resolvable `source_ref` and a matching
 * `citation_id`, and the citations list is built from the same source refs, so
 * every emitted item is independently resolvable back to its brain record.
 */
export async function loadDurableMemoryContext(
  args: AgentContextPackArgs,
  auth: AuthInfo,
  namespace: string,
  deps: ToolDeps,
  contentCharLimit?: number,
): Promise<DurableMemoryContextFragment> {
  const maxContentChars = resolveDurableMemoryContentChars(
    args,
    contentCharLimit,
  );
  const query = args.query?.trim() ?? "";

  const emptyBudget = () => ({
    content_char_limit: maxContentChars,
    content_chars_used: 0,
    max_items: DURABLE_MEMORY_MAX_ITEMS,
    max_item_chars: DURABLE_MEMORY_MAX_ITEM_CHARS,
  });

  // Recall requires a query. Return a defined empty section so the caller can
  // tell "requested but no query" apart from "not requested".
  if (query.length === 0) {
    return {
      section: {
        label: "durable_memory",
        namespace_scoped: true,
        query: null,
        empty_reason: "no_query",
        items: [],
        item_count: 0,
        truncated: false,
      },
      scopeDenials: [],
      truncation: [],
      degradedSources: [],
      budget: emptyBudget(),
      citations: [],
    };
  }

  const accessibleTables: Table[] = ALL_TABLES.filter((table) =>
    canRead(auth.role, table),
  );
  if (accessibleTables.length === 0) {
    return {
      section: {
        label: "durable_memory",
        namespace_scoped: true,
        query,
        empty_reason: "no_readable_tables",
        items: [],
        item_count: 0,
        truncated: false,
      },
      scopeDenials: [
        { source: "durable_memory", reasons: ["no_readable_tables"] },
      ],
      truncation: [],
      degradedSources: [],
      budget: emptyBudget(),
      citations: [],
    };
  }

  // Auth-derived namespace predicate is the isolation boundary. An explicit
  // namespace arg was already authorized by the caller (canReadNamespace);
  // otherwise fall back to the caller's own readable namespaces.
  const namespaceFilter = args.namespace
    ? namespaceFilterFor(auth, namespace)
    : namespaceFilterFor(auth);

  let rows: SearchRow[];
  try {
    rows = await executeSearch(
      deps,
      accessibleTables,
      query,
      DURABLE_MEMORY_MAX_ITEMS,
      "hybrid",
      undefined,
      0,
      namespaceFilter,
      false,
    );
  } catch {
    // Recall was explicitly requested for this section but the search failed.
    // Return a truthful empty durable_memory envelope (not an omitted section) so
    // the caller can tell "requested, recall failed" apart from "not requested".
    // The degraded_sources warning stays content-free — no dependency/error
    // detail is leaked into the envelope or the warning.
    return {
      section: {
        label: "durable_memory",
        namespace_scoped: true,
        query,
        empty_reason: "recall_failed",
        items: [],
        item_count: 0,
        truncated: false,
      },
      scopeDenials: [],
      truncation: [],
      degradedSources: [{ source: "durable_memory", reason: "recall_failed" }],
      budget: emptyBudget(),
      citations: [],
    };
  }

  // Prior-context suppression (#333): deterministically drop records already
  // represented in prior context BEFORE the char budget selects and bounds
  // bodies, so the surviving relevance order, item selection, citations, and
  // budget accounting all reconcile against net-new results only. Suppression is
  // pure removal — it can never add, reorder, or leak a record — and keys off the
  // exact citation_id and structural source_ref each record emits. Records with
  // no resolvable identity are kept (they cannot be proven prior context). No raw
  // prior-context text is consulted; only resolvable identity references are.
  const priorContext = (args.prior_context ??
    []) as ReadonlyArray<PriorContextReference>;
  const suppression = suppressReferencedRecords(
    rows,
    (row) => ({
      citation_id: recordCitationId(row),
      source_ref: recordSourceRef(row),
    }),
    priorContext,
  );
  const netNewRows = suppression.kept;

  let remainingChars = maxContentChars;
  const items: Array<Record<string, unknown>> = [];
  const citations: Array<Record<string, unknown>> = [];
  let itemsTruncated = false;

  for (const row of netNewRows) {
    const bounded = boundedText(
      row.content_preview,
      Math.min(DURABLE_MEMORY_MAX_ITEM_CHARS, remainingChars),
    );
    if (!bounded.text) {
      if (
        typeof row.content_preview === "string" &&
        row.content_preview.length > 0
      ) {
        itemsTruncated = true;
      }
      break;
    }
    const citationId = recordCitationId(row);
    // Build the bounded source_ref once per row and attach the SAME object to
    // both the item and its citation, so an item is independently resolvable back
    // to its brain record without a citation lookup, and item.source_ref is
    // identical to citation.source_ref. Citation reconciliation after whole-pack
    // trimming keys off citation_id, so co-locating source_ref on the item keeps
    // the two consistent through partial and full trims.
    const sourceRef = recordSourceRef(row);
    items.push({
      id: row.id,
      source_type: row.source_type,
      namespace: row.namespace ?? null,
      content: bounded.text,
      created_at: row.created_at,
      updated_at: row.updated_at ?? null,
      tier: row.tier ?? null,
      citation_id: citationId,
      source_ref: sourceRef,
    });
    citations.push({
      id: citationId,
      kind: "brain_record",
      source_ref: sourceRef,
    });
    remainingChars -= bounded.text.length;
    if (bounded.truncated) itemsTruncated = true;
  }
  // Net-new records beyond the ones whose bodies fit were dropped by the char
  // budget. Compare against the post-suppression set: records removed as prior
  // context are not a truncation, so they must not flip this flag.
  if (items.length < netNewRows.length) itemsTruncated = true;

  const truncation: Array<Record<string, unknown>> = [];
  if (itemsTruncated) {
    truncation.push({
      source: "durable_memory.items",
      max_items: DURABLE_MEMORY_MAX_ITEMS,
      max_item_chars: DURABLE_MEMORY_MAX_ITEM_CHARS,
      content_char_limit: maxContentChars,
    });
  }

  // Truthful empty state: when nothing survives, distinguish "recall matched
  // nothing" from "every match was already in prior context". `all_suppressed`
  // only applies when the recall DID return rows and suppression removed them
  // all; otherwise the recall genuinely found no matches.
  const emptyReason =
    items.length === 0
      ? rows.length > 0 && suppression.suppression.suppressed === rows.length
        ? "all_suppressed"
        : "no_matches"
      : undefined;

  return {
    section: {
      label: "durable_memory",
      namespace_scoped: true,
      query,
      ...(emptyReason ? { empty_reason: emptyReason } : {}),
      items,
      item_count: items.length,
      truncated: truncation.length > 0,
      // Content-free suppression counters (#333): counts only, never an id, a
      // reference, or a body. `net_new` is pre-budget net-new records; `emitted`
      // is how many survived the char budget.
      prior_context_suppression: {
        recalled: suppression.suppression.recalled,
        suppressed: suppression.suppression.suppressed,
        net_new: suppression.suppression.net_new,
        emitted: items.length,
      },
    },
    scopeDenials: [],
    truncation,
    degradedSources: [],
    budget: {
      content_char_limit: maxContentChars,
      content_chars_used: maxContentChars - remainingChars,
      max_items: DURABLE_MEMORY_MAX_ITEMS,
      max_item_chars: DURABLE_MEMORY_MAX_ITEM_CHARS,
    },
    citations,
  };
}
