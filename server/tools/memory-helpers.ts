import { createHash } from "node:crypto";
import { toSql } from "pgvector/pg";
import { canTargetNamespace } from "../auth/namespace-policy.ts";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import { canRead, canWrite } from "../auth/permissions.ts";
import type { MemoryToolDependencies } from "./types.ts";
import { errorResult } from "./types.ts";

/**
 * The session-event vocabulary, re-exported from the single existing declaration.
 *
 * This file previously hand-copied the nine event types and three importance
 * levels. That made it an EIGHTH redeclaration of a frozen cross-language
 * vocabulary, and `python/openbrain-memory/tests/test_event_vocabulary.py`
 * (`test_vocabulary_is_declared_exactly_where_expected`) failed on it by design
 * -- the guard exists precisely to stop a new copy appearing where no
 * per-surface drift test watches it.
 *
 * Adding this file to the guard's `known` set was the wrong fix: the guard is a
 * census, and silencing it would have kept the copy while removing the alarm.
 * The vocabulary is authoritative in Python (`openbrain_memory.EVENT_TYPES`) and
 * mirrored in exactly the surfaces that have their own equality tests. The
 * rewrite needs no new mirror -- it needs the one `src/` already declares, which
 * `src/tools/append-session-event.ts` consumes the same way. Re-exporting keeps
 * `z.enum(EVENT_TYPES)` in `session-events.ts` byte-identical in behavior while
 * collapsing two declarations back to one.
 *
 * This is the same cross-boundary reuse the rest of this wave already does
 * (`server/tools/repo-facts.ts`, `get-contract.ts`, `promotion.ts` all import
 * their builders from `src/`), so it introduces no new coupling direction.
 */
export { EVENT_TYPES, IMPORTANCE_LEVELS } from "../../src/tools/table-constants.ts";

export function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function decisionText(input: {
  title: string;
  rationale: string;
  context?: string;
  alternatives?: string[];
  tags?: string[];
}): string {
  const parts = [input.title, input.rationale];
  if (input.context) parts.push(input.context);
  if (input.alternatives?.length) parts.push(input.alternatives.join(", "));
  if (input.tags?.length) parts.push([...new Set(input.tags)].sort().join(" "));
  return parts.join("\n");
}

export function sessionEmbedText(input: {
  summary: string;
  key_decisions?: string[];
  next_steps?: string[];
  blockers?: string[];
}): string {
  const parts = [input.summary];
  if (input.key_decisions?.length) parts.push(input.key_decisions.join(". "));
  if (input.next_steps?.length) parts.push(input.next_steps.join(". "));
  if (input.blockers?.length) parts.push(input.blockers.join(". "));
  return parts.join("\n");
}

export async function embeddingFields(
  dependencies: MemoryToolDependencies,
  text: string,
): Promise<{
  embedding: ReturnType<typeof toSql> | null;
  embeddedAt: string | null;
  model: string | null;
  embedded: boolean;
}> {
  const embedding = await dependencies.embedFn(text);
  return {
    embedding: embedding ? toSql(embedding) : null,
    embeddedAt: embedding ? new Date().toISOString() : null,
    model: embedding ? (dependencies.embeddingModel ?? null) : null,
    embedded: embedding !== null,
  };
}

/**
 * Outcome of the auth gate every memory tool runs before touching the pool.
 *
 * The union is deliberately total: a handler either receives a proven identity
 * plus a resolved namespace, or a ready-to-return denial envelope. There is no
 * third state, so no handler can reach SQL with an unauthenticated caller or an
 * unresolved namespace.
 */
export type Authorization =
  | { readonly ok: true; readonly identity: AuthIdentity; readonly namespace: string }
  | { readonly ok: false; readonly response: ReturnType<typeof errorResult> };

/**
 * Resolve the auth-derived namespace for a tool call, or deny it.
 *
 * Order matters and is observed current-src behavior: the role/table permission
 * is checked first so an unprivileged caller never learns whether a namespace
 * exists, then the requested namespace is checked against the token identity.
 *
 * Design authority: `docs/identity-boundary.md` (token-derived identity) and
 * `docs/decisions/privilege-isolation-closed-brain.md` (server-side isolation).
 *
 * @param identity Token-derived identity, or `undefined` when unauthenticated.
 * @param operation Whether the caller intends to read or write.
 * @param table Resource table the permission matrix is consulted for.
 * @param permissionMessage Observed current-src denial suffix for this tool.
 * @param requestedNamespace Caller-supplied namespace; defaults to the token's.
 * @returns The proven identity and namespace, or the denial envelope to return.
 */
export function authorize(
  identity: AuthIdentity | undefined,
  operation: "read" | "write",
  table: ResourceTable,
  permissionMessage: string,
  requestedNamespace?: string,
): Authorization {
  const permitted =
    identity !== undefined &&
    (operation === "read" ? canRead(identity.role, table) : canWrite(identity.role, table));
  if (!identity || !permitted) {
    return { ok: false, response: errorResult(`Permission denied: ${permissionMessage}`) };
  }
  const namespace = requestedNamespace ?? identity.clientId;
  if (!canTargetNamespace(identity, operation, namespace)) {
    const reason =
      operation === "write"
        ? `${identity.role} role cannot write to namespace '${namespace}'`
        : `cannot read namespace '${namespace}'`;
    return { ok: false, response: errorResult(`Permission denied: ${reason}`) };
  }
  return { ok: true, identity, namespace };
}
