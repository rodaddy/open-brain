import type { ToolDeps } from "./index.ts";
import type { AuthInfo } from "../types.ts";
import type { AgentContextPackArgs } from "./agent-context-pack.ts";
import { canRead } from "../permissions.ts";
import { namespaceFilterFor } from "../read-policy.ts";
import { ALL_TABLES } from "./table-constants.ts";
import {
  executeSearch,
  type SearchRow,
  type SearchTable,
} from "./search-brain.ts";
import { CONTEXT_PACK_ENVELOPE_CHAR_RESERVE } from "./agent-context-pack-durable-lane.ts";

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

function boundedText(
  value: unknown,
  maxChars: number,
): { text: string | null; truncated: boolean } {
  if (typeof value !== "string" || value.length === 0 || maxChars <= 0) {
    return {
      text: null,
      truncated: typeof value === "string" && value.length > 0,
    };
  }
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
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

  const accessibleTables: SearchTable[] = ALL_TABLES.filter((table) =>
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
    return {
      scopeDenials: [],
      truncation: [],
      degradedSources: [{ source: "durable_memory", reason: "recall_failed" }],
      budget: emptyBudget(),
      citations: [],
    };
  }

  let remainingChars = maxContentChars;
  const items: Array<Record<string, unknown>> = [];
  const citations: Array<Record<string, unknown>> = [];
  let itemsTruncated = false;

  for (const row of rows) {
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
    const citationId = `brain_record:${row.source_type}:${row.id}`;
    items.push({
      id: row.id,
      source_type: row.source_type,
      namespace: row.namespace ?? null,
      content: bounded.text,
      created_at: row.created_at,
      updated_at: row.updated_at ?? null,
      tier: row.tier ?? null,
      citation_id: citationId,
    });
    citations.push({
      id: citationId,
      kind: "brain_record",
      source_ref: row.source_ref ?? {
        source: "brain",
        type: row.source_type,
        id: row.id,
        namespace: row.namespace,
        label: (row.content_preview ?? "").slice(0, 120),
        preview: (row.content_preview ?? "").slice(0, 300),
      },
    });
    remainingChars -= bounded.text.length;
    if (bounded.truncated) itemsTruncated = true;
  }
  // Records beyond the ones whose bodies fit were dropped by the char budget.
  if (items.length < rows.length) itemsTruncated = true;

  const truncation: Array<Record<string, unknown>> = [];
  if (itemsTruncated) {
    truncation.push({
      source: "durable_memory.items",
      max_items: DURABLE_MEMORY_MAX_ITEMS,
      max_item_chars: DURABLE_MEMORY_MAX_ITEM_CHARS,
      content_char_limit: maxContentChars,
    });
  }

  return {
    section: {
      label: "durable_memory",
      namespace_scoped: true,
      query,
      ...(items.length === 0 ? { empty_reason: "no_matches" } : {}),
      items,
      item_count: items.length,
      truncated: truncation.length > 0,
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
