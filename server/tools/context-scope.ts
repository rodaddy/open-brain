/**
 * The seven-coordinate scope every realtime context section is keyed by.
 *
 * Design authority: #326/#330 (the context pack's exact-scope requirement).
 *
 * WHY SEVEN COORDINATES AND WHY ALL OF THEM MUST MATCH. `working_set` and
 * `recovery` are NOT durable memory and are NOT searchable recall: they are the
 * live state of one conversation. Bleeding one conversation's live state into
 * another is not a relevance error, it is a correctness error — the model would
 * be told that something happened in "this" turn that happened somewhere else
 * entirely. So these sections match on the exact tuple or they return nothing;
 * there is deliberately no partial-match or nearest-scope fallback.
 *
 * `thread_id` is the one nullable coordinate, and null is a real value rather
 * than a wildcard: an unthreaded conversation is a DIFFERENT scope from a
 * threaded one in the same channel, not a parent of it.
 */
import { createHash } from "node:crypto";

/** Scope as supplied by a caller; `thread_id` may be absent or null. */
export interface ContextScopeInput {
  namespace: string;
  agent: string;
  platform: string;
  server_id: string;
  channel_id: string;
  thread_id?: string | null;
  session_key: string;
}

/** Scope after normalization; `thread_id` is explicitly null when unthreaded. */
export interface ContextScope {
  namespace: string;
  agent: string;
  platform: string;
  server_id: string;
  channel_id: string;
  thread_id: string | null;
  session_key: string;
}

/** The coordinates compared when deciding whether two scopes are the same. */
export const CONTEXT_SCOPE_FIELDS = [
  "namespace",
  "agent",
  "platform",
  "server_id",
  "channel_id",
  "thread_id",
  "session_key",
] as const;

/** Reject a blank coordinate rather than keying a scope on empty text. */
function requireScopePart(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`context scope requires non-empty ${field}`);
  }
  return trimmed;
}

/**
 * Normalize a caller-supplied scope.
 *
 * Trimming happens HERE, once, so `"rico"` and `"rico "` cannot become two
 * scopes that each hold half of one conversation's state.
 */
export function normalizeContextScope(scope: ContextScopeInput): ContextScope {
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
 * Stable map key for a scope.
 *
 * A JSON array rather than a delimiter join: a coordinate containing the
 * delimiter would otherwise let two different scopes produce one key, which is
 * exactly the cross-conversation bleed this module exists to prevent.
 */
export function contextScopeKey(scope: ContextScopeInput): string {
  const normalized = normalizeContextScope(scope);
  return JSON.stringify(CONTEXT_SCOPE_FIELDS.map((field) => normalized[field]));
}

/**
 * Short digest identifying a scope in a warning WITHOUT naming it.
 *
 * A scope denial has to say "some other conversation exists here" without
 * disclosing whose. The hash is the identity-free way to say that, so a caller
 * can correlate repeated denials without learning another scope's coordinates.
 */
export function contextScopeHash(scope: ContextScopeInput): string {
  return createHash("sha256")
    .update(contextScopeKey(scope))
    .digest("hex")
    .slice(0, 16);
}

/** @returns The coordinates on which two scopes differ; empty means identical. */
export function compareContextScope(
  left: ContextScopeInput,
  right: ContextScopeInput,
): Array<(typeof CONTEXT_SCOPE_FIELDS)[number]> {
  const a = normalizeContextScope(left);
  const b = normalizeContextScope(right);
  return CONTEXT_SCOPE_FIELDS.filter((field) => a[field] !== b[field]);
}
