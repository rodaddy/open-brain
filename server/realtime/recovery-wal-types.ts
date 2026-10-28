/**
 * The recovery WAL vocabulary: statuses, actions, the record shapes, and the
 * budget defaults.
 *
 * These are split from the store so the structural validators
 * (`recovery-wal-records.ts`) can name the same shapes without importing the
 * store, and so the journal's on-disk vocabulary has exactly one definition.
 */
import type { NormalizedWorkingSetScope } from "./working-set.ts";

export const RECOVERY_WAL_LABEL = "quarantined_recovery" as const;
export const RECOVERY_WAL_SCHEMA = "openbrain.recovery_wal.v1" as const;

export const RECOVERY_WAL_STATUSES = [
  "active",
  "wrapped",
  "recovery_pending",
  "reviewed",
  "compacted",
  "discarded",
  "expired",
] as const;

export type RecoveryWalStatus = (typeof RECOVERY_WAL_STATUSES)[number];

export const RECOVERY_WAL_ACTIONS = [
  "review",
  "use_for_current_session",
  "compact_to_wrap",
  "promote_candidates",
  "discard",
  "defer",
] as const;

export type RecoveryWalAction = (typeof RECOVERY_WAL_ACTIONS)[number];

export interface RecoveryWalBudget {
  ttl_ms: number;
  max_sessions: number;
  max_items_per_session: number;
  max_global_items: number;
  max_content_chars: number;
  max_metadata_chars: number;
  max_preview_chars: number;
}

export interface RecoveryWalCounters {
  dropped: number;
  expired: number;
  trimmed: number;
  marked: number;
  purged: number;
}

export interface RecoveryWalItemInput {
  id?: string;
  content: string;
  status?: RecoveryWalStatus;
  trace_id?: string | null;
  source_ref?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RecoveryWalItem {
  id: string;
  label: typeof RECOVERY_WAL_LABEL;
  status: RecoveryWalStatus;
  content: string;
  trace_id: string | null;
  source_ref: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  expires_at: string;
  reviewed_at: string | null;
  last_action: RecoveryWalAction | null;
}

export type RecoveryWalRecord =
  | { op: "append"; scope: NormalizedWorkingSetScope; item: RecoveryWalItem }
  | {
      op: "mark";
      scope: NormalizedWorkingSetScope;
      id: string;
      action: RecoveryWalAction;
      status: RecoveryWalStatus;
      reviewed_at: string | null;
      updated_at: string;
    }
  | { op: "purge"; scope: NormalizedWorkingSetScope; id?: string };

export const DEFAULT_RECOVERY_WAL_BUDGET: RecoveryWalBudget = {
  ttl_ms: 24 * 60 * 60 * 1000,
  max_sessions: 128,
  max_items_per_session: 50,
  max_global_items: 2048,
  max_content_chars: 8000,
  max_metadata_chars: 2000,
  max_preview_chars: 1000,
};

/**
 * The read shape. Note it carries a bounded `content_preview`, never the full
 * body: the context pack surfaces enough to decide whether the record is worth
 * reviewing, and review is where the whole body belongs.
 */
export interface RecoveryWalContextItem {
  id: string;
  label: typeof RECOVERY_WAL_LABEL;
  status: RecoveryWalStatus;
  content_preview: string;
  content_length: number;
  content_truncated: boolean;
  trace_id: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  reviewed_at: RecoveryWalItem["reviewed_at"];
  last_action: RecoveryWalAction | null;
  metadata: Record<string, unknown>;
}
