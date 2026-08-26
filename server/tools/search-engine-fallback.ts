/**
 * The legacy-namespace top-up layered over a completed search.
 *
 * Design authority: `docs/decisions/shared-kb-canonical-namespace.md` and #167
 * (which retired `collab`, so `legacySharedNamespace` is empty and none of this
 * runs unless an operator has explicitly configured a migration source).
 *
 * This module owns the MERGE, not the queries. It takes two already-fetched row
 * sets -- canonical and legacy -- and decides which survive, so the decision is
 * testable without a pool and the orchestrator stays a dispatcher. Canonical
 * rows always win a content collision; the one deliberate exception is at the
 * top of {@link selectedFallbackRows}.
 */
import { traceRetrievalSpanSync } from "../observability/langfuse-tracing.ts";
import {
  rowEvidence,
  rowsEvidence,
  type SearchRow,
} from "./search-engine-types.ts";

/** Dedupe key used when topping up from the legacy namespace. */
export function fallbackDedupeKey(row: SearchRow): string {
  const preview = row.content_preview?.replace(/\s+/g, " ").trim();
  // Migrated rows carry NEW ids in the canonical namespace, so identity cannot
  // dedupe them against their legacy originals. Content does.
  return preview
    ? `${row.source_type}:content:${preview}`
    : `${row.source_type}:id:${row.id}`;
}

/** Drop repeats, keeping the highest-ranked occurrence of each record. */
function dedupeFallbackRows(rows: readonly SearchRow[]): SearchRow[] {
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

/**
 * Merge canonical results with legacy top-up results.
 *
 * Canonical rows always win a content collision. When canonical already fills
 * the limit but legacy found something canonical did not, one canonical row is
 * displaced so the caller can SEE that unmigrated content exists -- a silent
 * omission is what makes a stalled migration invisible.
 */
type FallbackClassification = {
  row: SearchRow;
  chosen: boolean;
  filtered_by: "fallback_duplicate" | "fallback_limit" | null;
};

function selectedFallbackRows(
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

function fallbackFilteredBy(
  chosen: boolean,
  duplicate: boolean,
): FallbackClassification["filtered_by"] {
  if (chosen) return null;
  return duplicate ? "fallback_duplicate" : "fallback_limit";
}

function computeFallbackRows(
  primaryRows: readonly SearchRow[],
  legacyRows: readonly SearchRow[],
  limit: number,
): { rows: SearchRow[]; classifications: FallbackClassification[] } {
  const primary = dedupeFallbackRows(primaryRows);
  const primaryKeys = new Set(primary.map(fallbackDedupeKey));
  const legacy = dedupeFallbackRows(
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

export function mergeFallbackRows(
  primaryRows: readonly SearchRow[],
  legacyRows: readonly SearchRow[],
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
    run: () => computeFallbackRows(primaryRows, legacyRows, limit),
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
