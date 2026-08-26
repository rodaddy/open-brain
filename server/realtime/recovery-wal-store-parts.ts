/**
 * Pure state operations over recovery WAL sessions.
 *
 * These are the parts of the store that only read or rearrange the in-memory
 * session map. They are functions rather than methods because they need no
 * store identity, and pulling them out is what keeps `RecoveryWalStore` a
 * coordinator instead of a container for every loop the module has.
 *
 * Nothing here writes the journal; the store owns that, so the ordering of
 * "mutate, then journal" stays visible in one place.
 */
import type { Logger } from "pino";
import {
  workingSetScopeKey,
  type NormalizedWorkingSetScope,
} from "./working-set.ts";
import type {
  RecoveryWalBudget,
  RecoveryWalContextItem,
  RecoveryWalItem,
  RecoveryWalStatus,
} from "./recovery-wal-types.ts";

export interface RecoveryWalSession {
  scope: NormalizedWorkingSetScope;
  items: RecoveryWalItem[];
  updated_at_ms: number;
}

export type RecoveryWalSessions = Map<string, RecoveryWalSession>;

/** Only these two statuses are "still awaiting review" and therefore emitted. */
const PENDING_STATUSES = new Set<RecoveryWalStatus>([
  "active",
  "recovery_pending",
]);

export function isPendingAt(item: RecoveryWalItem, nowMs: number): boolean {
  return (
    PENDING_STATUSES.has(item.status) && Date.parse(item.expires_at) > nowMs
  );
}

export function oldestSession(
  sessions: RecoveryWalSessions,
): RecoveryWalSession | null {
  let oldest: RecoveryWalSession | null = null;
  for (const session of sessions.values()) {
    if (!oldest || session.updated_at_ms < oldest.updated_at_ms) {
      oldest = session;
    }
  }
  return oldest;
}

export function globalItemCount(sessions: RecoveryWalSessions): number {
  let count = 0;
  for (const session of sessions.values()) count += session.items.length;
  return count;
}

/** Drop a session once its last item is gone, so empty keys never accumulate. */
export function deleteIfEmpty(
  sessions: RecoveryWalSessions,
  session: RecoveryWalSession,
): void {
  if (session.items.length === 0) {
    sessions.delete(workingSetScopeKey(session.scope));
  }
}

export function contextItemFor(
  item: RecoveryWalItem,
  budget: RecoveryWalBudget,
): RecoveryWalContextItem {
  const preview =
    item.content.length > budget.max_preview_chars
      ? item.content.slice(0, budget.max_preview_chars)
      : item.content;
  return {
    id: item.id,
    label: item.label,
    status: item.status,
    content_preview: preview,
    content_length: item.content.length,
    content_truncated: item.content.length > preview.length,
    trace_id: item.trace_id,
    source_ref: item.source_ref,
    created_at: item.created_at,
    updated_at: item.updated_at,
    expires_at: item.expires_at,
    reviewed_at: item.reviewed_at,
    last_action: item.last_action,
    metadata: item.metadata,
  };
}

/**
 * Apply the live size budgets to a replayed state that predates them, and
 * report how many items that cost. The journal is NOT written here: replay
 * rewrites it wholesale by compaction afterwards, so a per-item purge row
 * would only be journalling a file that is about to be replaced.
 */
export function enforceReplayBudgets(
  sessions: RecoveryWalSessions,
  budget: RecoveryWalBudget,
): number {
  let trimmed = 0;
  for (const [key, session] of sessions.entries()) {
    const overflow = session.items.length - budget.max_items_per_session;
    if (overflow > 0) {
      session.items.splice(0, overflow);
      trimmed += overflow;
    }
    if (session.items.length === 0) sessions.delete(key);
  }
  while (globalItemCount(sessions) > budget.max_global_items) {
    const oldest = oldestSession(sessions);
    if (!oldest) return trimmed;
    if (oldest.items.shift()) trimmed += 1;
    deleteIfEmpty(sessions, oldest);
  }
  while (sessions.size > budget.max_sessions) {
    const oldest = oldestSession(sessions);
    if (!oldest) return trimmed;
    trimmed += oldest.items.length;
    sessions.delete(workingSetScopeKey(oldest.scope));
  }
  return trimmed;
}

/** See the identical note in working-set.ts: null means "unserializable", not "big". */
export function serializedJsonLength(
  value: unknown,
  logger: Logger | undefined,
): number | null {
  try {
    return JSON.stringify(value).length;
  } catch (error) {
    logger?.warn(
      {
        value_type: typeof value,
        error_name: error instanceof Error ? error.name : typeof error,
      },
      "recovery_wal_metadata_unserializable",
    );
    return null;
  }
}
