/**
 * The shared vocabulary of the retrieval engine: row shapes, tuning constants,
 * and the trace-evidence shapers every arm emits.
 *
 * Design authority: #327 (durable-memory recall is one hybrid stack, not one per
 * consumer). These declarations live apart from `search-engine.ts` so the SQL
 * builders, the row post-processors, and the fallback merge can all name the
 * same `SearchRow` without importing the orchestrator and creating a cycle.
 *
 * Nothing here executes a query or touches a pool. The evidence shapers are
 * pure projections of a row into the flat record a trace span records, and they
 * are shared rather than re-derived per arm so a candidate logged by the vector
 * arm and the same candidate logged by fusion carry identical field names.
 */
import type { Logger } from "pino";
import type { Pool } from "pg";
import type { ResourceTable } from "../auth/types.ts";
import type { FtsConfig } from "./fts-config.ts";
import type { SharedNamespaceConfig } from "./shared-namespace.ts";

export type SearchMode = "hybrid" | "vector" | "keyword";

/** Over-fetch factor per arm in hybrid mode; fusion needs depth to reorder. */
export const HYBRID_FETCH_MULTIPLIER = 3;
/** Default ceiling on how long the embedding provider may hold up a search. */
export const DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS = 3000;

/** Vector-mode ranking weights: similarity dominates, usefulness and age nudge. */
export const VECTOR_WEIGHT = 0.7;
export const USEFULNESS_WEIGHT = 0.15;
export const AGE_WEIGHT = 0.0001;

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
  source_ref?: SourceRef;
  extracted_metadata?: Record<string, unknown>;
}

export interface SearchDependencies {
  readonly pool: Pool;
  readonly embedFn: (text: string) => Promise<number[] | null>;
  readonly logger: Logger;
  /**
   * Milliseconds the query-embedding call may take before the search degrades.
   *
   * From `config.search.embeddingTimeoutMs`. Absent means the engine answers
   * {@link DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS}, which is what an unset
   * environment produced when this was read here directly.
   */
  readonly searchEmbeddingTimeoutMs?: number;
  /** Validated shared-namespace names; env-derived when absent. */
  readonly sharedNamespaceNames?: SharedNamespaceConfig;
}

export interface ExecuteSearchOptions {
  /** Text-search configuration for the lexical arm; english when unset. */
  readonly ftsConfig?: FtsConfig;
}

/**
 * A source the search arms can read.
 *
 * `ResourceTable` is the PHYSICAL-table union: it drives `PERMISSIONS`, the
 * REST enum, and every write path, so widening it would demand a permission
 * row and a write contract for a corpus that has neither. `session_events` is
 * a read-only retrieval source instead -- searchable here, never written
 * through this surface -- and carries its own CTE builders because its
 * columns do not match the shared shape.
 */
export type SearchSource = ResourceTable | "session_events";

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

export function rowsEvidence(
  rows: readonly SearchRow[],
): Record<string, unknown> {
  return {
    count: rows.length,
    row_ids: rows.map((row) => row.id),
    candidates: rows.map(rowEvidence),
  };
}

export function rowIdsEvidence(
  rows: readonly SearchRow[],
): Record<string, unknown> {
  return { count: rows.length, row_ids: rows.map((row) => row.id) };
}
