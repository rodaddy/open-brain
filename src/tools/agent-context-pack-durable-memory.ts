import type { ToolDeps } from "./index.ts";
import type { AuthInfo, Table } from "../types.ts";
import type { AgentContextPackArgs } from "./agent-context-pack.ts";
import { canRead } from "../permissions.ts";
import { namespaceFilterFor } from "../read-policy.ts";
import { ALL_TABLES } from "./table-constants.ts";
import { executeSearch, type SearchRow } from "./search-brain.ts";
import { logger } from "../logger.ts";
import { describeError } from "../observability/index.ts";
import {
  CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
  boundedText,
} from "./agent-context-pack-durable-lane.ts";
import {
  suppressReferencedRecords,
  type PriorContextReference,
} from "../prior-context-suppression.ts";

// Unbounded content by default. These were 8,000 content chars / 1,000 chars
// per item -- numbers an agent wrote, never asked for. A caller that explicitly
// passes budget.max_tokens still gets a pack sized to that request; absent
// that, a record that IS delivered is delivered whole.
const DURABLE_MEMORY_MAX_CONTENT_CHARS = Number.MAX_SAFE_INTEGER;
const DURABLE_MEMORY_MAX_ITEM_CHARS = Number.MAX_SAFE_INTEGER;

/**
 * How many recalled records one reply carries -- the BURST SIZE (#563, operator
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
 * named. Serializing the whole corpus into one reply -- 60.4 MiB measured
 * 2026-08-05, which no broker will carry -- is the shape this makes
 * unproducible: "I don't see any reason why this whole thing would ship in a
 * single shot to anywhere. It defeats the whole purpose of this."
 */
export const DURABLE_MEMORY_BURST_ITEMS = 10;

/**
 * Extra recall rows fetched beyond the burst window so the `pointers` section
 * (#329) has a net-new, already-authorized pool to draw from WITHOUT a second
 * retrieval stack. The single `executeSearch` call below over-fetches by this
 * much; the burst window's rows become durable_memory items (with bodies) and
 * the rest are handed to the pointer builder as lightweight references only (no
 * body copied, no second query issued).
 *
 * The emitted durable_memory count is unchanged by this over-fetch: one reply
 * carries {@link DURABLE_MEMORY_BURST_ITEMS} regardless of how large the pool
 * is. What CAN legitimately shift is the fused ranking itself — hybrid RRF ranks
 * over the whole fetched pool, so a larger pool can reorder which rows land in
 * a given burst. That identity/order shift is a property of fetching a deeper
 * pool, not a change to the count; tests assert the count and the
 * pointer/dedupe contract, not a frozen burst identity.
 */
const DURABLE_MEMORY_POINTER_OVERFETCH = 20;

/**
 * Resolve the durable-memory content char budget.
 *
 * When the whole-pack allocator supplies an explicit `contentCharLimit`, the
 * recall content is bounded by the pack-level allocation it was granted (still
 * clamped by the durable-memory hard cap). When a caller explicitly passes
 * `budget.max_tokens`, that request is honoured with the historical per-section
 * derivation. Absent BOTH, recall means total recall: this mirrors the
 * durable-lane resolver (`resolveDurableLaneContentChars`) instead of applying
 * an undeclared `4000`-token default. That default silently imposed a ~14,800
 * char ceiling on a pack whose own contract (see the constants above) says an
 * absent budget returns everything, so a large durable recall was truncated
 * exactly where the header promised it would not be.
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
  // A caller that asked for a token budget gets one derived from it.
  if (args.budget?.max_tokens !== undefined) {
    return Math.max(
      0,
      Math.min(
        DURABLE_MEMORY_MAX_CONTENT_CHARS,
        args.budget.max_tokens * 4 - CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
      ),
    );
  }
  // Nobody asked for a bound. Return everything (the hard cap IS everything).
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
   * the pointer/candidate builders' already-authorized, already-suppressed pool;
   * it is passed by reference so no second retrieval stack runs.
   *
   * It deliberately includes rows the durable_memory section DID emit as items,
   * not only the surplus beyond the item cap. Pointer eligibility is decided in
   * the pack against the durable identities ACTUALLY retained in the final fitted
   * durable_memory output — so a pointers-only request (section suppressed) makes
   * every authorized row pointer-eligible, and a whole-pack-trimmed or
   * starved-out durable row stays pointer-eligible instead of being silently
   * lost. Never emitted directly; the pointer builder derives lightweight
   * references from it and copies no body. Empty on every empty/degraded/denied
   * path.
   */
  pointerCandidatePool: SearchRow[];
};

/**
 * The stable citation id emitted for a recalled brain record. Kept in one place
 * so prior-context suppression keys off the EXACT string that becomes the item's
 * `citation_id`, and the emitted item derives its id from the same call. The
 * pointer/candidate builders (#329) reuse this so a pointer's identity is byte-
 * identical to the durable item it dedupes against.
 */
export function recordCitationId(row: SearchRow): string {
  return `brain_record:${row.source_type}:${row.id}`;
}

/**
 * The bounded structural source_ref emitted for a recalled brain record: the
 * store's own source_ref when present, else a derived `brain_record` pointer.
 * Its identity coordinates (source/type/id/namespace) are what suppression
 * canonicalizes on; `label`/`preview` are display-only and never affect matching.
 *
 * NOTE: this shape MAY carry `label`/`preview` (bounded content) for the durable
 * item and its citation. The `pointers` section MUST NOT emit those display
 * fields — it uses {@link recordStructuralSourceRef} instead, which is the same
 * identity object stripped of any body-bearing display field.
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
 * The identity-only structural source_ref for a recalled brain record: the SAME
 * identity coordinates suppression canonicalizes on (source/type/id/namespace),
 * with every display/body field (`label`, `preview`, or any other) stripped.
 * This is what `pointers` emit — a resolvable structural ref with NO body,
 * content_preview, or full text — while remaining byte-comparable on identity to
 * the durable item's source_ref. Derived from {@link recordSourceRef} so a
 * store-supplied source_ref and a derived one are handled identically.
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
      pointerCandidatePool: [],
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
      pointerCandidatePool: [],
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
      // Everything the query matches. Retrieval is UNCHANGED by #563: the
      // burst shape governs how many records one REPLY carries, never how many
      // the query is allowed to find. The pointers section (#329) draws its
      // net-new references from this SAME already-authorized pool, so no second
      // retrieval stack is needed and no over-fetch arithmetic is required.
      // Guard the addition: MAX_SAFE_INTEGER + 20 is no longer an exact integer
      // and Postgres rejects it, so an unbounded ask is passed through as-is.
      Number.isSafeInteger(
        Number.MAX_SAFE_INTEGER + DURABLE_MEMORY_POINTER_OVERFETCH,
      )
        ? Number.MAX_SAFE_INTEGER + DURABLE_MEMORY_POINTER_OVERFETCH
        : Number.MAX_SAFE_INTEGER,
      "hybrid",
      undefined,
      0,
      namespaceFilter,
      false,
    );
  } catch (error) {
    // Recall was explicitly requested for this section but the search failed.
    // Return a truthful empty durable_memory envelope (not an omitted section) so
    // the caller can tell "requested, recall failed" apart from "not requested".
    // The degraded_sources warning stays content-free — no dependency/error
    // detail is leaked into the envelope or the warning.
    //
    // But the reason is NOT thrown away. This catch used to swallow the error
    // entirely, so a failed recall was indistinguishable from an empty one and
    // the only evidence left was `empty_reason: "recall_failed"` with nothing
    // to act on. Fail loudly in the log, stay content-free in the envelope.
    //
    // Two lines on purpose. ERROR says what broke, briefly, so it is visible at
    // the default level. DEBUG carries the whole autopsy -- every input that
    // shaped this call, the full stack, the driver's own error fields -- because
    // when this is being read months from now the alternative is reconstructing
    // it from nothing. Sifting a large log is future-Rico's problem; having no
    // log at all is future-Rico's disaster.
    // Error fields go through describeError, the content-safe boundary: it
    // allowlists pg's code/detail/hint/constraint/routine by name and redacts
    // every value, so the diagnostics survive without a raw driver string
    // leaking query fragments into the log.
    logger.error("durable_memory recall failed", {
      client_id: auth.clientId,
      ...describeError(error),
    });
    // The raw recall `query` is NOT logged. It is arbitrary caller content -- a
    // private name, incident text, anything the caller searched for -- that
    // secret-pattern redaction cannot make safe because it is not shaped like a
    // credential. query_chars keeps the one diagnostic that matters (an empty or
    // pathological query) without writing the body.
    logger.debug("durable_memory recall failure detail", {
      client_id: auth.clientId,
      agent_id: auth.agentId ?? null,
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
      burst_items: DURABLE_MEMORY_BURST_ITEMS,
      burst_offset: burstOffset,
      max_item_chars: DURABLE_MEMORY_MAX_ITEM_CHARS,
      pointer_overfetch: DURABLE_MEMORY_POINTER_OVERFETCH,
      ...describeError(error),
    });
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
      pointerCandidatePool: [],
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
  // Every net-new authorized row, in rank order, handed to the pointer/candidate
  // builders. It includes rows this section emitted as items — pointer
  // eligibility is decided in the pack against the durable identities actually
  // retained in the FINAL fitted durable_memory output, so a suppressed or
  // whole-pack-trimmed durable row stays pointer-eligible instead of being lost.
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
        // Non-empty body the char budget could not admit: a genuine durable
        // truncation, exactly as before the over-fetch change. The row still has
        // a valid resolvable identity and stays in the pool as a pointer.
        itemsTruncated = true;
      }
      continue;
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
  // A net-new record delivered by a DIFFERENT burst of the walk is NOT a
  // durable truncation: it is fully delivered, just not in this reply, and it
  // is surfaced as a pointer meanwhile. Only a body the char budget could not
  // admit flips itemsTruncated, which the loop already does above; do not
  // additionally flip it here for rows outside this burst window.
  //
  // content_unavailable preservation: when net-new records survived suppression
  // but NONE produced an emittable durable body (all previews null/empty, or the
  // char budget admitted none), durable_memory reports zero items with a
  // truncated empty state, exactly as before. The rows still resurface as
  // pointers, but the durable section truthfully states it emitted no content
  // for a net-new match. Scoped to the burst window: a later burst that is
  // legitimately empty because the walk has run past the end of the recall must
  // not be reported as unemittable content.
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

  // Truthful empty state: when nothing survives, distinguish the three genuine
  // zero-item causes, in the only order that reads correctly:
  //   - `content_unavailable`: net-new records DID survive suppression but none
  //     produced an emittable body (null/empty content_preview, or the char
  //     budget was too small for even the first body). This is NOT "no_matches"
  //     (there was a net-new match) and NOT "all_suppressed" (nothing was
  //     suppressed away). It is a content-free empty: net-new existed but was
  //     unemittable, and `truncated` is already true for it above.
  //   - `all_suppressed`: recall DID return rows and suppression removed every
  //     one, so there is no net-new content at all.
  //   - `no_matches`: recall genuinely found nothing to begin with.
  // net_new is checked first so a net-new-but-unemittable section can never be
  // mislabeled no_matches; all_suppressed keeps its exact prior meaning (rows
  // recalled, none net-new because all were suppressed).
  // `walk_complete` is the fourth genuine zero-item cause, introduced with the
  // burst shape (#563): the caller walked past the end of the recall, so this
  // reply is empty for the one benign reason — everything was already
  // delivered. It is checked FIRST because it is a property of the WALK, not of
  // the records, and reporting it as no_matches would tell a caller who now
  // holds the whole corpus that nothing matched.
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
      burst_items: DURABLE_MEMORY_BURST_ITEMS,
      burst_offset: burstOffset,
      recalled_net_new: netNewRows.length,
      max_item_chars: DURABLE_MEMORY_MAX_ITEM_CHARS,
    },
    citations,
    pointerCandidatePool,
  };
}
