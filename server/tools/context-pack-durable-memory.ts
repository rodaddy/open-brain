/**
 * `durable_memory` — query-driven hybrid recall over the caller's readable
 * durable brain records.
 *
 * Design authority: `docs/agent-context-pack-contract.md` ("Response Shape"),
 * #327 (ONE shared recall stack), #333 (prior-context suppression), #329
 * (pointer/candidate views over that same recall).
 *
 * This is distinct from `durable_lane_context`, which returns one exact lane.
 * durable_memory answers "what durable records are relevant to this query",
 * inside the namespace security boundary.
 *
 * There is exactly ONE retrieval call in this file. `pointers` and
 * `candidate_memory` are pure transforms over its result — that is the whole
 * point of #329, and it is why the pool is handed out by reference rather than
 * re-queried. A second `executeSearch` here would double the cost of every pack
 * and could return a DIFFERENT ranking, so pointers would dedupe against rows
 * durable_memory never saw.
 */
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import { canRead } from "../auth/permissions.ts";
import type { AgentContextPackArgs } from "./context-pack-args.ts";
import { namespaceFilterFor } from "./read-scope.ts";
import { ALL_TABLES } from "./search-constants.ts";
import { executeSearch, type SearchRow } from "./search-engine.ts";
import type { MemoryToolDependencies } from "./types.ts";
import {
  type DurableFailureLogger,
  asError,
  boundedText,
  errorIdentityFields,
  logDurableFailure,
  pgDiagnosticFields,
  resolveContentChars,
} from "./context-pack-shared.ts";
import {
  suppressReferencedRecords,
  type PriorContextReference,
} from "./prior-context-suppression.ts";

/**
 * Unbounded content by default. These were once 8,000 content chars / 1,000
 * chars per item — numbers an agent wrote, never numbers anyone asked for. A
 * caller that explicitly passes `budget.max_tokens` still gets a pack sized to
 * that request; absent that, a record that IS delivered is delivered whole.
 */
const DURABLE_MEMORY_MAX_CONTENT_CHARS = Number.MAX_SAFE_INTEGER;
const DURABLE_MEMORY_MAX_ITEM_CHARS = Number.MAX_SAFE_INTEGER;

/**
 * How many recalled records one reply carries — the BURST SIZE (#563, operator
 * ruling 2026-08-08, ledger item 23).
 *
 * This is a DELIVERY SHAPE, not a bound on recall, storage, or what a caller
 * can obtain. Every record the query matched stays retrievable: rows beyond
 * this burst are emitted as `pointers` (the resolvable-reference surface
 * docs/agent-context-pack-contract.md already designates for follow-up fetch)
 * and the section carries a `next` handle that walks the SAME ranked recall in
 * further bursts until the caller holds all of it. Nothing is dropped, nothing
 * is stored smaller, and no record comes back trimmed for being late in the
 * ranking.
 *
 * The operator's words: "it still should come through as single input outputs
 * or maybe bursts of 5 to 10 input outputs that are sent from the server to the
 * client, but not ever as the whole file." Ten is the top of the range he
 * named. Serializing the whole corpus into one reply — 60.4 MiB measured
 * 2026-08-05, which no broker will carry — is the shape this makes
 * unproducible: "I don't see any reason why this whole thing would ship in a
 * single shot to anywhere. It defeats the whole purpose of this."
 */
export const DURABLE_MEMORY_BURST_ITEMS = 10;

/**
 * Extra rows fetched beyond the item cap so `pointers` has a net-new pool
 * WITHOUT a second retrieval stack.
 *
 * The emitted durable_memory COUNT is unchanged by this over-fetch — it stays
 * capped regardless of pool size. What can legitimately shift is the fused
 * top-N itself: hybrid RRF ranks over the whole fetched pool, so a deeper pool
 * can reorder which rows land in the top N. That is a property of fetching
 * deeper, not a change to the count; tests assert the count and the
 * pointer/dedupe contract, never a frozen top-N identity.
 */
const DURABLE_MEMORY_POINTER_OVERFETCH = 20;

export type DurableMemoryContextFragment = {
  section?: Record<string, unknown>;
  scopeDenials: Array<Record<string, unknown>>;
  truncation: Array<Record<string, unknown>>;
  degradedSources: Array<Record<string, unknown>>;
  budget: Record<string, unknown>;
  citations: Array<Record<string, unknown>>;
  /**
   * ALL net-new recall rows the SAME `executeSearch` call returned and that
   * survived prior-context suppression, in hybrid-RRF rank order (#329). This is
   * the pointer/candidate builders' already-authorized, already-suppressed pool,
   * passed by reference so no second retrieval stack runs.
   *
   * It deliberately includes rows durable_memory DID emit as items, not only the
   * surplus beyond the cap. Pointer eligibility is decided in the pack against
   * the identities ACTUALLY RETAINED in the final fitted output — so a
   * pointers-only request (section suppressed) makes every authorized row
   * pointer-eligible, and a whole-pack-trimmed durable row stays
   * pointer-eligible instead of being silently lost. Empty on every
   * empty/degraded/denied path.
   */
  pointerCandidatePool: SearchRow[];
};

/**
 * The stable citation id for a recalled brain record.
 *
 * Kept in ONE place so prior-context suppression keys off the exact string that
 * becomes the item's `citation_id`, and so a pointer's identity is
 * byte-identical to the durable item it dedupes against. There is no bare
 * `${source_type}:${id}` key anywhere in this contract.
 */
export function recordCitationId(row: SearchRow): string {
  return `brain_record:${row.source_type}:${row.id}`;
}

/**
 * The bounded structural source_ref for a recalled record: the store's own
 * source_ref when present, else a derived `brain_record` pointer.
 *
 * NOTE this MAY carry `label`/`preview` (bounded content) for the durable item
 * and its citation. The `pointers` section must NOT emit those display fields —
 * it uses {@link recordStructuralSourceRef} instead.
 */
export function recordSourceRef(row: SearchRow) {
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
 * The identity-ONLY structural source_ref: the same coordinates suppression
 * canonicalizes on, with every display/body field stripped. This is what
 * `pointers` emit — resolvable, byte-comparable on identity to the durable
 * item's source_ref, and carrying no body.
 */
export function recordStructuralSourceRef(row: SearchRow): {
  source: string;
  type: string;
  id: string;
  namespace?: string;
} {
  const full = recordSourceRef(row) as unknown as Record<string, unknown>;
  const structural: {
    source: string;
    type: string;
    id: string;
    namespace?: string;
  } = {
    source: String(full.source),
    type: String(full.type),
    id: String(full.id),
  };
  if (full.namespace !== undefined && full.namespace !== null) {
    structural.namespace = String(full.namespace);
  }
  return structural;
}

/**
 * Build the `durable_memory` section.
 *
 * Always returns a DEFINED envelope — an empty `items: []` with a reason when
 * there is no query or no match — so a caller can distinguish "not requested"
 * (section omitted) from "requested, nothing recalled" (section present, empty).
 * Every item carries a resolvable `source_ref` and a matching `citation_id`, and
 * the citations are built from the same refs, so every emitted item is
 * independently resolvable back to its record.
 */
/** Everything the durable-memory recall path needs, in one object. */
export type DurableMemoryContextRequest = {
  args: AgentContextPackArgs;
  auth: AuthIdentity;
  namespace: string;
  dependencies: MemoryToolDependencies;
  contentCharLimit?: number;
};

/** The allocation block every empty/degraded/denied fragment reports. */
function emptyBudget(maxContentChars: number): Record<string, unknown> {
  return {
    content_char_limit: maxContentChars,
    content_chars_used: 0,
    burst_items: DURABLE_MEMORY_BURST_ITEMS,
    max_item_chars: DURABLE_MEMORY_MAX_ITEM_CHARS,
  };
}

/** A fragment carrying a defined-but-empty section and nothing else. */
function emptyFragment(options: {
  section: Record<string, unknown>;
  maxContentChars: number;
  extra?: Partial<DurableMemoryContextFragment>;
}): DurableMemoryContextFragment {
  return {
    section: options.section,
    scopeDenials: [],
    truncation: [],
    degradedSources: [],
    budget: emptyBudget(options.maxContentChars),
    citations: [],
    pointerCandidatePool: [],
    ...options.extra,
  };
}

/** The common shape of every empty durable_memory section. */
function emptySection(
  query: string | null,
  emptyReason: string,
): Record<string, unknown> {
  return {
    label: "durable_memory",
    namespace_scoped: true,
    query,
    empty_reason: emptyReason,
    items: [],
    item_count: 0,
    truncated: false,
  };
}

/**
 * Run the one retrieval call, or return the truthful empty envelope for a
 * failure.
 *
 * Recall was explicitly requested and failed. A defined empty envelope (not an
 * omitted section) lets the caller tell "requested, recall failed" apart from
 * "not requested". The envelope and the warning stay content-free — no
 * dependency or error detail leaks into either — but the reason is NOT thrown
 * away: this catch used to swallow the error entirely, so a failed recall was
 * indistinguishable from an empty one.
 */
async function recallRows(options: {
  request: DurableMemoryContextRequest;
  query: string;
  accessibleTables: ResourceTable[];
  namespaceFilter: string | string[] | undefined;
  maxContentChars: number;
}): Promise<{ rows: SearchRow[] } | { failure: DurableMemoryContextFragment }> {
  const { request, query, accessibleTables, namespaceFilter, maxContentChars } =
    options;
  try {
    const rows = await executeSearch(
      request.dependencies,
      accessibleTables,
      query,
      // Everything the query matches, plus the pointer over-fetch. Retrieval is
      // UNCHANGED by #563: the burst shape governs how many records one REPLY
      // carries, never how many the query is allowed to find. Guard the
      // addition: MAX_SAFE_INTEGER + 20 is no longer an exact integer and
      // Postgres rejects it, so an unbounded ask is passed through as-is.
      Number.isSafeInteger(
        Number.MAX_SAFE_INTEGER + DURABLE_MEMORY_POINTER_OVERFETCH,
      )
        ? Number.MAX_SAFE_INTEGER + DURABLE_MEMORY_POINTER_OVERFETCH
        : Number.MAX_SAFE_INTEGER,
      "hybrid",
      undefined,
      0,
      namespaceFilter,
    );
    return { rows };
  } catch (error) {
    logRecallFailure({
      logger: request.dependencies.logger,
      auth: request.auth,
      args: request.args,
      query,
      accessibleTables,
      namespaceFilter,
      error,
    });
    return {
      failure: emptyFragment({
        section: emptySection(query, "recall_failed"),
        maxContentChars,
        extra: {
          degradedSources: [
            { source: "durable_memory", reason: "recall_failed" },
          ],
        },
      }),
    };
  }
}

type BurstItems = {
  items: Array<Record<string, unknown>>;
  citations: Array<Record<string, unknown>>;
  remainingChars: number;
  itemsTruncated: boolean;
};

/** Shape one burst of ranked net-new rows into emitted items and citations. */
function buildBurstItems(
  burstRows: readonly SearchRow[],
  startingChars: number,
): BurstItems {
  const items: Array<Record<string, unknown>> = [];
  const citations: Array<Record<string, unknown>> = [];
  let remainingChars = startingChars;
  let itemsTruncated = false;

  for (const row of burstRows) {
    const bounded = boundedText(
      row.content_preview,
      Math.min(DURABLE_MEMORY_MAX_ITEM_CHARS, remainingChars),
    );
    if (!bounded.text) {
      // A non-empty body the char allocation could not admit IS a genuine
      // durable drop. The row keeps a valid identity and stays
      // pointer-eligible.
      if (
        typeof row.content_preview === "string" &&
        row.content_preview.length > 0
      ) {
        itemsTruncated = true;
      }
      continue;
    }
    const citationId = recordCitationId(row);
    // Build the source_ref ONCE and attach the SAME object to both the item and
    // its citation, so an item is independently resolvable without a citation
    // lookup and the two can never drift through a partial trim.
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

  return { items, citations, remainingChars, itemsTruncated };
}

/**
 * The burst window: the slice of the ranked net-new recall THIS reply delivers
 * (#563).
 *
 * Rows before it were delivered by an earlier burst in the walk; rows after it
 * are delivered by a later one and stay pointer-eligible meanwhile. Every row
 * is in exactly one burst, so a full walk reconstructs the complete recalled
 * set — this re-shapes delivery, it does not discard. A caller walking the
 * corpus replays the same request carrying the handle the previous reply
 * returned; absent one, the walk starts at the top of the ranking.
 */
function burstWindow(
  netNewRows: readonly SearchRow[],
  requestedOffset: number | undefined,
): {
  burstOffset: number;
  burstRows: SearchRow[];
  burstEnd: number;
  moreAfterBurst: boolean;
} {
  const burstOffset = Math.max(0, Math.trunc(requestedOffset ?? 0));
  const burstRows = netNewRows.slice(
    burstOffset,
    burstOffset + DURABLE_MEMORY_BURST_ITEMS,
  );
  const burstEnd = burstOffset + burstRows.length;
  return {
    burstOffset,
    burstRows,
    burstEnd,
    moreAfterBurst: netNewRows.length > burstEnd,
  };
}

/**
 * What this burst could not emit, if anything.
 *
 * When net-new records survived suppression but NONE produced an emittable
 * body, durable_memory reports zero items with a truncated empty state: the
 * diverted rows still resurface as pointers, but the durable section says
 * truthfully that it emitted no content for a net-new match. Scoped to the
 * burst window: a later burst that is legitimately empty because the walk has
 * run past the end of the recall must not be reported as unemittable content.
 */
function memoryTruncationEntries(options: {
  burst: BurstItems;
  burstRowCount: number;
  netNew: number;
  maxContentChars: number;
}): Array<Record<string, unknown>> {
  const { burst, burstRowCount, netNew, maxContentChars } = options;
  const unemittableNetNew =
    burst.items.length === 0 && burstRowCount > 0 && netNew > 0;
  if (!burst.itemsTruncated && !unemittableNetNew) return [];
  return [
    {
      source: "durable_memory.items",
      burst_items: DURABLE_MEMORY_BURST_ITEMS,
      max_item_chars: DURABLE_MEMORY_MAX_ITEM_CHARS,
      content_char_limit: maxContentChars,
    },
  ];
}

/**
 * Which of the four genuine zero-item causes applies, or `undefined` when items
 * were emitted.
 *
 * The order is the only one that reads correctly.
 *   - walk_complete: the caller walked past the end of the recall, so this
 *     reply is empty for the one benign reason — everything was already
 *     delivered. Checked FIRST because it is a property of the WALK, not of the
 *     records; reporting it as no_matches would tell a caller who now holds the
 *     whole corpus that nothing matched.
 *   - content_unavailable: net-new records survived but none had an emittable
 *     body (null/empty preview, or the allocation admitted none). Checked
 *     before no_matches so a net-new-but-unemittable section can never be
 *     mislabeled.
 *   - all_suppressed: recall returned rows and suppression removed every one.
 *   - no_matches: recall genuinely found nothing.
 */
function resolveEmptyReason(options: {
  itemCount: number;
  burstRowCount: number;
  burstOffset: number;
  netNew: number;
  suppressed: number;
  recalledRowCount: number;
}): string | undefined {
  const {
    itemCount,
    burstRowCount,
    burstOffset,
    netNew,
    suppressed,
    recalledRowCount,
  } = options;
  if (itemCount > 0) return undefined;
  if (burstRowCount === 0 && burstOffset > 0) return "walk_complete";
  if (netNew > 0) return "content_unavailable";
  if (recalledRowCount > 0 && suppressed === recalledRowCount) {
    return "all_suppressed";
  }
  return "no_matches";
}

/**
 * Validate the request and resolve the namespace predicate, or return the
 * defined-empty fragment that answers it.
 */
function prepareRecall(
  request: DurableMemoryContextRequest,
  query: string,
  maxContentChars: number,
):
  | {
      accessibleTables: ResourceTable[];
      namespaceFilter: string | string[] | undefined;
    }
  | { fragment: DurableMemoryContextFragment } {
  // Recall requires a query. A defined empty section lets the caller tell
  // "requested but no query" apart from "not requested".
  if (query.length === 0) {
    return {
      fragment: emptyFragment({
        section: emptySection(null, "no_query"),
        maxContentChars,
      }),
    };
  }

  const accessibleTables: ResourceTable[] = ALL_TABLES.filter((table) =>
    canRead(request.auth.role, table),
  );
  if (accessibleTables.length === 0) {
    return {
      fragment: emptyFragment({
        section: emptySection(query, "no_readable_tables"),
        maxContentChars,
        extra: {
          scopeDenials: [
            { source: "durable_memory", reasons: ["no_readable_tables"] },
          ],
        },
      }),
    };
  }

  // The auth-derived namespace predicate is the isolation boundary. An explicit
  // namespace argument was already authorized by the caller before any query
  // ran; otherwise fall back to the caller's own readable namespaces.
  const namespaceFilter = request.args.namespace
    ? namespaceFilterFor(
        request.auth,
        request.namespace,
        {},
        request.dependencies.sharedNamespaceNames,
      )
    : namespaceFilterFor(
        request.auth,
        undefined,
        {},
        request.dependencies.sharedNamespaceNames,
      );

  return { accessibleTables, namespaceFilter };
}

export async function loadDurableMemoryContext(
  request: DurableMemoryContextRequest,
): Promise<DurableMemoryContextFragment> {
  const { args, contentCharLimit } = request;
  const maxContentChars = resolveContentChars(
    args,
    contentCharLimit,
    DURABLE_MEMORY_MAX_CONTENT_CHARS,
  );
  const query = args.query?.trim() ?? "";

  const prepared = prepareRecall(request, query, maxContentChars);
  if ("fragment" in prepared) return prepared.fragment;

  const recalled = await recallRows({
    request,
    query,
    accessibleTables: prepared.accessibleTables,
    namespaceFilter: prepared.namespaceFilter,
    maxContentChars,
  });
  if ("failure" in recalled) return recalled.failure;
  const rows = recalled.rows;

  // Prior-context suppression (#333) runs BEFORE the char allocation selects and
  // shapes bodies, so the surviving relevance order, item selection, citations,
  // and accounting all reconcile against net-new results only. Allocating first
  // would spend it on records about to be dropped.
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

  const window = burstWindow(netNewRows, args.continue_from?.offset);
  const burst = buildBurstItems(window.burstRows, maxContentChars);
  const truncation = memoryTruncationEntries({
    burst,
    burstRowCount: window.burstRows.length,
    netNew: suppression.suppression.net_new,
    maxContentChars,
  });

  const emptyReason = resolveEmptyReason({
    itemCount: burst.items.length,
    burstRowCount: window.burstRows.length,
    burstOffset: window.burstOffset,
    netNew: suppression.suppression.net_new,
    suppressed: suppression.suppression.suppressed,
    recalledRowCount: rows.length,
  });

  return {
    section: {
      label: "durable_memory",
      namespace_scoped: true,
      query,
      ...(emptyReason ? { empty_reason: emptyReason } : {}),
      items: burst.items,
      item_count: burst.items.length,
      truncated: truncation.length > 0,
      // How to ask for the next burst of this walk (#563). Present ONLY while
      // records remain undelivered, so a caller walks until it disappears and a
      // client that ignores it is never left believing a burst was the whole
      // answer. Its absence IS the completeness signal, which is why no
      // separate `complete` flag is emitted: one fact, one field, and no way
      // for the two to disagree. The burst size and the delivery position live
      // in `budget` (below) rather than being restated here — a tight
      // whole-pack allocation must spend its bytes on records, not on an
      // envelope describing itself.
      ...(window.moreAfterBurst
        ? {
            next: {
              offset: window.burstEnd,
              delivered_through: window.burstEnd,
            },
          }
        : {}),
      // Content-free suppression counters (#333): counts only, never an id, a
      // reference, or a body.
      prior_context_suppression: {
        recalled: suppression.suppression.recalled,
        suppressed: suppression.suppression.suppressed,
        net_new: suppression.suppression.net_new,
        emitted: burst.items.length,
      },
    },
    scopeDenials: [],
    truncation,
    degradedSources: [],
    budget: {
      content_char_limit: maxContentChars,
      content_chars_used: maxContentChars - burst.remainingChars,
      burst_items: DURABLE_MEMORY_BURST_ITEMS,
      burst_offset: window.burstOffset,
      recalled_net_new: netNewRows.length,
      max_item_chars: DURABLE_MEMORY_MAX_ITEM_CHARS,
    },
    citations: burst.citations,
    pointerCandidatePool: [...netNewRows],
  };
}

/**
 * Fail loudly in the log, stay content-free in the envelope. See
 * {@link logDurableFailure} for the two-line shape.
 *
 * The raw recall `query` is deliberately NOT logged. It is arbitrary caller
 * content — a private name, incident text, anything someone searched for — that
 * secret-pattern redaction cannot make safe, because it is not shaped like a
 * credential. `query_chars` keeps the one diagnostic that matters (an empty or
 * pathological query) without writing the body.
 */
function logRecallFailure(options: {
  logger: DurableFailureLogger;
  auth: AuthIdentity;
  args: AgentContextPackArgs;
  query: string;
  accessibleTables: readonly ResourceTable[];
  namespaceFilter: string | string[] | undefined;
  error: unknown;
}): void {
  const {
    logger,
    auth,
    args,
    query,
    accessibleTables,
    namespaceFilter,
    error,
  } = options;
  logDurableFailure({
    logger,
    event: "durable_memory_recall_failed",
    error,
    errorFields: {
      client_id: auth.clientId,
      ...errorIdentityFields(error),
    },
    detailFields: {
      client_id: auth.clientId,
      role: auth.role,
      agent: args.agent,
      platform: args.platform,
      session_key: args.session_key,
      repo: args.repo ?? null,
      query_chars: query.length,
      accessible_tables: accessibleTables,
      accessible_table_count: accessibleTables.length,
      namespace_filter: namespaceFilter,
      requested_max_tokens: args.budget?.max_tokens ?? null,
      pointer_overfetch: DURABLE_MEMORY_POINTER_OVERFETCH,
      ...errorIdentityFields(error),
      ...pgDiagnosticFields(error, ["code", "detail", "hint"]),
      stack: asError(error)?.stack ?? null,
    },
  });
}
