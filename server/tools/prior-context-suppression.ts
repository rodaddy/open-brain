/**
 * Prior-context suppression (#333).
 *
 * Deterministic primitive at the recall handoff boundary: given the authorized
 * recalled records and the explicit references already supplied to the model
 * this turn, return only the NET-NEW records, in their original relevance
 * order.
 *
 * Two properties make this safe to run between retrieval and budgeting:
 *
 *   1. It is PURE REMOVAL. It can never add a record, reorder the survivors, or
 *      widen the set. That is what lets the pack run it BEFORE the char budget
 *      selects bodies — the surviving order, item selection, citations, and
 *      budget accounting then all reconcile against net-new results only,
 *      instead of budgeting for records that were about to be dropped.
 *
 *   2. It matches on RESOLVABLE IDENTITY, never on bodies. Raw prior-context
 *      text is not accepted and record bodies are not read or compared. A record
 *      that carries no resolvable identity is KEPT, because it cannot be proven
 *      to be prior context — the failure direction is "show it twice", never
 *      "silently drop something the caller never saw".
 *
 * Identity canonicalization is shared by both sides, so a citation id, a string
 * source_ref, and the structural source_ref object for the SAME record all
 * suppress each other consistently.
 */
import { z } from "zod";

/**
 * A structural source pointer, matched on identity rather than body.
 *
 * Display fields (`label`, `preview`) are deliberately absent from the schema:
 * they carry bounded content, they change with truncation, and letting them
 * influence matching would mean the same record failed to suppress itself
 * whenever a preview was cut at a different length. Unknown keys pass through
 * and are ignored, so a caller can echo back an emitted source_ref verbatim.
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
 * explicitly rather than inferred from the passthrough schema, so a richer
 * emitted source_ref (which may carry display fields) stays assignable without
 * an index-signature mismatch.
 */
export interface StructuralSourceRef {
  source: string;
  type: string;
  id: string;
  namespace?: string;
}

/** A source_ref may be an opaque string pointer or the structural object. */
export const sourceRefSchema = z.union([
  z.string().trim().min(1).max(1000),
  structuralSourceRefSchema,
]);

export type SourceRefValue = string | StructuralSourceRef;

/**
 * Deterministic canonical key for a source_ref, independent of input shape.
 *
 * The identity coordinates are joined with the UNIT SEPARATOR control character
 * (0x1F), which a trimmed non-empty string field can never contain. That is not
 * decoration: with an ordinary delimiter like `:` a crafted id could span a
 * field boundary and collide with a different record's key.
 */
export function canonicalSourceRefKey(sourceRef: SourceRefValue): string {
  if (typeof sourceRef === "string") return `s:${sourceRef}`;
  const ns = sourceRef.namespace ?? "";
  const sep = String.fromCharCode(0x1f);
  return `o:${sourceRef.source}${sep}${sourceRef.type}${sep}${sourceRef.id}${sep}${ns}`;
}

/**
 * The resolvable identity a record and a prior-context reference match on. At
 * least one family must be present, so the reference is addressable without
 * anyone inspecting a body.
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

export type PriorContextReference = RecallIdentity;

/**
 * Family-TAGGED suppression keys. The tag matters: without it a canonical id and
 * a source_ref that happen to be the same string would collide across families,
 * while all three families for the same record still need to suppress it.
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
 * Build the suppression key set from validated references.
 *
 * Malformed references are REJECTED here rather than skipped, because a
 * reference that silently fails to parse is a reference that silently fails to
 * suppress — the caller would be handed a record it had already been given and
 * would have no signal that anything went wrong. Duplicates collapse into the
 * set, so repeating a reference is a harmless no-op.
 */
function buildSuppressionSet(
  priorContext: ReadonlyArray<PriorContextReference>,
): Set<string> {
  const suppressed = new Set<string>();
  for (const reference of priorContext) {
    const parsed = recallIdentitySchema.parse(reference);
    for (const key of suppressionKeys(parsed)) suppressed.add(key);
  }
  return suppressed;
}

/** A recalled record's resolvable identity, as the durable_memory recall emits it. */
export interface RecalledRecordIdentity {
  citation_id?: string;
  source_ref?: SourceRefValue;
}

export interface SuppressReferencedRecordsResult<T> {
  /** Records not represented in prior context, in original relevance order. */
  kept: T[];
  /** Content-free counters. Counts only — never an id, a reference, or a body. */
  suppression: {
    recalled: number;
    suppressed: number;
    net_new: number;
  };
}

/**
 * Remove durable-memory records already represented in prior context.
 *
 * This makes NO single-namespace assertion, deliberately: the durable_memory
 * recall is bound to the caller's readable namespace SET by its SQL predicate,
 * which legitimately spans more than one namespace for a privileged role.
 * Isolation is enforced by that predicate, upstream of here; re-asserting a
 * single namespace at this layer would break privileged recall while adding no
 * security the query does not already provide.
 *
 * `identify` maps a record to its identity without exposing its body to this
 * module.
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
    // No identity family present means the record is not addressable and cannot
    // be PROVEN to be prior context, so it is kept rather than dropped.
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
