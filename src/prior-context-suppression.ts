import { z } from "zod";

/**
 * Prior-context suppression (#333, workstream REFLEX-2).
 *
 * Runtime-owned deterministic primitive that sits at the in-memory recall
 * handoff boundary: given the auth-derived seven-coordinate scope, the
 * extracted concept keys that produced the recall, the authorized recalled
 * items, and the explicit prior-context identifiers/references already supplied
 * to the model, return ONLY the net-new items in their original relevance
 * order.
 *
 * This module performs no retrieval, no formatting, no prompt placement, and
 * persists nothing. It never reads or compares raw turn/memory bodies and emits
 * no content telemetry. Suppression is deterministic across three identifier
 * families — canonical IDs, citation IDs, and source refs — so an item already
 * represented in prior context under any of those references is removed.
 *
 * Namespace/scope isolation is a security boundary: the scope is validated,
 * every recalled item's namespace must equal the scope namespace, and any
 * mismatch fails closed by throwing rather than silently returning a
 * cross-namespace item.
 */

/**
 * The seven exact scope coordinates, kept in lockstep with
 * `agent_context_pack.scope_keys` in src/contract.ts and the durable-lane
 * scope predicate. `thread_id` is the only nullable coordinate.
 */
export const recallScopeSchema = z
  .object({
    namespace: z.string().trim().min(1).max(200),
    agent: z.string().trim().min(1).max(200),
    platform: z.string().trim().min(1).max(200),
    server_id: z.string().trim().min(1).max(500),
    channel_id: z.string().trim().min(1).max(500),
    thread_id: z.string().trim().min(1).max(500).nullable(),
    session_key: z.string().trim().min(1).max(500),
  })
  .strict();

export type RecallScope = z.infer<typeof recallScopeSchema>;

/**
 * A structural source pointer. It is matched on identity, not body, so only the
 * stable identity-bearing coordinates are declared and canonicalized — a
 * `brain_record` source_ref is `{ source, type, id, namespace }`. Display-only
 * fields such as `label`/`preview` are deliberately NOT part of the schema: they
 * carry (bounded) content, vary with truncation, and must never influence
 * whether two references resolve to the same record. Unknown keys are stripped
 * (non-strict) so a caller passing the full emitted source_ref object still
 * matches on its identity coordinates alone.
 */
export const structuralSourceRefSchema = z
  .object({
    source: z.string().trim().min(1).max(200),
    type: z.string().trim().min(1).max(200),
    id: z.string().trim().min(1).max(500),
    namespace: z.string().trim().min(1).max(200).optional(),
  })
  .passthrough();

/**
 * The minimal identity-bearing shape a structural source_ref must carry. Typed
 * explicitly (rather than inferred from the passthrough schema) so any richer
 * emitted source_ref object — which may carry display fields like
 * `label`/`preview` — is assignable without an index-signature mismatch. Only
 * these coordinates are canonicalized; extra fields are ignored at runtime.
 */
export interface StructuralSourceRef {
  source: string;
  type: string;
  id: string;
  namespace?: string;
}

/**
 * A source_ref may be supplied either as an opaque string pointer (e.g.
 * `ob_session_events/123`) or as a structural object (e.g. the `brain_record`
 * pointer `{ source: "brain", type, id, namespace }`). Both canonicalize to a
 * single deterministic key so a string and its structural equivalent never
 * silently fail to suppress each other, and two structural refs that differ only
 * in display fields still match.
 */
export const sourceRefSchema = z.union([
  z.string().trim().min(1).max(1000),
  structuralSourceRefSchema,
]);

export type SourceRefValue = string | StructuralSourceRef;

/**
 * Deterministic canonical key for a source_ref, independent of its input shape.
 * A string ref is used verbatim; a structural ref is reduced to its ordered
 * identity coordinates only (source/type/id/namespace) so display fields and key
 * ordering never affect the key. Never derived from a record body.
 */
export function canonicalSourceRefKey(sourceRef: SourceRefValue): string {
  if (typeof sourceRef === "string") {
    return `s:${sourceRef}`;
  }
  const ns = sourceRef.namespace ?? "";
  // Join identity coordinates with the UNIT SEPARATOR control char, which a
  // trimmed non-empty string field can never contain, so no coordinate value
  // can be crafted to collide across field boundaries (e.g. an embedded delimiter).
  const sep = String.fromCharCode(0x1f);
  return `o:${sourceRef.source}${sep}${sourceRef.type}${sep}${sourceRef.id}${sep}${ns}`;
}

/**
 * The resolvable identity a recalled item and a prior-context reference are
 * matched on. At least one of the three identifier families must be present so
 * the item is addressable without inspecting its body.
 *
 * - `canonical_id`: the item's stable canonical identity (e.g. a citation id
 *   such as `session_event:123` carried as `citation_id`).
 * - `citation_id`: the citation identity emitted alongside the item, when it
 *   differs from the canonical id.
 * - `source_ref`: the structural source pointer — a string (e.g.
 *   `ob_session_events/123`) or a structural object (e.g. the `brain_record`
 *   pointer `{ source, type, id, namespace }`). Canonicalized before matching.
 */
export const recallIdentitySchema = z
  .object({
    canonical_id: z.string().trim().min(1).max(500).optional(),
    citation_id: z.string().trim().min(1).max(500).optional(),
    source_ref: sourceRefSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.canonical_id !== undefined ||
      value.citation_id !== undefined ||
      value.source_ref !== undefined,
    {
      message:
        "recall identity requires canonical_id, citation_id, or source_ref",
      path: ["canonical_id"],
    },
  );

export type RecallIdentity = z.infer<typeof recallIdentitySchema>;

/**
 * An authorized recalled item handed to the suppression boundary. It carries
 * the namespace it was recalled under (asserted against scope, fail closed),
 * its resolvable identity, and the opaque relevance-ordered payload the runtime
 * will place downstream. The payload body is never read here.
 */
export interface RecalledItem<TPayload = unknown> {
  namespace: string;
  identity: RecallIdentity;
  payload: TPayload;
}

/**
 * An explicit prior-context reference: an identifier or source ref already
 * supplied to the model in this turn. Only the resolvable identity is provided;
 * raw prior-context bodies are never accepted or compared.
 */
export const priorContextReferenceSchema = recallIdentitySchema;

export type PriorContextReference = RecallIdentity;

export interface SuppressPriorContextInput<TPayload = unknown> {
  /** Auth-derived seven-coordinate scope. Validated; namespace is the boundary. */
  scope: RecallScope;
  /** Extracted concept keys that produced this recall (carried, not matched on bodies). */
  conceptKeys: readonly string[];
  /** Authorized recalled items in original relevance order. */
  recalled: ReadonlyArray<RecalledItem<TPayload>>;
  /** Explicit prior-context identifiers/references already supplied to the model. */
  priorContext: ReadonlyArray<PriorContextReference>;
}

export interface SuppressPriorContextResult<TPayload = unknown> {
  /** The validated, canonicalized scope every downstream query must retain. */
  scope: RecallScope;
  /** Net-new recalled items, in the original relevance order. */
  items: Array<RecalledItem<TPayload>>;
  /** Content-free counters for observability. Emits no bodies. */
  suppression: {
    recalled: number;
    suppressed: number;
    net_new: number;
  };
}

/**
 * Deterministic, family-tagged suppression keys derived from a resolvable
 * identity. Keys are tagged by family so a canonical id and a source ref that
 * happen to share a string never collide, while all three families for the
 * SAME item still suppress it. Never derived from raw bodies.
 */
function suppressionKeys(identity: RecallIdentity): string[] {
  const keys: string[] = [];
  if (identity.canonical_id !== undefined) {
    keys.push(`canonical:${identity.canonical_id}`);
  }
  if (identity.citation_id !== undefined) {
    keys.push(`citation:${identity.citation_id}`);
  }
  if (identity.source_ref !== undefined) {
    keys.push(`source_ref:${canonicalSourceRefKey(identity.source_ref)}`);
  }
  return keys;
}

/**
 * Assert a recalled item belongs to the scope namespace. Fails closed: a
 * mismatched namespace throws rather than being silently dropped, so a
 * cross-namespace item can never be quietly accepted or leaked downstream.
 */
function assertItemNamespace(scope: RecallScope, item: RecalledItem): void {
  const itemNamespace = item.namespace.trim();
  if (itemNamespace !== scope.namespace) {
    throw new Error(
      "recalled item namespace does not match auth-derived scope namespace",
    );
  }
}

/**
 * Suppress prior-context items from an authorized recall, returning only
 * net-new items in original relevance order.
 *
 * Deterministic: identical inputs always yield identical output. Suppression is
 * by resolvable identity across canonical IDs, citation IDs, and source refs —
 * raw bodies are never compared. Fails closed on any recalled-item namespace
 * that does not match the scope namespace.
 */
/**
 * Build the family-tagged suppression key set from validated prior-context
 * references. Malformed references are rejected up front so a bad reference can
 * never silently fail to suppress a known prior-context item. Duplicate
 * references collapse into the set, so repeated prior references are a no-op.
 * Shared by every suppression entry point so canonicalization is identical.
 */
function buildSuppressionSet(
  priorContext: ReadonlyArray<PriorContextReference>,
): Set<string> {
  const suppressed = new Set<string>();
  for (const reference of priorContext) {
    const parsed = recallIdentitySchema.parse(reference);
    for (const key of suppressionKeys(parsed)) {
      suppressed.add(key);
    }
  }
  return suppressed;
}

export function suppressPriorContext<TPayload = unknown>(
  input: SuppressPriorContextInput<TPayload>,
): SuppressPriorContextResult<TPayload> {
  const scope = recallScopeSchema.parse(input.scope);

  const suppressed = buildSuppressionSet(input.priorContext);

  const items: Array<RecalledItem<TPayload>> = [];
  for (const item of input.recalled) {
    const identity = recallIdentitySchema.parse(item.identity);
    // Namespace boundary check runs for every item, suppressed or not, so a
    // cross-namespace item can never pass through even if it would be dropped.
    assertItemNamespace(scope, item);

    const keys = suppressionKeys(identity);
    const isPriorContext = keys.some((key) => suppressed.has(key));
    if (isPriorContext) continue;

    items.push({ namespace: item.namespace, identity, payload: item.payload });
  }

  return {
    scope,
    items,
    suppression: {
      recalled: input.recalled.length,
      suppressed: input.recalled.length - items.length,
      net_new: items.length,
    },
  };
}

/**
 * A recalled durable-memory record's resolvable identity, as emitted by the
 * `durable_memory` context-pack recall: the stable `citation_id` string and the
 * item's structural `source_ref`. Both are matched on identity only; the record
 * body is never read.
 */
export interface RecalledRecordIdentity {
  citation_id?: string;
  source_ref?: SourceRefValue;
}

export interface SuppressReferencedRecordsResult<T> {
  /** Records not represented in prior context, in original relevance order. */
  kept: T[];
  /** Content-free counters: how many were recalled, suppressed, and net-new. */
  suppression: {
    recalled: number;
    suppressed: number;
    net_new: number;
  };
}

/**
 * Deterministically remove durable-memory records already represented in prior
 * context, keyed by explicit citation ids and canonicalized source refs. This is
 * the owned integration point for the `durable_memory` recall section (#333): it
 * reuses the SAME identity families and canonicalization as
 * {@link suppressPriorContext} but operates on the recall's own record shape and
 * makes NO single-namespace assertion — durable_memory recall is bound to the
 * caller's readable namespace set by its SQL predicate, which legitimately spans
 * more than one namespace for privileged roles. Suppression is pure removal in
 * original relevance order: it can never add, reorder, or leak a record, and a
 * record with no resolvable identity is never suppressed (it is kept, since it
 * cannot be proven to be prior context).
 *
 * `identify` maps each record to its resolvable identity without exposing its
 * body to this module. Records and prior-context references canonicalize through
 * the identical key derivation, so a string source_ref, a structural source_ref,
 * and a citation id all suppress consistently.
 */
export function suppressReferencedRecords<T>(
  records: readonly T[],
  identify: (record: T) => RecalledRecordIdentity,
  priorContext: ReadonlyArray<PriorContextReference>,
): SuppressReferencedRecordsResult<T> {
  const suppressed = buildSuppressionSet(priorContext);

  const kept: T[] = [];
  for (const record of records) {
    const raw = identify(record);
    // A record must be addressable by at least one identity family to be
    // suppressible; if none is present it cannot be proven to be prior context,
    // so it is kept rather than dropped. recallIdentitySchema enforces the
    // at-least-one-family invariant and canonicalizes the source_ref shape.
    const identity: RecallIdentity | null =
      raw.citation_id !== undefined || raw.source_ref !== undefined
        ? recallIdentitySchema.parse({
            ...(raw.citation_id !== undefined
              ? { citation_id: raw.citation_id }
              : {}),
            ...(raw.source_ref !== undefined
              ? { source_ref: raw.source_ref }
              : {}),
          })
        : null;

    if (identity !== null) {
      const keys = suppressionKeys(identity);
      if (keys.some((key) => suppressed.has(key))) continue;
    }
    kept.push(record);
  }

  return {
    kept,
    suppression: {
      recalled: records.length,
      suppressed: records.length - kept.length,
      net_new: kept.length,
    },
  };
}

/**
 * The exact namespace/scope predicate every downstream recall query or request
 * must retain. Returns the seven ordered scope values and a parameterized SQL
 * predicate that binds all seven coordinates against the given column aliases.
 *
 * This is the single place that encodes "retain exact namespace/scope" so a
 * downstream query cannot accidentally widen the scope. `thread_id` uses
 * `IS NOT DISTINCT FROM` to bind null exactly, matching the durable-lane
 * predicate in agent-context-pack-durable-lane.ts.
 */
export interface ScopePredicate {
  sql: string;
  params: [string, string, string, string, string, string | null, string];
}

export function scopeQueryPredicate(
  scope: RecallScope,
  columns: {
    namespace?: string;
    agent?: string;
    platform?: string;
    server_id?: string;
    channel_id?: string;
    thread_id?: string;
    session_key?: string;
  } = {},
  startParamIndex = 1,
): ScopePredicate {
  const validated = recallScopeSchema.parse(scope);
  const namespaceCol = columns.namespace ?? "namespace";
  const agentCol = columns.agent ?? "agent";
  const platformCol = columns.platform ?? "platform";
  const serverCol = columns.server_id ?? "server_id";
  const channelCol = columns.channel_id ?? "channel_id";
  const threadCol = columns.thread_id ?? "thread_id";
  const sessionCol = columns.session_key ?? "session_key";

  const p = (offset: number): string => `$${startParamIndex + offset}`;
  const sql =
    `${namespaceCol} = ${p(0)}` +
    ` AND ${agentCol} = ${p(1)}` +
    ` AND ${platformCol} = ${p(2)}` +
    ` AND ${serverCol} = ${p(3)}` +
    ` AND ${channelCol} = ${p(4)}` +
    ` AND ${threadCol} IS NOT DISTINCT FROM ${p(5)}::text` +
    ` AND ${sessionCol} = ${p(6)}`;

  return {
    sql,
    params: [
      validated.namespace,
      validated.agent,
      validated.platform,
      validated.server_id,
      validated.channel_id,
      validated.thread_id,
      validated.session_key,
    ],
  };
}
