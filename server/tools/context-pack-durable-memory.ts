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
import type { Logger } from "pino";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import { canRead } from "../auth/permissions.ts";
import type { AgentContextPackArgs } from "./context-pack-args.ts";
import { namespaceFilterFor } from "./read-scope.ts";
import { ALL_TABLES } from "./search-constants.ts";
import { executeSearch, type SearchRow } from "./search-engine.ts";
import type { MemoryToolDependencies } from "./types.ts";
import {
  CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
  boundedText,
} from "./context-pack-durable-lane.ts";
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

/**
 * Resolve the durable-memory content char budget.
 *
 * An explicit whole-pack allocation wins; then an explicit `max_tokens`; and
 * absent BOTH, recall means total recall. This mirrors the durable-lane resolver
 * instead of applying an undeclared 4,000-token default — that default silently
 * imposed a ~14,800-char ceiling on a pack whose own contract says an absent
 * budget returns everything, so a large recall was truncated exactly where the
 * contract promised it would not be.
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
  if (args.budget?.max_tokens !== undefined) {
    return Math.max(
      0,
      Math.min(
        DURABLE_MEMORY_MAX_CONTENT_CHARS,
        args.budget.max_tokens * 4 - CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
      ),
    );
  }
  return DURABLE_MEMORY_MAX_CONTENT_CHARS;
}

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
export async function loadDurableMemoryContext(
  args: AgentContextPackArgs,
  auth: AuthIdentity,
  namespace: string,
  dependencies: MemoryToolDependencies,
  contentCharLimit?: number,
): Promise<DurableMemoryContextFragment> {
  const maxContentChars = resolveDurableMemoryContentChars(
    args,
    contentCharLimit,
  );
  const query = args.query?.trim() ?? "";

  // Where in the ranked recall this reply's burst starts. A caller walking the
  // corpus replays the same request carrying the handle the previous reply
  // returned; absent one, the walk starts at the top of the ranking.
  const burstOffset = Math.max(0, Math.trunc(args.continue_from?.offset ?? 0));

  const emptyBudget = () => ({
    content_char_limit: maxContentChars,
    content_chars_used: 0,
    burst_items: DURABLE_MEMORY_BURST_ITEMS,
    max_item_chars: DURABLE_MEMORY_MAX_ITEM_CHARS,
  });

  const emptyFragment = (
    section: Record<string, unknown>,
    extra: Partial<DurableMemoryContextFragment> = {},
  ): DurableMemoryContextFragment => ({
    section,
    scopeDenials: [],
    truncation: [],
    degradedSources: [],
    budget: emptyBudget(),
    citations: [],
    pointerCandidatePool: [],
    ...extra,
  });

  // Recall requires a query. A defined empty section lets the caller tell
  // "requested but no query" apart from "not requested".
  if (query.length === 0) {
    return emptyFragment({
      label: "durable_memory",
      namespace_scoped: true,
      query: null,
      empty_reason: "no_query",
      items: [],
      item_count: 0,
      truncated: false,
    });
  }

  const accessibleTables: ResourceTable[] = ALL_TABLES.filter((table) =>
    canRead(auth.role, table),
  );
  if (accessibleTables.length === 0) {
    return emptyFragment(
      {
        label: "durable_memory",
        namespace_scoped: true,
        query,
        empty_reason: "no_readable_tables",
        items: [],
        item_count: 0,
        truncated: false,
      },
      {
        scopeDenials: [
          { source: "durable_memory", reasons: ["no_readable_tables"] },
        ],
      },
    );
  }

  // The auth-derived namespace predicate is the isolation boundary. An explicit
  // namespace argument was already authorized by the caller before any query
  // ran; otherwise fall back to the caller's own readable namespaces.
  const namespaceFilter = args.namespace
    ? namespaceFilterFor(auth, namespace)
    : namespaceFilterFor(auth);

  let rows: SearchRow[];
  try {
    rows = await executeSearch(
      dependencies,
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
  } catch (error) {
    // Recall was explicitly requested and failed. Return a truthful empty
    // envelope (not an omitted section) so the caller can tell "requested,
    // recall failed" apart from "not requested". The envelope and the warning
    // stay content-free — no dependency or error detail leaks into either.
    //
    // But the reason is NOT thrown away. This catch used to swallow the error
    // entirely, so a failed recall was indistinguishable from an empty one and
    // the only evidence left was `empty_reason: "recall_failed"` with nothing to
    // act on.
    logRecallFailure(
      dependencies.logger,
      auth,
      args,
      query,
      accessibleTables,
      namespaceFilter,
      error,
    );
    return emptyFragment(
      {
        label: "durable_memory",
        namespace_scoped: true,
        query,
        empty_reason: "recall_failed",
        items: [],
        item_count: 0,
        truncated: false,
      },
      {
        degradedSources: [
          { source: "durable_memory", reason: "recall_failed" },
        ],
      },
    );
  }

  // Prior-context suppression (#333) runs BEFORE the char budget selects and
  // bounds bodies, so the surviving relevance order, item selection, citations,
  // and budget accounting all reconcile against net-new results only. Budgeting
  // first would spend the allocation on records about to be dropped.
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
  const pointerCandidatePool: SearchRow[] = [...netNewRows];

  // The burst window: the slice of the ranked net-new recall THIS reply
  // delivers (#563). Rows before it were delivered by an earlier burst in the
  // walk; rows after it are delivered by a later one and stay pointer-eligible
  // meanwhile. Every row is in exactly one burst, so a full walk reconstructs
  // the complete recalled set — this re-shapes delivery, it does not discard.
  const burstRows = netNewRows.slice(
    burstOffset,
    burstOffset + DURABLE_MEMORY_BURST_ITEMS,
  );
  const burstEnd = burstOffset + burstRows.length;
  const moreAfterBurst = netNewRows.length > burstEnd;

  for (const row of burstRows) {
    const bounded = boundedText(
      row.content_preview,
      Math.min(DURABLE_MEMORY_MAX_ITEM_CHARS, remainingChars),
    );
    if (!bounded.text) {
      if (
        typeof row.content_preview === "string" &&
        row.content_preview.length > 0
      ) {
        // A non-empty body the char budget could not admit IS a genuine durable
        // truncation. The row keeps a valid identity and stays pointer-eligible.
        itemsTruncated = true;
      }
      continue;
    }
    const citationId = recordCitationId(row);
    // Build the bounded source_ref ONCE and attach the SAME object to both the
    // item and its citation, so an item is independently resolvable without a
    // citation lookup and the two can never drift through a partial trim.
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
    citations.push({ id: citationId, kind: "brain_record", source_ref: sourceRef });
    remainingChars -= bounded.text.length;
    if (bounded.truncated) itemsTruncated = true;
  }

  // When net-new records survived suppression but NONE produced an emittable
  // body, durable_memory reports zero items with a truncated empty state: the
  // diverted rows still resurface as pointers, but the durable section says
  // truthfully that it emitted no content for a net-new match.
  // Scoped to the burst window: a later burst that is legitimately empty
  // because the walk has run past the end of the recall must not be reported as
  // unemittable content.
  if (
    items.length === 0 &&
    burstRows.length > 0 &&
    suppression.suppression.net_new > 0
  ) {
    itemsTruncated = true;
  }

  const truncation: Array<Record<string, unknown>> = [];
  if (itemsTruncated) {
    truncation.push({
      source: "durable_memory.items",
      burst_items: DURABLE_MEMORY_BURST_ITEMS,
      max_item_chars: DURABLE_MEMORY_MAX_ITEM_CHARS,
      content_char_limit: maxContentChars,
    });
  }

  // Three genuine zero-item causes, distinguished in the only order that reads
  // correctly. `net_new` is checked FIRST so a net-new-but-unemittable section
  // can never be mislabeled `no_matches`:
  //   - content_unavailable: net-new records survived but none had an emittable
  //     body (null/empty preview, or the budget admitted none).
  //   - all_suppressed: recall returned rows and suppression removed every one.
  //   - no_matches: recall genuinely found nothing.
  // `walk_complete` is the fourth genuine zero-item cause, introduced with the
  // burst shape (#563): the caller walked past the end of the recall, so this
  // reply is empty for the one benign reason — everything was already
  // delivered. Checked FIRST because it is a property of the WALK, not of the
  // records; reporting it as no_matches would tell a caller who now holds the
  // whole corpus that nothing matched.
  const emptyReason =
    items.length === 0
      ? burstRows.length === 0 && burstOffset > 0
        ? "walk_complete"
        : suppression.suppression.net_new > 0
          ? "content_unavailable"
          : rows.length > 0 && suppression.suppression.suppressed === rows.length
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
      // How to ask for the next burst of this walk (#563). Present ONLY while
      // records remain undelivered, so a caller walks until it disappears and a
      // client that ignores it is never left believing a burst was the whole
      // answer. Its absence IS the completeness signal, which is why no
      // separate `complete` flag is emitted: one fact, one field, and no way
      // for the two to disagree. The burst size and the delivery position live
      // in `budget` (below) rather than being restated here — a tight
      // whole-pack budget must spend its bytes on records, not on an envelope
      // describing itself.
      ...(moreAfterBurst
        ? { next: { offset: burstEnd, delivered_through: burstEnd } }
        : {}),
      // Content-free suppression counters (#333): counts only, never an id, a
      // reference, or a body.
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
      burst_items: DURABLE_MEMORY_BURST_ITEMS,
      burst_offset: burstOffset,
      recalled_net_new: netNewRows.length,
      max_item_chars: DURABLE_MEMORY_MAX_ITEM_CHARS,
    },
    citations,
    pointerCandidatePool,
  };
}

/**
 * Fail loudly in the log, stay content-free in the envelope.
 *
 * The raw recall `query` is deliberately NOT logged. It is arbitrary caller
 * content — a private name, incident text, anything someone searched for — that
 * secret-pattern redaction cannot make safe, because it is not shaped like a
 * credential. `query_chars` keeps the one diagnostic that matters (an empty or
 * pathological query) without writing the body.
 */
function logRecallFailure(
  logger: Logger,
  auth: AuthIdentity,
  args: AgentContextPackArgs,
  query: string,
  accessibleTables: readonly ResourceTable[],
  namespaceFilter: string | string[] | undefined,
  error: unknown,
): void {
  const err = error instanceof Error ? error : undefined;
  logger.error(
    {
      client_id: auth.clientId,
      error_name: err?.name ?? typeof error,
      error_message: err?.message ?? String(error),
    },
    "durable_memory_recall_failed",
  );
  logger.debug(
    {
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
      error_name: err?.name ?? typeof error,
      error_message: err?.message ?? String(error),
      pg_code: (error as { code?: unknown })?.code ?? null,
      pg_detail: (error as { detail?: unknown })?.detail ?? null,
      pg_hint: (error as { hint?: unknown })?.hint ?? null,
      stack: err?.stack ?? null,
    },
    "durable_memory_recall_failed_detail",
  );
}
