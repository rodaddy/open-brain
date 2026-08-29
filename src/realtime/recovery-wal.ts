// L5 adapter (issue 864): legacy call form over server/realtime/recovery-wal.ts; retired with src/ at L6.

import {
  RecoveryWalStore as ServerRecoveryWalStore,
  type RecoveryWalAction,
  type RecoveryWalAppendResult,
  type RecoveryWalBudget,
  type RecoveryWalContextPackFragment,
  type RecoveryWalCounters,
  type RecoveryWalItemInput,
  type RecoveryWalMarkResult,
  type RecoveryWalStatus,
  type RecoveryWalStoreOptions,
} from "../../server/realtime/recovery-wal.ts";
import type { WorkingSetScope } from "../../server/realtime/working-set.ts";

export {
  DEFAULT_RECOVERY_WAL_BUDGET,
  RECOVERY_WAL_ACTIONS,
  RECOVERY_WAL_LABEL,
  RECOVERY_WAL_SCHEMA,
  RECOVERY_WAL_STATUSES,
} from "../../server/realtime/recovery-wal.ts";

export type {
  RecoveryWalAction,
  RecoveryWalAppendResult,
  RecoveryWalBudget,
  RecoveryWalContextItem,
  RecoveryWalContextPackFragment,
  RecoveryWalContextSection,
  RecoveryWalCounters,
  RecoveryWalItem,
  RecoveryWalItemInput,
  RecoveryWalMarkResult,
  RecoveryWalStatus,
  RecoveryWalStoreOptions,
} from "../../server/realtime/recovery-wal.ts";

/** The legacy trailing `mark` arguments, kept as a tuple so the adapter
 * preserves the five-positional call form its src/ callers still use. */
type LegacyMarkArgs = [
  action: RecoveryWalAction,
  status: RecoveryWalStatus,
  options?: { purge?: boolean; now?: Date },
];

/** Legacy positional `mark` over the server decision-object form. */
export class RecoveryWalStore {
  private readonly inner: ServerRecoveryWalStore;

  constructor(options: RecoveryWalStoreOptions = {}) {
    this.inner = new ServerRecoveryWalStore(options);
  }

  get budget(): RecoveryWalBudget {
    return this.inner.budget;
  }

  get walPath(): string | null {
    return this.inner.walPath;
  }

  append(
    scope: WorkingSetScope,
    input: RecoveryWalItemInput,
    now: Date = new Date(),
  ): RecoveryWalAppendResult {
    return this.inner.append(scope, input, now);
  }

  mark(
    scope: WorkingSetScope,
    id: string,
    ...decision: LegacyMarkArgs
  ): RecoveryWalMarkResult {
    const [action, status, options = {}] = decision;
    return this.inner.mark(scope, id, { action, status, ...options });
  }

  buildContextPackFragment(
    scope: WorkingSetScope,
    now: Date = new Date(),
  ): RecoveryWalContextPackFragment {
    return this.inner.buildContextPackFragment(scope, now);
  }

  getCounters(): RecoveryWalCounters {
    return this.inner.getCounters();
  }

  compactWal(): void {
    this.inner.compactWal();
  }
}
