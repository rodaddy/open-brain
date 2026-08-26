/**
 * Quarantined recovery WAL: what an interrupted session left behind.
 *
 * Design authority: the recovery semantics exercised by
 * `contracts/server/server-realtime-working-recovery.fixture.json` and read by
 * `contracts/server/server-context-pack-sections.fixture.json`.
 *
 * Recovery records are QUARANTINED. They are not durable memory, not searchable
 * recall, and not reviewed — every fragment says so on its face
 * (`not_durable_memory`, `not_searchable_recall`, `unreviewed_quarantine`).
 * A crashed session's last thoughts are exactly the material that looks most
 * like memory and is least entitled to be trusted as memory, so nothing here is
 * ever promoted by this module; a human or an explicit review step decides.
 *
 * Unlike the working set, this store MAY persist to a WAL file, because its
 * whole purpose is to survive the process that died. Replay is deliberately
 * forgiving of a torn tail (a crash mid-append leaves a partial line) but is
 * never SILENT about it: a corrupt WAL and a clean one used to produce
 * identical startups, which made vanished recovery items indistinguishable from
 * an empty journal. Skipped rows are counted and logged.
 *
 * The vocabulary lives in `recovery-wal-types.ts`, the journal-row validators
 * in `recovery-wal-records.ts`, and the pure session-map operations in
 * `recovery-wal-store-parts.ts`. This file is the store that sequences them and
 * owns every journal write.
 */
import type { Logger } from "pino";
import {
  compareWorkingSetScope,
  normalizeWorkingSetScope,
  workingSetScopeHash,
  workingSetScopeKey,
  type NormalizedWorkingSetScope,
  type WorkingSetScope,
  type WorkingSetScopeDenial,
} from "./working-set.ts";
import {
  DEFAULT_RECOVERY_WAL_BUDGET,
  RECOVERY_WAL_ACTIONS,
  RECOVERY_WAL_LABEL,
  RECOVERY_WAL_SCHEMA,
  RECOVERY_WAL_STATUSES,
  type RecoveryWalAction,
  type RecoveryWalBudget,
  type RecoveryWalContextItem,
  type RecoveryWalCounters,
  type RecoveryWalItem,
  type RecoveryWalItemInput,
  type RecoveryWalRecord,
  type RecoveryWalStatus,
} from "./recovery-wal-types.ts";
import {
  appendJournalRecord,
  journalExists,
  readJournalRows,
  rewriteJournal,
} from "./recovery-wal-journal.ts";
import {
  isRecoveryWalAction,
  isRecoveryWalStatus,
  parseWalRecord,
} from "./recovery-wal-records.ts";
import type {
  RecoveryWalAppendResult,
  RecoveryWalContextPackFragment,
  RecoveryWalContextSection,
  RecoveryWalMarkResult,
} from "./recovery-wal-results.ts";
import {
  contextItemFor,
  deleteIfEmpty,
  serializedJsonLength,
  enforceReplayBudgets,
  globalItemCount,
  isPendingAt,
  oldestSession,
  type RecoveryWalSession,
  type RecoveryWalSessions,
} from "./recovery-wal-store-parts.ts";

export {
  DEFAULT_RECOVERY_WAL_BUDGET,
  RECOVERY_WAL_ACTIONS,
  RECOVERY_WAL_LABEL,
  RECOVERY_WAL_SCHEMA,
  RECOVERY_WAL_STATUSES,
};
export type {
  RecoveryWalAppendResult,
  RecoveryWalContextPackFragment,
  RecoveryWalContextSection,
  RecoveryWalMarkResult,
};
export type {
  RecoveryWalAction,
  RecoveryWalBudget,
  RecoveryWalContextItem,
  RecoveryWalCounters,
  RecoveryWalItem,
  RecoveryWalItemInput,
  RecoveryWalStatus,
};

/**
 * What `mark` is being asked to record. Action and status travel with `purge`
 * and `now` in one object so a call site reads as named fields rather than a
 * run of same-typed positional strings.
 */
export interface RecoveryWalMarkDecision {
  action: RecoveryWalAction;
  status: RecoveryWalStatus;
  purge?: boolean;
  now?: Date;
}

export interface RecoveryWalStoreOptions {
  walPath?: string | null;
  budget?: Partial<RecoveryWalBudget>;
  logger?: Logger;
}

export class RecoveryWalStore {
  readonly budget: RecoveryWalBudget;
  readonly walPath: string | null;
  private readonly logger: Logger | undefined;
  private sessions: RecoveryWalSessions = new Map();
  private counters: RecoveryWalCounters = {
    dropped: 0,
    expired: 0,
    trimmed: 0,
    marked: 0,
    purged: 0,
  };
  private nextId = 1;

  constructor(options: RecoveryWalStoreOptions = {}) {
    this.budget = { ...DEFAULT_RECOVERY_WAL_BUDGET, ...options.budget };
    this.walPath = options.walPath ?? null;
    this.logger = options.logger;
    this.loadWal();
  }

  append(
    scope: WorkingSetScope,
    input: RecoveryWalItemInput,
    now: Date = new Date(),
  ): RecoveryWalAppendResult {
    this.purgeExpired(now);

    const rejection = this.rejectionFor(input);
    if (rejection) {
      this.counters.dropped += 1;
      return this.rejectedAppend(rejection);
    }

    const normalizedScope = normalizeWorkingSetScope(scope);
    const key = workingSetScopeKey(normalizedScope);
    const nowMs = now.getTime();
    const session = this.sessions.get(key) ?? {
      scope: normalizedScope,
      items: [],
      updated_at_ms: nowMs,
    };
    const item = this.newItem(input, now);

    session.items.push(item);
    session.updated_at_ms = nowMs;
    this.sessions.set(key, session);
    this.trimSession(session);
    this.trimGlobal();
    this.trimSessions();
    this.writeWal({ op: "append", scope: normalizedScope, item });

    return { accepted: true, item, counters: this.getCounters() };
  }

  /**
   * The one place an append is refused, so the reason a record is turned away
   * is a single readable list rather than a run of early returns interleaved
   * with the construction of the record that is not going to exist.
   */
  private rejectionFor(
    input: RecoveryWalItemInput,
  ): NonNullable<RecoveryWalAppendResult["reason"]> | null {
    const status = input.status ?? "active";
    if (!isRecoveryWalStatus(status)) return "invalid_status";

    const content = input.content.trim();
    if (content.length === 0) return "empty_content";
    if (content.length > this.budget.max_content_chars) {
      return "content_too_large";
    }

    const metadataChars = serializedJsonLength(
      input.metadata ?? {},
      this.logger,
    );
    if (metadataChars === null) return "metadata_too_large";
    if (metadataChars > this.budget.max_metadata_chars) {
      return "metadata_too_large";
    }
    return null;
  }

  private newItem(input: RecoveryWalItemInput, now: Date): RecoveryWalItem {
    const timestamp = now.toISOString();
    return {
      id: input.id ?? `rw-${this.nextId++}`,
      label: RECOVERY_WAL_LABEL,
      status: input.status ?? "active",
      content: input.content.trim(),
      trace_id: input.trace_id ?? null,
      source_ref: input.source_ref ?? null,
      metadata: input.metadata ?? {},
      created_at: timestamp,
      updated_at: timestamp,
      expires_at: new Date(now.getTime() + this.budget.ttl_ms).toISOString(),
      reviewed_at: null,
      last_action: null,
    };
  }

  /**
   * Record a review decision, or purge the record outright. `mark` is the ONLY
   * way a quarantined record leaves the pending set, and it never writes durable
   * memory — promotion, if it happens at all, is a separate authorized path.
   */
  mark(
    scope: WorkingSetScope,
    id: string,
    decision: RecoveryWalMarkDecision,
  ): RecoveryWalMarkResult {
    const { action, status } = decision;
    this.purgeExpired(decision.now ?? new Date());

    if (!isRecoveryWalAction(action))
      return this.rejectedMark("invalid_action");
    if (!isRecoveryWalStatus(status))
      return this.rejectedMark("invalid_status");

    const normalizedScope = normalizeWorkingSetScope(scope);
    const key = workingSetScopeKey(normalizedScope);
    const session = this.sessions.get(key);
    const item = session?.items.find((candidate) => candidate.id === id);
    if (!session || !item) return this.rejectedMark("not_found");

    if (decision.purge) return this.purgeMarked(session, item, normalizedScope);
    return this.applyDecision(session, item, {
      action,
      status,
      scope: normalizedScope,
      now: decision.now ?? new Date(),
    });
  }

  private purgeMarked(
    session: RecoveryWalSession,
    item: RecoveryWalItem,
    scope: NormalizedWorkingSetScope,
  ): RecoveryWalMarkResult {
    session.items = session.items.filter(
      (candidate) => candidate.id !== item.id,
    );
    deleteIfEmpty(this.sessions, session);
    this.counters.purged += 1;
    this.writeWal({ op: "purge", scope, id: item.id });
    return { accepted: true, purged: true, counters: this.getCounters() };
  }

  private applyDecision(
    session: RecoveryWalSession,
    item: RecoveryWalItem,
    decision: {
      action: RecoveryWalAction;
      status: RecoveryWalStatus;
      scope: NormalizedWorkingSetScope;
      now: Date;
    },
  ): RecoveryWalMarkResult {
    const { action, status, scope, now } = decision;
    item.status = status;
    item.last_action = action;
    item.updated_at = now.toISOString();
    // Only an actual look at the record counts as review; deferring or
    // compacting it does not, so `reviewed_at` stays honest about human contact.
    item.reviewed_at =
      action === "review" || action === "use_for_current_session"
        ? now.toISOString()
        : item.reviewed_at;
    session.updated_at_ms = now.getTime();
    this.counters.marked += 1;
    this.writeWal({
      op: "mark",
      scope,
      id: item.id,
      action,
      status,
      reviewed_at: item.reviewed_at,
      updated_at: item.updated_at,
    });

    return { accepted: true, item: { ...item }, counters: this.getCounters() };
  }

  /** The read the context pack consumes: PENDING records for this exact scope only. */
  buildContextPackFragment(
    scope: WorkingSetScope,
    now: Date = new Date(),
  ): RecoveryWalContextPackFragment {
    const nowMs = now.getTime();
    const normalizedScope = normalizeWorkingSetScope(scope);
    const key = workingSetScopeKey(normalizedScope);
    const items = (this.sessions.get(key)?.items ?? []).filter((item) =>
      isPendingAt(item, nowMs),
    );

    return {
      recovery: {
        schema: RECOVERY_WAL_SCHEMA,
        label: RECOVERY_WAL_LABEL,
        exact_scope_required: true,
        not_durable_memory: true,
        not_searchable_recall: true,
        unreviewed_quarantine: true,
        scope: normalizedScope,
        pending_count: items.length,
        items: items.map((item) => contextItemFor(item, this.budget)),
        item_count: items.length,
        budget: this.budget,
        counters: this.getCounters(),
        wal_path_configured: this.walPath !== null,
      },
      warnings: { scope_denials: this.scopeDenialsFor(normalizedScope, nowMs) },
      budget: { recovery: this.budget },
    };
  }

  getCounters(): RecoveryWalCounters {
    return { ...this.counters };
  }

  private rejectedAppend(
    reason: NonNullable<RecoveryWalAppendResult["reason"]>,
  ): RecoveryWalAppendResult {
    return { accepted: false, reason, counters: this.getCounters() };
  }

  private rejectedMark(
    reason: NonNullable<RecoveryWalMarkResult["reason"]>,
  ): RecoveryWalMarkResult {
    return { accepted: false, reason, counters: this.getCounters() };
  }

  /**
   * TTL eviction. An expired record is transitioned to `expired` and journaled
   * as a discard BEFORE removal, so a WAL replayed after the fact reaches the
   * same state rather than resurrecting a record the TTL already retired.
   */
  private purgeExpired(now: Date): void {
    const nowMs = now.getTime();
    for (const [key, session] of this.sessions.entries()) {
      for (const item of session.items) {
        if (Date.parse(item.expires_at) <= nowMs && item.status !== "expired") {
          item.status = "expired";
          item.updated_at = now.toISOString();
          this.counters.expired += 1;
          this.writeWal({
            op: "mark",
            scope: session.scope,
            id: item.id,
            action: "discard",
            status: "expired",
            reviewed_at: item.reviewed_at,
            updated_at: item.updated_at,
          });
        }
      }
      session.items = session.items.filter((item) => item.status !== "expired");
      if (session.items.length === 0) this.sessions.delete(key);
    }
  }

  private trimSession(session: RecoveryWalSession): void {
    const overflow = session.items.length - this.budget.max_items_per_session;
    if (overflow > 0) {
      const removed = session.items.splice(0, overflow);
      this.counters.trimmed += overflow;
      for (const item of removed) {
        this.writeWal({ op: "purge", scope: session.scope, id: item.id });
      }
    }
  }

  private trimGlobal(): void {
    while (globalItemCount(this.sessions) > this.budget.max_global_items) {
      const oldest = oldestSession(this.sessions);
      if (!oldest) return;
      const removed = oldest.items.shift();
      if (removed) {
        this.counters.trimmed += 1;
        this.writeWal({ op: "purge", scope: oldest.scope, id: removed.id });
      }
      deleteIfEmpty(this.sessions, oldest);
    }
  }

  private trimSessions(): void {
    while (this.sessions.size > this.budget.max_sessions) {
      const oldest = oldestSession(this.sessions);
      if (!oldest) return;
      this.counters.trimmed += oldest.items.length;
      this.writeWal({ op: "purge", scope: oldest.scope });
      this.sessions.delete(workingSetScopeKey(oldest.scope));
    }
  }

  /** Same-namespace near misses only, and only lanes that actually hold pending work. */
  private scopeDenialsFor(
    requestedScope: NormalizedWorkingSetScope,
    nowMs: number,
  ): WorkingSetScopeDenial[] {
    const requestedKey = workingSetScopeKey(requestedScope);
    const denials: WorkingSetScopeDenial[] = [];
    for (const [key, session] of this.sessions.entries()) {
      if (key === requestedKey) continue;
      if (session.scope.namespace !== requestedScope.namespace) continue;
      if (!session.items.some((item) => isPendingAt(item, nowMs))) continue;
      const reasons = compareWorkingSetScope(requestedScope, session.scope);
      if (reasons.length > 0) {
        denials.push({
          scope_hash: workingSetScopeHash(session.scope),
          reasons,
        });
      }
    }
    return denials;
  }

  /**
   * Replay the journal at construction.
   *
   * A malformed row is SKIPPED rather than crashing startup — a torn tail is the
   * expected consequence of the crash this store exists to survive. But skipping
   * silently is the defect: a WAL that replayed 3 of 400 rows and one that
   * replayed all 400 produced identical startups, so vanished recovery items
   * looked exactly like an empty journal. Counts are logged, with one
   * representative cause (the rest are nearly always the same fault).
   */
  private loadWal(): void {
    if (!this.walPath || !journalExists(this.walPath)) return;
    const rows = readJournalRows(this.walPath);

    this.logReplay(rows.length, this.replayRows(rows));
    this.enforceReplayBudgets();
    this.compactWal();
  }

  /** Apply every row, tallying the two ways a row can fail to land. */
  private replayRows(rows: string[]): {
    unparseable: number;
    unapplicable: number;
    firstApplyError: unknown;
  } {
    let unparseable = 0;
    let unapplicable = 0;
    let firstApplyError: unknown;
    for (const row of rows) {
      const record = parseWalRecord(row);
      if (!record) {
        unparseable += 1;
        continue;
      }
      try {
        this.applyWalRecord(record);
      } catch (error) {
        unapplicable += 1;
        if (firstApplyError === undefined) firstApplyError = error;
      }
    }
    return { unparseable, unapplicable, firstApplyError };
  }

  private logReplay(
    rowsTotal: number,
    outcome: {
      unparseable: number;
      unapplicable: number;
      firstApplyError: unknown;
    },
  ): void {
    const { unparseable, unapplicable, firstApplyError } = outcome;
    if (unparseable === 0 && unapplicable === 0) {
      this.logger?.debug({ rows_total: rowsTotal }, "recovery_wal_replayed");
      return;
    }
    this.logger?.warn(
      {
        rows_total: rowsTotal,
        rows_unparseable: unparseable,
        rows_unapplicable: unapplicable,
        error_name: replayErrorName(firstApplyError),
      },
      "recovery_wal_rows_skipped",
    );
  }

  private writeWal(record: RecoveryWalRecord): void {
    if (!this.walPath) return;
    appendJournalRecord(this.walPath, record);
  }

  private applyWalRecord(record: RecoveryWalRecord): void {
    const key = workingSetScopeKey(record.scope);
    if (record.op === "append") {
      this.applyAppendRecord(key, record.scope, record.item);
      return;
    }
    const session = this.sessions.get(key);
    if (!session) return;
    if (record.op === "purge") {
      session.items = record.id
        ? session.items.filter((item) => item.id !== record.id)
        : [];
      if (session.items.length === 0) this.sessions.delete(key);
      return;
    }
    const item = session.items.find((candidate) => candidate.id === record.id);
    if (!item) return;
    item.status = record.status;
    item.last_action = record.action;
    item.reviewed_at = record.reviewed_at;
    item.updated_at = record.updated_at;
    session.updated_at_ms = Date.parse(record.updated_at);
  }

  private applyAppendRecord(
    key: string,
    scope: NormalizedWorkingSetScope,
    item: RecoveryWalItem,
  ): void {
    // A record that exceeds the CURRENT budget is dropped on replay rather
    // than admitted: the live budget is authoritative, not the one in force
    // when the row was written.
    if (!this.isReplayItemWithinBudget(item)) {
      this.counters.dropped += 1;
      return;
    }
    const updatedAtMs = Date.parse(item.updated_at);
    const session = this.sessions.get(key) ?? {
      scope,
      items: [],
      updated_at_ms: updatedAtMs,
    };
    session.items.push(item);
    session.updated_at_ms = updatedAtMs;
    this.sessions.set(key, session);
    this.trackNextId(item.id);
  }

  private isReplayItemWithinBudget(item: RecoveryWalItem): boolean {
    const metadataChars = serializedJsonLength(item.metadata, this.logger);
    return (
      item.content.length <= this.budget.max_content_chars &&
      metadataChars !== null &&
      metadataChars <= this.budget.max_metadata_chars
    );
  }

  /** Apply the live size budgets to a replayed state that predates them. */
  private enforceReplayBudgets(): void {
    this.counters.trimmed += enforceReplayBudgets(this.sessions, this.budget);
  }

  /** Keep generated ids monotonic across a replay so a new item cannot collide. */
  private trackNextId(id: string): void {
    const match = /^rw-(\d+)$/.exec(id);
    if (!match) return;
    this.nextId = Math.max(this.nextId, Number(match[1]) + 1);
  }

  /** Rewrite the journal as the current live state: bounded growth, same result on replay. */
  compactWal(): void {
    if (!this.walPath) return;
    const records: RecoveryWalRecord[] = [];
    for (const session of this.sessions.values()) {
      for (const item of session.items) {
        records.push({ op: "append", scope: session.scope, item });
      }
    }
    rewriteJournal(this.walPath, records);
  }
}

function replayErrorName(error: unknown): string | null {
  if (error === undefined) return null;
  return error instanceof Error ? error.name : typeof error;
}
