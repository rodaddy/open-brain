// Standalone profile_guidance and process_guidance section builders.
//
// Discriminator (explicit typed metadata only — never content-keyword vibes):
//   profile_guidance -> ob_session_events.metadata.candidate_type = 'user_preference'
//   process_guidance -> ob_session_events.metadata.candidate_type = 'process_rule'
// with metadata.memory_lifecycle_action = 'promote'. Per the public contract,
// a bare 'candidate' carries candidate_presence_effect =
// "no_durable_write_no_shared_write", so an un-promoted candidate is NOT durable
// standing guidance and is deliberately excluded here.
//
// Supersession / write-side prerequisite gap:
// The lifecycle stream is append-only and carries no server-enforced stable
// identity linking a later 'relegate'/'discard' to the 'promote' it supersedes.
// This module therefore reconciles supersession ONLY through an explicit typed
// key at metadata.candidate_scope.key. Standing state per key is the NEWEST
// relevant action for that key (rows arrive newest-first): a promote is current
// unless a NEWER relegate/discard on the same key retired it, and a key that was
// retired and later promoted again is standing once more. A promoted item that
// carries NO scope key cannot be proven current, so it is still surfaced but
// flagged with an uncertainty marker rather than silently trusted or fabricated
// as canonical.
// The missing write-side prerequisite (require a stable candidate_scope.key on
// every promotable user_preference/process_rule so the current standing set is
// deterministically derivable) is reported alongside the change.

import {
  boundedItemText,
  databaseUnavailableFragment,
  resolveItemBudget,
  type SectionBudget,
  type SectionFragment,
  type SectionReaderDeps,
} from "./agent-context-pack-sections.ts";

export const GUIDANCE_CANDIDATE_TYPE = {
  profile_guidance: "user_preference",
  process_guidance: "process_rule",
} as const;

export type GuidanceSectionName = keyof typeof GUIDANCE_CANDIDATE_TYPE;

const DEFAULT_MAX_ITEMS = 12;
const DEFAULT_MAX_ITEM_CHARS = 600;

/**
 * Hard safety cap on lifecycle rows scanned for supersession reconciliation.
 * The query cannot LIMIT to maxItems because it must also see relegate/discard
 * rows, but it must stay bounded. Newest-first ordering means the freshest
 * lifecycle events (the ones that decide the current standing set) are the ones
 * kept; older overflow is reported as truncation rather than silently dropped.
 */
const LIFECYCLE_SCAN_CAP = 500;

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
 * Extract the explicit typed scope key used for supersession reconciliation.
 * Only a string metadata.candidate_scope.key is trusted; anything else is
 * treated as "no stable key" (uncertainty, not fabrication).
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
 * Determine the current standing action per stable scope key from the NEWEST
 * relevant lifecycle row for that key.
 *
 * The lifecycle stream is append-only and rows arrive newest-first. Standing
 * state is therefore the newest action per key, NOT the union of every
 * historical action: a key that was relegated/discarded and then promoted again
 * is currently STANDING, and a key promoted then later relegated is currently
 * RETIRED. Collecting every historical relegate/discard (the prior behavior)
 * wrongly retired a key that a newer promote had reactivated.
 *
 * Only rows carrying an explicit scope key participate; keyless actions cannot
 * be matched to a specific promotion and are handled as the keyless-uncertainty
 * case on the promote side, never as supersession here.
 *
 * @param rows lifecycle rows already ordered newest-first
 * @returns scope keys whose newest promote/relegate/discard action is a
 *   retirement (relegate/discard); a key absent from the set is either standing
 *   (newest action is a promote) or has no keyed lifecycle row.
 */
function retiredScopeKeys(rows: LifecycleRow[]): Set<string> {
  const retired = new Set<string>();
  const decided = new Set<string>();
  for (const row of rows) {
    if (!row.scopeKey || !row.action) continue;
    // Newest-first: the first action seen for a key is the standing one.
    if (decided.has(row.scopeKey)) continue;
    // Only promote/retire actions decide standing; ignore any other action for
    // the key without letting it mask the newest decisive action behind it.
    const isPromote = row.action === "promote";
    const isRetire = SUPERSEDING_ACTIONS.has(row.action);
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
  /** Optional bounds; module defaults apply when absent. */
  budget?: SectionBudget;
};

/**
 * Assemble a profile_guidance or process_guidance fragment for one authorized
 * namespace. Deterministic order: promoted-most-recent first, then id, so the
 * output is stable for identical inputs. Empty state is an explicit empty items
 * array, never omitted or fabricated.
 */
export async function loadGuidanceSection(
  args: GuidanceReaderArgs,
  deps: SectionReaderDeps,
): Promise<SectionFragment> {
  const candidateType = GUIDANCE_CANDIDATE_TYPE[args.section];
  const { maxItems, maxItemChars } = resolveItemBudget(args.budget, {
    maxItems: DEFAULT_MAX_ITEMS,
    maxItemChars: DEFAULT_MAX_ITEM_CHARS,
  });

  const budget = {
    max_items: maxItems,
    max_item_chars: maxItemChars,
    items_included: 0,
  };

  try {
    // Bind by lane namespace (the isolation boundary for session events).
    // The candidate_type discriminator is an explicit typed metadata field, not
    // a content match. We pull promote/relegate/discard for this candidate_type
    // so supersession can be reconciled in-process deterministically.
    const { rows } = await deps.query(
      `SELECT e.id,
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
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $3`,
      [args.namespace, candidateType, LIFECYCLE_SCAN_CAP + 1],
    );

    const lifecycleOverflow = rows.length > LIFECYCLE_SCAN_CAP;
    const normalized = rows.slice(0, LIFECYCLE_SCAN_CAP).map(normalizeRow);
    const retired = retiredScopeKeys(normalized);

    const truncation: Array<Record<string, unknown>> = [];
    const citations: Array<Record<string, unknown>> = [];
    const items: Array<Record<string, unknown>> = [];
    const seenScopeKeys = new Set<string>();
    let itemsTruncated = false;

    for (const row of normalized) {
      if (row.action !== "promote") continue;
      if (row.candidateType !== candidateType) continue;
      // Supersession: an explicit scope key later relegated/discarded is gone.
      if (row.scopeKey && retired.has(row.scopeKey)) continue;
      // Deterministic dedupe: keep only the most-recent promote per scope key.
      if (row.scopeKey) {
        if (seenScopeKeys.has(row.scopeKey)) continue;
        seenScopeKeys.add(row.scopeKey);
      }

      if (items.length >= maxItems) {
        itemsTruncated = true;
        break;
      }

      const bounded = boundedItemText(row.content, maxItemChars);
      if (!bounded.text) {
        // Non-empty content that the char budget cannot admit is an omission,
        // recorded content-free rather than emitted empty.
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
        // Keyless promotes cannot be proven un-superseded; flag, do not fabricate.
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

    if (itemsTruncated || lifecycleOverflow) {
      truncation.push({
        source: args.section,
        max_items: maxItems,
        max_item_chars: maxItemChars,
        ...(lifecycleOverflow
          ? { lifecycle_scan_capped: LIFECYCLE_SCAN_CAP }
          : {}),
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
  } catch {
    return databaseUnavailableFragment(args.section, budget);
  }
}
