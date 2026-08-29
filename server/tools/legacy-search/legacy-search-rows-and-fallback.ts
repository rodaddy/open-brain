import { canonicalNamespace } from "../../../src/shared-namespace.ts";
import type { LinkRelation, Table } from "../../../src/types.ts";
import { traceRetrievalSpanSync } from "../../observability/langfuse-tracing.ts";
import { type NamespaceFilter } from "./legacy-search-tables-and-parsing.ts";
export function recencyFactor(createdAt: string): number {
  const ms = new Date(createdAt).getTime();
  if (isNaN(ms)) return 1.0;
  const ageDays = (Date.now() - ms) / (1000 * 60 * 60 * 24);
  return 1 / (1 + Math.max(0, ageDays) * 0.001);
}

export interface ExplicitLink {
  id: string;
  direction: "outgoing" | "incoming";
  relation: LinkRelation;
  weight: number;
  linked_type: string;
  linked_id: string;
  linked_name?: string | null;
  canonical_id?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SourceRef {
  source: "brain";
  type: string;
  id: string;
  namespace?: string;
  created_by?: string | null;
  created_at?: string;
  last_updated_at?: string;
  label: string;
  preview: string;
}

export interface SearchRow {
  source_type: string;
  id: string;
  namespace?: string;
  content_preview: string | null;
  tags: string[] | null;
  created_by?: string | null;
  created_at: string;
  updated_at?: string | null;
  usefulness: number;
  tier?: string;
  distance?: number;
  fts_rank?: number;
  access_count?: number;
  explicit_links?: ExplicitLink[];
  source_ref?: SourceRef;
  extracted_metadata?: {
    topics?: string[];
    people?: string[];
    action_items?: string[];
    dates?: string[];
    // Deterministic, content-free structural keys the write-time extractor
    // emits alongside the semantic fields. The digest, algorithm tag, and byte
    // length reveal no source excerpt.
    content_hash?: string;
    hash_version?: string;
    byte_length?: number;
  };
}

export function rowEvidence(row: SearchRow): Record<string, unknown> {
  return {
    row_id: row.id,
    source_type: row.source_type,
    namespace: row.namespace ?? null,
    content_preview: row.content_preview ?? null,
    distance: row.distance ?? null,
    similarity: row.distance === undefined ? null : 1 - row.distance,
    bm25_score: row.fts_rank ?? null,
    usefulness: row.usefulness,
    tier: row.tier ?? null,
  };
}

export function rowsEvidence(rows: readonly SearchRow[]): Record<string, unknown> {
  return {
    count: rows.length,
    row_ids: rows.map((row) => row.id),
    candidates: rows.map(rowEvidence),
  };
}

export function rowIdsEvidence(rows: readonly SearchRow[]): Record<string, unknown> {
  return { count: rows.length, row_ids: rows.map((row) => row.id) };
}

export const HAS_EXTRACTED_METADATA: Set<Table> = new Set(["thoughts", "decisions"]);

export type LinkRow = {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relation: LinkRelation;
  weight: number;
  metadata: Record<string, unknown>;
  created_at: string;
  from_name: string | null;
  from_canonical_id: string | null;
  to_name: string | null;
  to_canonical_id: string | null;
};

export function linkKey(type: string, id: string): string {
  return `${type}:${id}`;
}

export function toIsoString(value: unknown): string | undefined {
  if (typeof value !== "string" && !(value instanceof Date)) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

export function withSourceRefs(rows: SearchRow[]): SearchRow[] {
  return rows.map((row) => ({
    ...row,
    source_ref: {
      source: "brain",
      type: row.source_type,
      id: row.id,
      namespace: row.namespace,
      created_by: row.created_by,
      created_at: toIsoString(row.created_at),
      last_updated_at: toIsoString(row.updated_at) ?? toIsoString(row.created_at),
      label: (row.content_preview ?? "").slice(0, 120),
      preview: (row.content_preview ?? "").slice(0, 300),
    },
  }));
}

export function withCanonicalNamespaces(rows: SearchRow[]): SearchRow[] {
  return rows.map((row) => {
    const namespace = row.namespace ? canonicalNamespace(row.namespace) : row.namespace;
    return {
      ...row,
      namespace,
      source_ref: row.source_ref
        ? {
            ...row.source_ref,
            namespace: row.source_ref.namespace
              ? canonicalNamespace(row.source_ref.namespace)
              : row.source_ref.namespace,
          }
        : row.source_ref,
    };
  });
}

export function dedupeSearchRows(rows: SearchRow[]): SearchRow[] {
  const seen = new Set<string>();
  const deduped: SearchRow[] = [];
  for (const row of rows) {
    const key = `${row.source_type}:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

export function fallbackDedupeKey(row: SearchRow): string {
  const preview = row.content_preview?.replace(/\s+/g, " ").trim();
  if (preview) {
    return `${row.source_type}:content:${preview}`;
  }
  return `${row.source_type}:id:${row.id}`;
}

export function dedupeFallbackSearchRows(rows: SearchRow[]): SearchRow[] {
  const seen = new Set<string>();
  const deduped: SearchRow[] = [];
  for (const row of rows) {
    const key = fallbackDedupeKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

export type FallbackClassification = {
  row: SearchRow;
  chosen: boolean;
  filtered_by: "fallback_duplicate" | "fallback_limit" | null;
};

export function selectedFallbackRows(
  primary: SearchRow[],
  legacy: SearchRow[],
  limit: number,
): SearchRow[] {
  if (legacy.length === 0) return primary.slice(0, limit);
  const firstLegacy = legacy[0];
  if (!firstLegacy) return primary.slice(0, limit);
  if (primary.length >= limit) {
    return [...primary.slice(0, Math.max(0, limit - 1)), firstLegacy];
  }
  return [...primary, ...legacy.slice(0, limit - primary.length)];
}

export function fallbackFilteredBy(
  chosen: boolean,
  duplicate: boolean,
): FallbackClassification["filtered_by"] {
  if (chosen) return null;
  return duplicate ? "fallback_duplicate" : "fallback_limit";
}

export function computeFallbackSearchRows(
  primaryRows: SearchRow[],
  legacyRows: SearchRow[],
  limit: number,
): { rows: SearchRow[]; classifications: FallbackClassification[] } {
  const primary = dedupeFallbackSearchRows(primaryRows);
  const primaryKeys = new Set(primary.map(fallbackDedupeKey));
  const legacy = dedupeFallbackSearchRows(
    legacyRows.filter((row) => !primaryKeys.has(fallbackDedupeKey(row))),
  );
  const rows = selectedFallbackRows(primary, legacy, limit);
  const selectedKeys = new Set(rows.map(fallbackDedupeKey));
  const seen = new Set<string>();
  const classifications = [...primaryRows, ...legacyRows].map((row, index) => {
    const key = fallbackDedupeKey(row);
    const duplicate =
      seen.has(key) || (index >= primaryRows.length && primaryKeys.has(key));
    seen.add(key);
    const chosen = !duplicate && selectedKeys.has(key);
    return {
      row,
      chosen,
      filtered_by: fallbackFilteredBy(chosen, duplicate),
    } satisfies FallbackClassification;
  });
  return { rows, classifications };
}

export function mergeFallbackSearchRows(
  primaryRows: SearchRow[],
  legacyRows: SearchRow[],
  limit: number,
): SearchRow[] {
  const result = traceRetrievalSpanSync({
    name: "retrieval.fallback_dedupe",
    input: {
      limit,
      primary: rowsEvidence(primaryRows),
      legacy: rowsEvidence(legacyRows),
    },
    metadata: {
      stage: "filtering",
      filter_names: ["fallback_duplicate", "fallback_limit"],
    },
    run: () => computeFallbackSearchRows(primaryRows, legacyRows, limit),
    output: ({ rows, classifications }) => ({
      candidate_count: classifications.length,
      selected_count: rows.length,
      selected_row_ids: rows.map((row) => row.id),
      candidates: classifications.map(({ row, chosen, filtered_by }) => ({
        ...rowEvidence(row),
        chosen,
        filtered_by,
      })),
    }),
  });
  return result.rows;
}

export function appendNamespaceParam(
  params: unknown[],
  namespace?: NamespaceFilter,
): number | undefined {
  if (namespace === undefined) return undefined;
  params.push(namespace);
  return params.length;
}

export function paramRef(index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`Invalid SQL parameter index: ${index}`);
  }
  return `$${index}`;
}
