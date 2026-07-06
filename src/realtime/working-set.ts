import { createHash } from "node:crypto";

export const WORKING_SET_LABEL = "working_context" as const;
export const WORKING_SET_SCHEMA = "openbrain.working_set.v1" as const;

export const WORKING_SET_ITEM_KINDS = [
  "recent_event",
  "structured_event",
  "current_intent",
  "active_correction",
  "task_state",
  "linked_durable_ref",
  "next_turn_guidance",
] as const;

export type WorkingSetItemKind = (typeof WORKING_SET_ITEM_KINDS)[number];

export interface WorkingSetScope {
  namespace: string;
  agent: string;
  platform: string;
  server_id: string;
  channel_id: string;
  thread_id?: string | null;
  session_key: string;
}

export interface NormalizedWorkingSetScope {
  namespace: string;
  agent: string;
  platform: string;
  server_id: string;
  channel_id: string;
  thread_id: string | null;
  session_key: string;
}

export interface WorkingSetBudget {
  ttl_ms: number;
  max_sessions: number;
  max_items_per_session: number;
  max_global_items: number;
  max_item_chars: number;
}

export interface WorkingSetCounters {
  dropped: number;
  expired: number;
  trimmed: number;
}

export interface WorkingSetItemInput {
  id?: string;
  kind: WorkingSetItemKind;
  content: string;
  confidence?: number;
  stale_at?: string | null;
  trace_id?: string | null;
  source_ref?: string | null;
  durable_ref?: { table: string; id: string } | null;
  metadata?: Record<string, unknown>;
}

export interface WorkingSetItem {
  id: string;
  kind: WorkingSetItemKind;
  label: typeof WORKING_SET_LABEL;
  content: string;
  confidence: number | null;
  stale_at: string | null;
  trace_id: string | null;
  source_ref: string | null;
  durable_ref: { table: string; id: string } | null;
  metadata: Record<string, unknown>;
  created_at: string;
  expires_at: string;
}

export interface WorkingSetAppendResult {
  accepted: boolean;
  reason?: "content_too_large" | "empty_content" | "invalid_kind";
  item?: WorkingSetItem;
  counters: WorkingSetCounters;
}

export interface WorkingSetScopeDenial {
  scope_hash: string;
  reasons: Array<keyof NormalizedWorkingSetScope>;
}

export interface WorkingSetContextSection {
  schema: typeof WORKING_SET_SCHEMA;
  label: typeof WORKING_SET_LABEL;
  exact_scope_required: true;
  not_durable_memory: true;
  scope: NormalizedWorkingSetScope;
  items: WorkingSetItem[];
  item_count: number;
  budget: WorkingSetBudget;
  counters: WorkingSetCounters;
}

export interface WorkingSetContextPackFragment {
  working_set: WorkingSetContextSection;
  warnings: {
    scope_denials: WorkingSetScopeDenial[];
  };
  budget: {
    working_set: WorkingSetBudget;
  };
}

export const DEFAULT_WORKING_SET_BUDGET: WorkingSetBudget = {
  ttl_ms: 30 * 60 * 1000,
  max_sessions: 128,
  max_items_per_session: 24,
  max_global_items: 1024,
  max_item_chars: 4000,
};

const WORKING_SET_ITEM_KIND_SET = new Set<string>(WORKING_SET_ITEM_KINDS);

interface WorkingSetSession {
  scope: NormalizedWorkingSetScope;
  items: WorkingSetItem[];
  updated_at_ms: number;
}

export function normalizeWorkingSetScope(
  scope: WorkingSetScope,
): NormalizedWorkingSetScope {
  return {
    namespace: requireScopePart(scope.namespace, "namespace"),
    agent: requireScopePart(scope.agent, "agent"),
    platform: requireScopePart(scope.platform, "platform"),
    server_id: requireScopePart(scope.server_id, "server_id"),
    channel_id: requireScopePart(scope.channel_id, "channel_id"),
    thread_id:
      scope.thread_id === undefined || scope.thread_id === null
        ? null
        : requireScopePart(scope.thread_id, "thread_id"),
    session_key: requireScopePart(scope.session_key, "session_key"),
  };
}

export function workingSetScopeKey(scope: WorkingSetScope): string {
  const normalized = normalizeWorkingSetScope(scope);
  return JSON.stringify([
    normalized.namespace,
    normalized.agent,
    normalized.platform,
    normalized.server_id,
    normalized.channel_id,
    normalized.thread_id,
    normalized.session_key,
  ]);
}

export function workingSetScopeHash(scope: WorkingSetScope): string {
  return createHash("sha256")
    .update(workingSetScopeKey(scope))
    .digest("hex")
    .slice(0, 16);
}

export function compareWorkingSetScope(
  left: WorkingSetScope,
  right: WorkingSetScope,
): Array<keyof NormalizedWorkingSetScope> {
  const a = normalizeWorkingSetScope(left);
  const b = normalizeWorkingSetScope(right);
  const fields: Array<keyof NormalizedWorkingSetScope> = [
    "namespace",
    "agent",
    "platform",
    "server_id",
    "channel_id",
    "thread_id",
    "session_key",
  ];
  return fields.filter((field) => a[field] !== b[field]);
}

export class WorkingSetStore {
  readonly budget: WorkingSetBudget;
  private sessions = new Map<string, WorkingSetSession>();
  private counters: WorkingSetCounters = { dropped: 0, expired: 0, trimmed: 0 };
  private nextId = 1;

  constructor(budget: Partial<WorkingSetBudget> = {}) {
    this.budget = { ...DEFAULT_WORKING_SET_BUDGET, ...budget };
  }

  append(
    scope: WorkingSetScope,
    input: WorkingSetItemInput,
    now: Date = new Date(),
  ): WorkingSetAppendResult {
    this.purgeExpired(now);

    if (!WORKING_SET_ITEM_KIND_SET.has(input.kind)) {
      this.counters.dropped += 1;
      return this.result(false, "invalid_kind");
    }

    const content = input.content.trim();
    if (content.length === 0) {
      this.counters.dropped += 1;
      return this.result(false, "empty_content");
    }
    if (content.length > this.budget.max_item_chars) {
      this.counters.dropped += 1;
      return this.result(false, "content_too_large");
    }

    const normalizedScope = normalizeWorkingSetScope(scope);
    const key = workingSetScopeKey(normalizedScope);
    const nowMs = now.getTime();
    const session = this.sessions.get(key) ?? {
      scope: normalizedScope,
      items: [],
      updated_at_ms: nowMs,
    };

    const item: WorkingSetItem = {
      id: input.id ?? `ws-${this.nextId++}`,
      kind: input.kind,
      label: WORKING_SET_LABEL,
      content,
      confidence: input.confidence ?? null,
      stale_at: input.stale_at ?? null,
      trace_id: input.trace_id ?? null,
      source_ref: input.source_ref ?? null,
      durable_ref: input.durable_ref ?? null,
      metadata: input.metadata ?? {},
      created_at: now.toISOString(),
      expires_at: new Date(nowMs + this.budget.ttl_ms).toISOString(),
    };

    session.items.push(item);
    session.updated_at_ms = nowMs;
    this.sessions.set(key, session);
    this.trimSession(session);
    this.trimGlobal();
    this.trimSessions();

    return { accepted: true, item, counters: this.getCounters() };
  }

  buildContextPackFragment(
    scope: WorkingSetScope,
    now: Date = new Date(),
  ): WorkingSetContextPackFragment {
    this.purgeExpired(now);
    const normalizedScope = normalizeWorkingSetScope(scope);
    const key = workingSetScopeKey(normalizedScope);
    const items = this.sessions.get(key)?.items ?? [];

    return {
      working_set: {
        schema: WORKING_SET_SCHEMA,
        label: WORKING_SET_LABEL,
        exact_scope_required: true,
        not_durable_memory: true,
        scope: normalizedScope,
        items: [...items],
        item_count: items.length,
        budget: this.budget,
        counters: this.getCounters(),
      },
      warnings: {
        scope_denials: this.scopeDenialsFor(normalizedScope),
      },
      budget: {
        working_set: this.budget,
      },
    };
  }

  getCounters(): WorkingSetCounters {
    return { ...this.counters };
  }

  private result(
    accepted: false,
    reason: WorkingSetAppendResult["reason"],
  ): WorkingSetAppendResult {
    return { accepted, reason, counters: this.getCounters() };
  }

  private purgeExpired(now: Date): void {
    const nowMs = now.getTime();
    for (const [key, session] of this.sessions.entries()) {
      const kept = session.items.filter(
        (item) => Date.parse(item.expires_at) > nowMs,
      );
      const expired = session.items.length - kept.length;
      if (expired > 0) {
        this.counters.expired += expired;
        session.items = kept;
      }
      if (session.items.length === 0) {
        this.sessions.delete(key);
      }
    }
  }

  private trimSession(session: WorkingSetSession): void {
    const overflow = session.items.length - this.budget.max_items_per_session;
    if (overflow > 0) {
      session.items.splice(0, overflow);
      this.counters.trimmed += overflow;
    }
  }

  private trimGlobal(): void {
    while (this.globalItemCount() > this.budget.max_global_items) {
      const oldest = this.oldestSession();
      if (!oldest) {
        return;
      }
      oldest.items.shift();
      this.counters.trimmed += 1;
      if (oldest.items.length === 0) {
        this.sessions.delete(workingSetScopeKey(oldest.scope));
      }
    }
  }

  private trimSessions(): void {
    while (this.sessions.size > this.budget.max_sessions) {
      const oldest = this.oldestSession();
      if (!oldest) {
        return;
      }
      this.counters.trimmed += oldest.items.length;
      this.sessions.delete(workingSetScopeKey(oldest.scope));
    }
  }

  private oldestSession(): WorkingSetSession | null {
    let oldest: WorkingSetSession | null = null;
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
  ): WorkingSetScopeDenial[] {
    const requestedKey = workingSetScopeKey(requestedScope);
    const denials: WorkingSetScopeDenial[] = [];
    for (const [key, session] of this.sessions.entries()) {
      if (key === requestedKey) {
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
}

function requireScopePart(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`working set scope requires non-empty ${field}`);
  }
  return trimmed;
}
