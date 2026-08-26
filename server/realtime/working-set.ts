/**
 * RAM-only working-set store: the exact-scope hot active context for one turn.
 *
 * Design authority: `docs/decisions/realtime-working-set.md` semantics as
 * exercised by `contracts/server/server-realtime-working-recovery.fixture.json`
 * and `contracts/server/server-context-pack-sections.fixture.json`.
 *
 * The whole point of this store is what it is NOT. Working-set items are not
 * durable memory, are not searchable recall, and are never promoted anywhere by
 * this module — `not_durable_memory: true` is emitted on every fragment so a
 * consumer cannot mistake this for the brain. State lives in process memory and
 * dies with it, deliberately: this is the scratch surface an agent uses inside a
 * turn, and persisting it would turn every stray intermediate thought into a
 * durable record nobody asked to keep.
 *
 * EXACT scope is the isolation boundary. All seven coordinates
 * (namespace/agent/platform/server_id/channel_id/thread_id/session_key) must
 * match for an item to be visible; a near-miss is reported as a content-free
 * scope denial (a scope HASH and the differing field names — never the values)
 * so a caller can tell "you are in the wrong lane" apart from "there is nothing
 * here", without learning anything about the other lane's contents.
 */
import { createHash } from "node:crypto";
import type { Logger } from "pino";

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

/** The seven exact scope coordinates; `thread_id` is the only nullable one. */
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
  max_metadata_chars: number;
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
  reason?:
    | "content_too_large"
    | "empty_content"
    | "invalid_kind"
    | "metadata_too_large";
  item?: WorkingSetItem;
  counters: WorkingSetCounters;
}

/**
 * A content-free near-miss report: which scope fields differed, and a stable
 * hash of the other scope. Never the other scope's values, and never its items.
 */
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
  max_metadata_chars: 2000,
};

const WORKING_SET_ITEM_KIND_SET = new Set<string>(WORKING_SET_ITEM_KINDS);

interface WorkingSetSession {
  scope: NormalizedWorkingSetScope;
  items: WorkingSetItem[];
  updated_at_ms: number;
}

/** Reject an empty scope coordinate rather than silently collapsing lanes. */
function requireScopePart(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`working set scope requires non-empty ${field}`);
  }
  return trimmed;
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

/**
 * Stable exact-scope key. JSON-array encoding of the seven ordered coordinates,
 * so no coordinate value can be crafted to collide across field boundaries the
 * way a delimiter-joined string allows.
 */
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

/** Content-free scope identity for denial reporting; never reversible to values. */
export function workingSetScopeHash(scope: WorkingSetScope): string {
  return createHash("sha256")
    .update(workingSetScopeKey(scope))
    .digest("hex")
    .slice(0, 16);
}

/** Which of the seven coordinates differ between two scopes. */
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

/**
 * Serialized length, or null when the value cannot be serialized at all.
 *
 * The caller treats null as over-budget, which is a real mismatch: a cycle or a
 * BigInt in metadata is a SHAPE fault, and the caller is told
 * `metadata_too_large` about a value whose size was never the problem.
 * Correcting that label would change the public result reason the parity
 * fixtures freeze, so the verdict stands — but the true cause is logged instead
 * of discarded, which is what makes the misleading label diagnosable.
 */
function serializedJsonLength(
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
      "working_set_metadata_unserializable",
    );
    return null;
  }
}

export interface WorkingSetStoreOptions {
  budget?: Partial<WorkingSetBudget>;
  /** Optional; absent means the shape-fault warning above is simply not emitted. */
  logger?: Logger;
}

/**
 * The accepted shape of an append candidate: the trimmed content and the
 * metadata object the item will carry, once every rejection has been ruled out.
 */
interface AcceptedWorkingSetInput {
  content: string;
  metadata: Record<string, unknown>;
}

type ScreenedWorkingSetInput =
  | { rejection: NonNullable<WorkingSetAppendResult["reason"]> }
  | { rejection: null; accepted: AcceptedWorkingSetInput };

interface ScreenWorkingSetInputOptions {
  input: WorkingSetItemInput;
  budget: WorkingSetBudget;
  logger: Logger | undefined;
}

/**
 * Every reason an append is refused, in the order the store has always checked
 * them: kind, then empty content, then content size, then metadata. The order is
 * observable — a call that is both an invalid kind and oversized reports
 * `invalid_kind` — so it is preserved exactly rather than regrouped.
 */
function screenWorkingSetInput(
  options: ScreenWorkingSetInputOptions,
): ScreenedWorkingSetInput {
  const { input, budget, logger } = options;
  if (!WORKING_SET_ITEM_KIND_SET.has(input.kind)) {
    return { rejection: "invalid_kind" };
  }

  const content = input.content.trim();
  if (content.length === 0) {
    return { rejection: "empty_content" };
  }
  if (content.length > budget.max_item_chars) {
    return { rejection: "content_too_large" };
  }

  const metadata = input.metadata ?? {};
  const metadataChars = serializedJsonLength(metadata, logger);
  if (metadataChars === null || metadataChars > budget.max_metadata_chars) {
    return { rejection: "metadata_too_large" };
  }

  return { rejection: null, accepted: { content, metadata } };
}

interface BuildWorkingSetItemOptions {
  input: WorkingSetItemInput;
  accepted: AcceptedWorkingSetInput;
  id: string;
  now: Date;
  ttlMs: number;
}

/** Field-for-field materialization of the stored item; no policy lives here. */
function buildWorkingSetItem(
  options: BuildWorkingSetItemOptions,
): WorkingSetItem {
  const { input, accepted, id, now, ttlMs } = options;
  return {
    id,
    kind: input.kind,
    label: WORKING_SET_LABEL,
    content: accepted.content,
    confidence: input.confidence ?? null,
    stale_at: input.stale_at ?? null,
    trace_id: input.trace_id ?? null,
    source_ref: input.source_ref ?? null,
    durable_ref: input.durable_ref ?? null,
    metadata: accepted.metadata,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

export class WorkingSetStore {
  readonly budget: WorkingSetBudget;
  private readonly logger: Logger | undefined;
  private sessions = new Map<string, WorkingSetSession>();
  private counters: WorkingSetCounters = { dropped: 0, expired: 0, trimmed: 0 };
  private nextId = 1;

  constructor(options: WorkingSetStoreOptions = {}) {
    this.budget = { ...DEFAULT_WORKING_SET_BUDGET, ...options.budget };
    this.logger = options.logger;
  }

  append(
    scope: WorkingSetScope,
    input: WorkingSetItemInput,
    now: Date = new Date(),
  ): WorkingSetAppendResult {
    this.purgeExpired(now);

    const screened = screenWorkingSetInput({
      input,
      budget: this.budget,
      logger: this.logger,
    });
    if (screened.rejection !== null) {
      this.counters.dropped += 1;
      return this.rejected(screened.rejection);
    }

    const normalizedScope = normalizeWorkingSetScope(scope);
    const key = workingSetScopeKey(normalizedScope);
    const nowMs = now.getTime();
    const session = this.sessions.get(key) ?? {
      scope: normalizedScope,
      items: [],
      updated_at_ms: nowMs,
    };

    const item = buildWorkingSetItem({
      input,
      accepted: screened.accepted,
      id: input.id ?? `ws-${this.nextId++}`,
      now,
      ttlMs: this.budget.ttl_ms,
    });

    session.items.push(item);
    session.updated_at_ms = nowMs;
    this.sessions.set(key, session);
    this.trimSession(session);
    this.trimGlobal();
    this.trimSessions();

    return { accepted: true, item, counters: this.getCounters() };
  }

  /**
   * The read the context pack consumes: this scope's live items plus the
   * content-free near-miss denials, with the budget and counters that produced
   * them. Items are copied out so a caller cannot mutate store state.
   */
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
      warnings: { scope_denials: this.scopeDenialsFor(normalizedScope) },
      budget: { working_set: this.budget },
    };
  }

  getCounters(): WorkingSetCounters {
    return { ...this.counters };
  }

  private rejected(
    reason: NonNullable<WorkingSetAppendResult["reason"]>,
  ): WorkingSetAppendResult {
    return { accepted: false, reason, counters: this.getCounters() };
  }

  /** TTL eviction. Runs before every read and write so no expired item is ever observed. */
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
      if (session.items.length === 0) this.sessions.delete(key);
    }
  }

  /** Per-session overflow sheds the OLDEST items; the newest turn context survives. */
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
      if (!oldest) return;
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
      if (!oldest) return;
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
    for (const session of this.sessions.values()) count += session.items.length;
    return count;
  }

  /**
   * Near-miss lanes WITHIN the same namespace only. A different namespace is a
   * hard isolation boundary, not a near miss: reporting it would confirm that
   * another namespace holds state for this agent, which is exactly the leak the
   * boundary exists to prevent.
   */
  private scopeDenialsFor(
    requestedScope: NormalizedWorkingSetScope,
  ): WorkingSetScopeDenial[] {
    const requestedKey = workingSetScopeKey(requestedScope);
    const denials: WorkingSetScopeDenial[] = [];
    for (const [key, session] of this.sessions.entries()) {
      if (key === requestedKey) continue;
      if (session.scope.namespace !== requestedScope.namespace) continue;
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
