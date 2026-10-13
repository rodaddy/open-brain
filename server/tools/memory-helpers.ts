import { toSql } from "pgvector/pg";
import { canTargetNamespace } from "../auth/namespace-policy.ts";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import { canRead, canWrite } from "../auth/permissions.ts";
import type { MemoryToolDependencies } from "./types.ts";
import { errorResult } from "./types.ts";

/**
 * The session-event vocabulary, re-exported from the single existing
 * declaration. A hand-copied vocabulary here was an eighth redeclaration of a
 * frozen cross-language vocabulary, and the Python census test failed on it by
 * design.
 *
 * See docs/decisions/memory-helpers-vocabulary-is-re-exported-not-recopied.md
 */
export { EVENT_TYPES, IMPORTANCE_LEVELS } from "../db/table-constants.ts";

/**
 * Re-exported so this module's importers stay unchanged. The single definition
 * — and the reason its output may never drift — lives in
 * `server/db/content-hash.ts`.
 */
export { contentHash } from "../db/content-hash.ts";

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
  // `toSql` is untyped in pgvector, so `ReturnType<typeof toSql>` is `any` and
  // swallows the `| null` beside it. It returns the SQL vector literal for the
  // array form used here (`node_modules/pgvector/src/utils/index.js:47-51`),
  // so the honest annotation is the one the call site actually produces.
  embedding: string | null;
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
  | {
      readonly ok: true;
      readonly identity: AuthIdentity;
      readonly namespace: string;
    }
  | { readonly ok: false; readonly response: ReturnType<typeof errorResult> };

/**
 * What a tool is asking permission to do.
 *
 * The three permission-matrix fields travel together at every one of the
 * seventeen call sites -- `operation` selects `canRead`/`canWrite`, `table` is
 * the row that matrix is indexed by, and `permissionMessage` is the denial
 * suffix observed in current src for that specific tool. Bundling them keeps
 * `authorize` at two parameters without splitting a triple that is never
 * partially supplied.
 */
export interface AuthorizationRequest {
  /** Whether the caller intends to read or write. */
  readonly operation: "read" | "write";
  /** Resource table the permission matrix is consulted for. */
  readonly table: ResourceTable;
  /** Observed current-src denial suffix for this tool. */
  readonly permissionMessage: string;
  /** Caller-supplied namespace; defaults to the token's own. */
  readonly requestedNamespace?: string;
}

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
 * @param request What the caller is asking permission to do.
 * @returns The proven identity and namespace, or the denial envelope to return.
 */
export function authorize(
  identity: AuthIdentity | undefined,
  request: AuthorizationRequest,
): Authorization {
  const { operation, table, permissionMessage, requestedNamespace } = request;
  const permitted =
    identity !== undefined &&
    (operation === "read"
      ? canRead(identity.role, table)
      : canWrite(identity.role, table));
  if (!identity || !permitted) {
    return {
      ok: false,
      response: errorResult(`Permission denied: ${permissionMessage}`),
    };
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
