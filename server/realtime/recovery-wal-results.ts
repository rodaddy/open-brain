/**
 * The shapes the recovery WAL store returns.
 *
 * They sit apart from the store because they are the module's public contract
 * — locked by `get-contract.test.ts` and by the context-pack fixtures — and a
 * contract is easier to keep still when it is not interleaved with the
 * implementation that happens to produce it.
 */
import type {
  NormalizedWorkingSetScope,
  WorkingSetScopeDenial,
} from "./working-set.ts";
import type {
  RECOVERY_WAL_LABEL,
  RECOVERY_WAL_SCHEMA,
  RecoveryWalBudget,
  RecoveryWalContextItem,
  RecoveryWalCounters,
  RecoveryWalItem,
} from "./recovery-wal-types.ts";

export interface RecoveryWalAppendResult {
  accepted: boolean;
  reason?:
    | "content_too_large"
    | "empty_content"
    | "invalid_status"
    | "metadata_too_large";
  item?: RecoveryWalItem;
  counters: RecoveryWalCounters;
}

export interface RecoveryWalMarkResult {
  accepted: boolean;
  reason?: "invalid_action" | "invalid_status" | "not_found";
  item?: RecoveryWalItem;
  purged?: boolean;
  counters: RecoveryWalCounters;
}

export interface RecoveryWalContextSection {
  schema: typeof RECOVERY_WAL_SCHEMA;
  label: typeof RECOVERY_WAL_LABEL;
  exact_scope_required: true;
  not_durable_memory: true;
  not_searchable_recall: true;
  unreviewed_quarantine: true;
  scope: NormalizedWorkingSetScope;
  pending_count: number;
  items: RecoveryWalContextItem[];
  item_count: number;
  budget: RecoveryWalBudget;
  counters: RecoveryWalCounters;
  wal_path_configured: boolean;
}

export interface RecoveryWalContextPackFragment {
  recovery: RecoveryWalContextSection;
  warnings: {
    scope_denials: WorkingSetScopeDenial[];
  };
  budget: {
    recovery: RecoveryWalBudget;
  };
}
