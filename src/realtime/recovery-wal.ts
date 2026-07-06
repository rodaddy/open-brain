import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  compareWorkingSetScope,
  normalizeWorkingSetScope,
  workingSetScopeHash,
  workingSetScopeKey,
  type NormalizedWorkingSetScope,
  type WorkingSetScope,
  type WorkingSetScopeDenial,
} from "./working-set.ts";

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
  reviewed_at: string | null;
  last_action: RecoveryWalAction | null;
  metadata: Record<string, unknown>;
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

export interface RecoveryWalStoreOptions {
  walPath?: string | null;
  budget?: Partial<RecoveryWalBudget>;
}

interface RecoveryWalSession {
  scope: NormalizedWorkingSetScope;
  items: RecoveryWalItem[];
  updated_at_ms: number;
}

type RecoveryWalRecord =
  | {
      op: "append";
      scope: NormalizedWorkingSetScope;
      item: RecoveryWalItem;
    }
  | {
      op: "mark";
      scope: NormalizedWorkingSetScope;
      id: string;
      action: RecoveryWalAction;
      status: RecoveryWalStatus;
      reviewed_at: string | null;
      updated_at: string;
    }
  | {
      op: "purge";
      scope: NormalizedWorkingSetScope;
      id?: string;
    };

const RECOVERY_WAL_STATUS_SET = new Set<string>(RECOVERY_WAL_STATUSES);
const RECOVERY_WAL_ACTION_SET = new Set<string>(RECOVERY_WAL_ACTIONS);
const PENDING_STATUSES = new Set<RecoveryWalStatus>([
  "active",
  "recovery_pending",
]);

export const DEFAULT_RECOVERY_WAL_BUDGET: RecoveryWalBudget = {
  ttl_ms: 24 * 60 * 60 * 1000,
  max_sessions: 128,
  max_items_per_session: 50,
  max_global_items: 2048,
  max_content_chars: 8000,
  max_metadata_chars: 2000,
  max_preview_chars: 1000,
};

export class RecoveryWalStore {
  readonly budget: RecoveryWalBudget;
  readonly walPath: string | null;
  private sessions = new Map<string, RecoveryWalSession>();
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
    this.loadWal();
  }

  append(
    scope: WorkingSetScope,
    input: RecoveryWalItemInput,
    now: Date = new Date(),
  ): RecoveryWalAppendResult {
    this.purgeExpired(now);

    const status = input.status ?? "active";
    if (!RECOVERY_WAL_STATUS_SET.has(status)) {
      this.counters.dropped += 1;
      return this.appendResult(false, "invalid_status");
    }

    const content = input.content.trim();
    if (content.length === 0) {
      this.counters.dropped += 1;
      return this.appendResult(false, "empty_content");
    }
    if (content.length > this.budget.max_content_chars) {
      this.counters.dropped += 1;
      return this.appendResult(false, "content_too_large");
    }
    const metadata = input.metadata ?? {};
    const metadataChars = serializedJsonLength(metadata);
    if (
      metadataChars === null ||
      metadataChars > this.budget.max_metadata_chars
    ) {
      this.counters.dropped += 1;
      return this.appendResult(false, "metadata_too_large");
    }

    const normalizedScope = normalizeWorkingSetScope(scope);
    const key = workingSetScopeKey(normalizedScope);
    const nowMs = now.getTime();
    const session = this.sessions.get(key) ?? {
      scope: normalizedScope,
      items: [],
      updated_at_ms: nowMs,
    };
    const item: RecoveryWalItem = {
      id: input.id ?? `rw-${this.nextId++}`,
      label: RECOVERY_WAL_LABEL,
      status,
      content,
      trace_id: input.trace_id ?? null,
      source_ref: input.source_ref ?? null,
      metadata,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      expires_at: new Date(nowMs + this.budget.ttl_ms).toISOString(),
      reviewed_at: null,
      last_action: null,
    };

    session.items.push(item);
    session.updated_at_ms = nowMs;
    this.sessions.set(key, session);
    this.trimSession(session);
    this.trimGlobal();
    this.trimSessions();
    this.writeWal({ op: "append", scope: normalizedScope, item });

    return { accepted: true, item, counters: this.getCounters() };
  }

  mark(
    scope: WorkingSetScope,
    id: string,
    action: RecoveryWalAction,
    status: RecoveryWalStatus,
    options: { purge?: boolean; now?: Date } = {},
  ): RecoveryWalMarkResult {
    this.purgeExpired(options.now ?? new Date());

    if (!RECOVERY_WAL_ACTION_SET.has(action)) {
      return this.markResult(false, "invalid_action");
    }
    if (!RECOVERY_WAL_STATUS_SET.has(status)) {
      return this.markResult(false, "invalid_status");
    }

    const normalizedScope = normalizeWorkingSetScope(scope);
    const key = workingSetScopeKey(normalizedScope);
    const session = this.sessions.get(key);
    const item = session?.items.find((candidate) => candidate.id === id);
    if (!session || !item) {
      return this.markResult(false, "not_found");
    }

    if (options.purge) {
      session.items = session.items.filter((candidate) => candidate.id !== id);
      if (session.items.length === 0) {
        this.sessions.delete(key);
      }
      this.counters.purged += 1;
      this.writeWal({ op: "purge", scope: normalizedScope, id });
      return { accepted: true, purged: true, counters: this.getCounters() };
    }

    const now = options.now ?? new Date();
    item.status = status;
    item.last_action = action;
    item.updated_at = now.toISOString();
    item.reviewed_at =
      action === "review" || action === "use_for_current_session"
        ? now.toISOString()
        : item.reviewed_at;
    session.updated_at_ms = now.getTime();
    this.counters.marked += 1;
    this.writeWal({
      op: "mark",
      scope: normalizedScope,
      id,
      action,
      status,
      reviewed_at: item.reviewed_at,
      updated_at: item.updated_at,
    });

    return { accepted: true, item: { ...item }, counters: this.getCounters() };
  }

  buildContextPackFragment(
    scope: WorkingSetScope,
    now: Date = new Date(),
  ): RecoveryWalContextPackFragment {
    const nowMs = now.getTime();
    const normalizedScope = normalizeWorkingSetScope(scope);
    const key = workingSetScopeKey(normalizedScope);
    const items = (this.sessions.get(key)?.items ?? []).filter((item) =>
      this.isPendingAt(item, nowMs),
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
        items: items.map((item) => this.contextItemFor(item)),
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

  private appendResult(
    accepted: false,
    reason: RecoveryWalAppendResult["reason"],
  ): RecoveryWalAppendResult {
    return { accepted, reason, counters: this.getCounters() };
  }

  private markResult(
    accepted: false,
    reason: RecoveryWalMarkResult["reason"],
  ): RecoveryWalMarkResult {
    return { accepted, reason, counters: this.getCounters() };
  }

  private contextItemFor(item: RecoveryWalItem): RecoveryWalContextItem {
    const preview =
      item.content.length > this.budget.max_preview_chars
        ? item.content.slice(0, this.budget.max_preview_chars)
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
      if (session.items.length === 0) {
        this.sessions.delete(key);
      }
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
    while (this.globalItemCount() > this.budget.max_global_items) {
      const oldest = this.oldestSession();
      if (!oldest) return;
      const removed = oldest.items.shift();
      if (removed) {
        this.counters.trimmed += 1;
        this.writeWal({ op: "purge", scope: oldest.scope, id: removed.id });
      }
      if (oldest.items.length === 0) {
        this.sessions.delete(workingSetScopeKey(oldest.scope));
      }
    }
  }

  private trimSessions(): void {
    while (this.sessions.size > this.budget.max_sessions) {
      const oldest = this.oldestSession();
      if (!oldest) return;
      this.counters.trimmed += oldest.items.length;
      this.writeWal({ op: "purge", scope: oldest.scope });
      this.sessions.delete(workingSetScopeKey(oldest.scope));
    }
  }

  private oldestSession(): RecoveryWalSession | null {
    let oldest: RecoveryWalSession | null = null;
    for (const session of this.sessions.values()) {
      if (!oldest || session.updated_at_ms < oldest.updated_at_ms) {
        oldest = session;
      }
    }
    return oldest;
  }

  private globalItemCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      count += session.items.length;
    }
    return count;
  }

  private scopeDenialsFor(
    requestedScope: NormalizedWorkingSetScope,
    nowMs: number,
  ): WorkingSetScopeDenial[] {
    const requestedKey = workingSetScopeKey(requestedScope);
    const denials: WorkingSetScopeDenial[] = [];
    for (const [key, session] of this.sessions.entries()) {
      if (key === requestedKey) continue;
      if (session.scope.namespace !== requestedScope.namespace) continue;
      if (!session.items.some((item) => this.isPendingAt(item, nowMs))) {
        continue;
      }
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

  private isPendingAt(item: RecoveryWalItem, nowMs: number): boolean {
    return PENDING_STATUSES.has(item.status) && Date.parse(item.expires_at) > nowMs;
  }

  private loadWal(): void {
    if (!this.walPath || !existsSync(this.walPath)) return;
    const rows = readFileSync(this.walPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const row of rows) {
      const record = parseWalRecord(row);
      if (!record) continue;
      try {
        this.applyWalRecord(record);
      } catch {
        continue;
      }
    }
    this.enforceReplayBudgets();
    this.compactWal();
  }

  private writeWal(record: RecoveryWalRecord): void {
    if (!this.walPath) return;
    mkdirSync(dirname(this.walPath), { recursive: true });
    appendFileSync(this.walPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  private applyWalRecord(record: RecoveryWalRecord): void {
    const key = workingSetScopeKey(record.scope);
    if (record.op === "append") {
      if (!this.isReplayItemWithinBudget(record.item)) {
        this.counters.dropped += 1;
        return;
      }
      const session = this.sessions.get(key) ?? {
        scope: record.scope,
        items: [],
        updated_at_ms: Date.parse(record.item.updated_at),
      };
      session.items.push(record.item);
      session.updated_at_ms = Date.parse(record.item.updated_at);
      this.sessions.set(key, session);
      this.trackNextId(record.item.id);
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

  private isReplayItemWithinBudget(item: RecoveryWalItem): boolean {
    const metadataChars = serializedJsonLength(item.metadata);
    return (
      item.content.length <= this.budget.max_content_chars &&
      metadataChars !== null &&
      metadataChars <= this.budget.max_metadata_chars
    );
  }

  private enforceReplayBudgets(): void {
    for (const [key, session] of this.sessions.entries()) {
      const overflow = session.items.length - this.budget.max_items_per_session;
      if (overflow > 0) {
        session.items.splice(0, overflow);
        this.counters.trimmed += overflow;
      }
      if (session.items.length === 0) {
        this.sessions.delete(key);
      }
    }
    while (this.globalItemCount() > this.budget.max_global_items) {
      const oldest = this.oldestSession();
      if (!oldest) return;
      const removed = oldest.items.shift();
      if (removed) {
        this.counters.trimmed += 1;
      }
      if (oldest.items.length === 0) {
        this.sessions.delete(workingSetScopeKey(oldest.scope));
      }
    }
    while (this.sessions.size > this.budget.max_sessions) {
      const oldest = this.oldestSession();
      if (!oldest) return;
      this.counters.trimmed += oldest.items.length;
      this.sessions.delete(workingSetScopeKey(oldest.scope));
    }
  }

  private trackNextId(id: string): void {
    const match = /^rw-(\d+)$/.exec(id);
    if (!match) return;
    this.nextId = Math.max(this.nextId, Number(match[1]) + 1);
  }

  compactWal(): void {
    if (!this.walPath) return;
    mkdirSync(dirname(this.walPath), { recursive: true });
    const records: RecoveryWalRecord[] = [];
    for (const session of this.sessions.values()) {
      for (const item of session.items) {
        records.push({ op: "append", scope: session.scope, item });
      }
    }
    writeFileSync(
      this.walPath,
      records.map((record) => JSON.stringify(record)).join("\n") +
        (records.length > 0 ? "\n" : ""),
      "utf8",
    );
  }
}

function parseWalRecord(row: string): RecoveryWalRecord | null {
  try {
    const record = JSON.parse(row);
    if (isRecoveryWalRecord(record)) {
      return record as RecoveryWalRecord;
    }
  } catch {
    return null;
  }
  return null;
}

function isRecoveryWalRecord(record: unknown): record is RecoveryWalRecord {
  if (!isRecord(record)) return false;
  if (!isNormalizedScope(record.scope)) return false;
  if (record.op === "append") {
    return isRecoveryWalItem(record.item);
  }
  if (record.op === "mark") {
    return (
      typeof record.id === "string" &&
      typeof record.action === "string" &&
      RECOVERY_WAL_ACTION_SET.has(record.action) &&
      typeof record.status === "string" &&
      RECOVERY_WAL_STATUS_SET.has(record.status) &&
      (record.reviewed_at === null ||
        (typeof record.reviewed_at === "string" &&
          Number.isFinite(Date.parse(record.reviewed_at)))) &&
      typeof record.updated_at === "string" &&
      Number.isFinite(Date.parse(record.updated_at))
    );
  }
  if (record.op === "purge") {
    return record.id === undefined || typeof record.id === "string";
  }
  return false;
}

function isRecoveryWalItem(value: unknown): value is RecoveryWalItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.label === RECOVERY_WAL_LABEL &&
    typeof value.status === "string" &&
    RECOVERY_WAL_STATUS_SET.has(value.status) &&
    typeof value.content === "string" &&
    (value.trace_id === null || typeof value.trace_id === "string") &&
    (value.source_ref === null || typeof value.source_ref === "string") &&
    isRecord(value.metadata) &&
    typeof value.created_at === "string" &&
    Number.isFinite(Date.parse(value.created_at)) &&
    typeof value.updated_at === "string" &&
    Number.isFinite(Date.parse(value.updated_at)) &&
    typeof value.expires_at === "string" &&
    Number.isFinite(Date.parse(value.expires_at)) &&
    (value.reviewed_at === null ||
      (typeof value.reviewed_at === "string" &&
        Number.isFinite(Date.parse(value.reviewed_at)))) &&
    (value.last_action === null ||
      (typeof value.last_action === "string" &&
        RECOVERY_WAL_ACTION_SET.has(value.last_action)))
  );
}

function isNormalizedScope(value: unknown): value is NormalizedWorkingSetScope {
  return (
    isRecord(value) &&
    typeof value.namespace === "string" &&
    value.namespace.trim().length > 0 &&
    typeof value.agent === "string" &&
    value.agent.trim().length > 0 &&
    typeof value.platform === "string" &&
    value.platform.trim().length > 0 &&
    typeof value.server_id === "string" &&
    value.server_id.trim().length > 0 &&
    typeof value.channel_id === "string" &&
    value.channel_id.trim().length > 0 &&
    (value.thread_id === null ||
      (typeof value.thread_id === "string" &&
        value.thread_id.trim().length > 0)) &&
    typeof value.session_key === "string" &&
    value.session_key.trim().length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function serializedJsonLength(value: unknown): number | null {
  try {
    return JSON.stringify(value).length;
  } catch {
    return null;
  }
}
