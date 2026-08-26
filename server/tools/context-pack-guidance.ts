/**
 * `profile_guidance` and `process_guidance` — standing rules about who the user
 * is and how work gets done.
 *
 * Design authority: `docs/agent-context-pack-contract.md` ("Response Shape").
 *
 * Selection is by EXPLICIT TYPED METADATA, never content-keyword matching:
 *   profile_guidance -> metadata.candidate_type = 'user_preference'
 *   process_guidance -> metadata.candidate_type = 'process_rule'
 * both with metadata.memory_lifecycle_action = 'promote'. A bare 'candidate'
 * carries no durable write, so an un-promoted candidate is NOT standing guidance
 * and is deliberately excluded — surfacing one would present a suggestion nobody
 * accepted as a rule the agent must follow.
 *
 * SUPERSESSION AND ITS KNOWN GAP. The lifecycle stream is append-only and
 * carries no server-enforced identity linking a later 'relegate'/'discard' to
 * the 'promote' it supersedes. This module therefore reconciles supersession
 * only through the explicit typed key at metadata.candidate_scope.key. A
 * promoted item carrying NO scope key cannot be proven current, so it is still
 * surfaced but FLAGGED (`supersession_verifiable: false`) rather than silently
 * trusted or quietly dropped. The missing write-side prerequisite — require a
 * stable scope key on every promotable item — is a known gap, recorded here
 * rather than papered over.
 */
import type { Logger } from "pino";
import {
  boundedItemText,
  databaseUnavailableFragment,
  resolveItemBudget,
  type SectionBudget,
  type SectionFragment,
  type SectionReaderDeps,
} from "./context-pack-sections.ts";

export const GUIDANCE_CANDIDATE_TYPE = {
  profile_guidance: "user_preference",
  process_guidance: "process_rule",
} as const;

export type GuidanceSectionName = keyof typeof GUIDANCE_CANDIDATE_TYPE;

/**
 * No ceilings. This section carries who the user is and how work gets done, and
 * it once cut them to 12 items of 600 characters each — numbers an agent wrote.
 * The effect was that a standing rule of 895 characters arrived severed on the
 * read side even after being fixed on the write side.
 *
 * The lifecycle scan is unbounded for a sharper reason: it must see EVERY
 * relegate/discard row to know which promotes are still standing. A scan that
 * stopped early could resurrect a rule the user had retired, which is worse than
 * any cost of reading the rows.
 */

/** Lifecycle actions that retire a previously promoted standing item. */
const SUPERSEDING_ACTIONS = new Set(["relegate", "discard"]);

type LifecycleRow = {
  id: string;
  content: string | null;
  action: string | null;
  candidateType: string | null;
  scopeKey: string | null;
  confidence: number | null;
  reason: string | null;
  createdAt: string | null;
};

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Extract the explicit typed scope key. Only a string
 * `metadata.candidate_scope.key` is trusted; anything else is treated as "no
 * stable key" — uncertainty, never a fabricated identity.
 */
function scopeKeyOf(row: Record<string, unknown>): string | null {
  const scope = row.candidate_scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  return asText((scope as Record<string, unknown>).key);
}

function normalizeRow(row: Record<string, unknown>): LifecycleRow {
  return {
    id: String(row.id ?? ""),
    content: asText(row.content),
    action: asText(row.memory_lifecycle_action),
    candidateType: asText(row.candidate_type),
    scopeKey: scopeKeyOf(row),
    confidence: asFiniteNumber(row.candidate_confidence),
    reason: asText(row.candidate_reason),
    createdAt: asText(row.created_at),
  };
}

/**
 * Current standing state per scope key, from the NEWEST relevant row.
 *
 * Rows arrive newest-first, so the FIRST decisive action seen for a key is the
 * standing one. This matters more than it looks: collecting every historical
 * relegate/discard (the obvious implementation) wrongly retires a key that a
 * NEWER promote reactivated. A key promoted, retired, then promoted again is
 * currently standing.
 *
 * Only rows carrying an explicit scope key participate; keyless actions cannot
 * be matched to a specific promotion and are handled as the keyless-uncertainty
 * case on the promote side instead.
 *
 * @returns scope keys whose newest decisive action is a retirement. A key absent
 *   from the set is either standing or has no keyed lifecycle row at all.
 */
function retiredScopeKeys(rows: LifecycleRow[]): Set<string> {
  const retired = new Set<string>();
  const decided = new Set<string>();
  for (const row of rows) {
    if (!row.scopeKey || !row.action) continue;
    if (decided.has(row.scopeKey)) continue;
    const isPromote = row.action === "promote";
    const isRetire = SUPERSEDING_ACTIONS.has(row.action);
    // A non-decisive action must not MASK the newest decisive action behind it.
    if (!isPromote && !isRetire) continue;
    decided.add(row.scopeKey);
    if (isRetire) retired.add(row.scopeKey);
  }
  return retired;
}

export type GuidanceReaderArgs = {
  section: GuidanceSectionName;
  /** Auth-resolved, already-authorized namespace this section reads. */
  namespace: string;
  budget?: SectionBudget;
};

/**
 * Bind by LANE namespace — the isolation boundary for session events. The
 * candidate_type discriminator is an explicit typed metadata field, not a
 * content match. promote/relegate/discard are all pulled so supersession is
 * reconciled deterministically in-process.
 */
const GUIDANCE_ROWS_SQL = `SELECT e.id,
              e.content,
              e.created_at,
              e.metadata->>'memory_lifecycle_action' AS memory_lifecycle_action,
              e.metadata->>'candidate_type' AS candidate_type,
              e.metadata->>'candidate_reason' AS candidate_reason,
              (e.metadata->>'candidate_confidence')::float8 AS candidate_confidence,
              e.metadata->'candidate_scope' AS candidate_scope
         FROM ob_session_events e
         JOIN ob_session_lanes l ON l.id = e.lane_id
        WHERE l.namespace = $1
          AND e.metadata->>'candidate_type' = $2
          AND e.metadata->>'memory_lifecycle_action' IN ('promote', 'relegate', 'discard')
        ORDER BY e.created_at DESC, e.id DESC`;

/**
 * Is this row a promote that is still standing for its own candidate type?
 *
 * Flattens what was nested selection logic: a row survives only if it is a
 * promote of the requested type whose explicit scope key has neither been
 * retired by a newer decisive action nor already been emitted. Keyless promotes
 * always survive here and are flagged downstream instead.
 */
function isStandingPromote(options: {
  row: LifecycleRow;
  candidateType: string;
  retired: Set<string>;
  seenScopeKeys: Set<string>;
}): boolean {
  const { row, candidateType, retired, seenScopeKeys } = options;
  if (row.action !== "promote") return false;
  if (row.candidateType !== candidateType) return false;
  if (!row.scopeKey) return true;
  // Supersession: an explicit key later relegated/discarded is gone.
  if (retired.has(row.scopeKey)) return false;
  // Deterministic dedupe: keep only the most-recent promote per key.
  if (seenScopeKeys.has(row.scopeKey)) return false;
  seenScopeKeys.add(row.scopeKey);
  return true;
}

type GuidanceSelection = {
  items: Array<Record<string, unknown>>;
  citations: Array<Record<string, unknown>>;
  itemsTruncated: boolean;
};

/**
 * Build the emitted items and their citations, in arrival order, applying
 * supersession and the resolved per-item text bound. Order and admission are
 * unchanged from the single-pass form this replaces.
 */
function selectGuidanceItems(options: {
  normalized: LifecycleRow[];
  candidateType: string;
  retired: Set<string>;
  maxItems: number;
  maxItemChars: number;
}): GuidanceSelection {
  const { normalized, candidateType, retired, maxItems, maxItemChars } =
    options;
  const citations: Array<Record<string, unknown>> = [];
  const items: Array<Record<string, unknown>> = [];
  const seenScopeKeys = new Set<string>();
  let itemsTruncated = false;

  for (const row of normalized) {
    if (!isStandingPromote({ row, candidateType, retired, seenScopeKeys })) {
      continue;
    }

    if (items.length >= maxItems) {
      itemsTruncated = true;
      break;
    }

    const bounded = boundedItemText(row.content, maxItemChars);
    if (!bounded.text) {
      // Non-empty content the budget cannot admit is recorded as an omission,
      // content-free, rather than emitted as an empty rule.
      if (row.content) itemsTruncated = true;
      continue;
    }
    if (bounded.truncated) itemsTruncated = true;

    const citationId = `session_event:${row.id}`;
    items.push({
      id: row.id,
      guidance: bounded.text,
      candidate_type: candidateType,
      confidence: row.confidence,
      reason: row.reason,
      scope_key: row.scopeKey,
      // Keyless promotes cannot be proven un-superseded: flag, never fabricate.
      supersession_verifiable: row.scopeKey !== null,
      promoted_at: row.createdAt,
      citation_id: citationId,
    });
    citations.push({
      id: citationId,
      kind: "session_event",
      source_ref: `ob_session_events/${row.id}`,
    });
  }

  return { items, citations, itemsTruncated };
}

/**
 * ERROR names what broke at the default level; DEBUG carries the inputs,
 * because a "database_unavailable" envelope on its own tells a later reader
 * nothing and by then the call that produced it is gone.
 */
type FailureShape = {
  error_name: string;
  error_message: string;
  pg_code: unknown;
  stack: string | null;
};

/** Content-free description of a thrown value, Error or not. */
function failureShape(error: unknown): FailureShape {
  const err = error instanceof Error ? error : undefined;
  return {
    error_name: err?.name ?? typeof error,
    error_message: err?.message ?? String(error),
    pg_code: (error as { code?: unknown })?.code ?? null,
    stack: err?.stack ?? null,
  };
}

function logGuidanceFailure(options: {
  args: GuidanceReaderArgs;
  candidateType: string;
  budget: Record<string, number>;
  error: unknown;
  logger?: Logger;
}): void {
  const { args, candidateType, budget, error, logger } = options;
  const shape = failureShape(error);
  logger?.error(
    {
      section: args.section,
      namespace: args.namespace,
      error_name: shape.error_name,
      error_message: shape.error_message,
    },
    "guidance_section_failed",
  );
  logger?.debug(
    {
      section: args.section,
      candidate_type: candidateType,
      namespace: args.namespace,
      requested_budget: args.budget,
      resolved_budget: budget,
      error_name: shape.error_name,
      error_message: shape.error_message,
      pg_code: shape.pg_code,
      stack: shape.stack,
    },
    "guidance_section_failed_detail",
  );
}

/**
 * Assemble one guidance fragment for an authorized namespace. Deterministic
 * order: promoted-most-recent first, then id. Empty state is an explicit empty
 * items array, never omitted and never fabricated.
 */
export async function loadGuidanceSection(
  args: GuidanceReaderArgs,
  deps: SectionReaderDeps,
  logger?: Logger,
): Promise<SectionFragment> {
  const candidateType = GUIDANCE_CANDIDATE_TYPE[args.section];
  const { maxItems, maxItemChars } = resolveItemBudget(args.budget, {
    maxItems: Number.MAX_SAFE_INTEGER,
    maxItemChars: Number.MAX_SAFE_INTEGER,
  });

  const budget = {
    max_items: maxItems,
    max_item_chars: maxItemChars,
    items_included: 0,
  };

  try {
    const { rows } = await deps.query(GUIDANCE_ROWS_SQL, [
      args.namespace,
      candidateType,
    ]);

    const normalized = rows.map(normalizeRow);
    const retired = retiredScopeKeys(normalized);
    const { items, citations, itemsTruncated } = selectGuidanceItems({
      normalized,
      candidateType,
      retired,
      maxItems,
      maxItemChars,
    });

    const truncation: Array<Record<string, unknown>> = [];
    if (itemsTruncated) {
      truncation.push({
        source: args.section,
        max_items: maxItems,
        max_item_chars: maxItemChars,
      });
    }

    const keylessCount = items.filter(
      (item) => item.supersession_verifiable === false,
    ).length;

    return {
      section: {
        label: args.section,
        candidate_type: candidateType,
        namespace_bound: true,
        items,
        item_count: items.length,
        // Content-free provenance the caller can surface as uncertainty.
        keyless_uncertain_count: keylessCount,
        truncated: truncation.length > 0,
      },
      scopeDenials: [],
      truncation,
      degradedSources: [],
      budget: { ...budget, items_included: items.length },
      citations,
    };
  } catch (error) {
    logGuidanceFailure({ args, candidateType, budget, error, logger });
    return databaseUnavailableFragment(args.section, budget);
  }
}
