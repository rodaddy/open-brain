/**
 * Row post-processing applied between the SQL arms and the caller.
 *
 * Design authority: `docs/decisions/shared-kb-canonical-namespace.md` (canonical
 * vs physical namespace translation on read).
 *
 * Two transforms, both pure and both applied in exactly one place so every
 * consumer sees the same shape. `withSourceRefs` runs per arm, right where rows
 * leave the pool, because a citation must be attachable whether the row came
 * from the vector arm, the lexical arm, or fusion. `withCanonicalNamespaces`
 * runs at the outermost boundary instead: the physical namespace is what the
 * predicates and the fallback merge reason about, so translating earlier would
 * make the legacy top-up compare a canonical name against a physical one.
 */
import { canonicalNamespace } from "./shared-namespace.ts";
import type { SearchRow } from "./search-engine-types.ts";

/** Convert a timestamp-ish value to an ISO string, or `undefined`. */
function toIsoString(value: unknown): string | undefined {
  if (typeof value !== "string" && !(value instanceof Date)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Attach the resolvable `source_ref` every consumer cites from.
 *
 * Built once here rather than in each consumer so a citation emitted by
 * `brain_answer`, a pointer emitted by the context pack, and a row emitted by
 * `search_brain` all address the same record identically.
 */
export function withSourceRefs(rows: SearchRow[]): SearchRow[] {
  return rows.map((row) => ({
    ...row,
    source_ref: {
      source: "brain" as const,
      type: row.source_type,
      id: row.id,
      namespace: row.namespace,
      created_by: row.created_by,
      created_at: toIsoString(row.created_at),
      last_updated_at:
        toIsoString(row.updated_at) ?? toIsoString(row.created_at),
      label: (row.content_preview ?? "").slice(0, 120),
      preview: (row.content_preview ?? "").slice(0, 300),
    },
  }));
}

/** Report the canonical shared name on emitted rows and their source refs. */
export function withCanonicalNamespaces(rows: SearchRow[]): SearchRow[] {
  return rows.map((row) => ({
    ...row,
    namespace: row.namespace
      ? canonicalNamespace(row.namespace)
      : row.namespace,
    source_ref: row.source_ref
      ? {
          ...row.source_ref,
          namespace: row.source_ref.namespace
            ? canonicalNamespace(row.source_ref.namespace)
            : row.source_ref.namespace,
        }
      : row.source_ref,
  }));
}
