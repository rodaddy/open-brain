/**
 * Retrieval and traced citation-filtering for `brain_answer`.
 *
 * Extracted from `brain-answer.ts` (#780). The Langfuse span here is the reason
 * the split exists: the filter's input, metadata, and per-candidate output are
 * verbose enough to dominate the tool handler, while the decision they describe
 * — which retrieved rows are safe to cite — is a single call to
 * `selectEvidence`. Keeping the span next to that call keeps the observability
 * shape and the selection it observes in one place.
 */
import { traceRetrievalSpanSync } from "../observability/langfuse-tracing.ts";
import {
  executeSearchWithSharedFallback,
  type SearchMode,
  type SearchRow,
  type SearchSource,
} from "./search-engine.ts";
import { selectEvidence, type EvidenceSelection } from "./answer-evidence.ts";
import type { MemoryToolDependencies } from "./types.ts";
import type { NamespaceFilter } from "./read-scope.ts";
import type { Tier } from "./search-constants.ts";

/** The retrieval-relevant fields of a resolved `brain_answer` request. */
interface RetrievalRequest {
  query: string;
  limit: number;
  mode: SearchMode;
  tier: Tier | undefined;
  namespace: NamespaceFilter | undefined;
  tables: readonly SearchSource[];
}

/**
 * Run the shared recall stack for one resolved request.
 *
 * @throws Whatever the search engine throws; the caller maps it to an error
 * result rather than an empty citation list.
 */
export function retrieveAnswerRows(
  dependencies: MemoryToolDependencies,
  request: RetrievalRequest,
  options: { shared: boolean },
): Promise<SearchRow[]> {
  return executeSearchWithSharedFallback(
    dependencies,
    request.tables,
    request.query,
    request.limit,
    request.mode,
    request.tier,
    0,
    request.namespace,
    {},
    options.shared,
  );
}

/** Select citable evidence from retrieved rows, recording the choice as a span. */
export function selectCitableEvidence(rows: SearchRow[]): EvidenceSelection {
  return traceRetrievalSpanSync({
    name: "retrieval.citation_filter",
    input: {
      candidate_count: rows.length,
      candidates: rows.map((row) => ({
        row_id: row.id,
        source_type: row.source_type,
        namespace: row.namespace ?? null,
        content_preview: row.content_preview,
        distance: row.distance ?? null,
        similarity: row.distance === undefined ? null : 1 - row.distance,
        bm25_score: row.fts_rank ?? null,
      })),
    },
    metadata: {
      stage: "filtering",
      filter_names: ["missing_source_ref", "empty_excerpt"],
    },
    run: () => selectEvidence(rows),
    output: ({ evidence }) => {
      const selected = new Set(evidence.map((item) => item.row.id));
      return {
        selected_count: evidence.length,
        selected_row_ids: evidence.map((item) => item.row.id),
        candidates: rows.map((row) => {
          const chosen = selected.has(row.id);
          let filteredBy: string | null = null;
          if (!chosen) {
            filteredBy = row.source_ref
              ? "empty_excerpt"
              : "missing_source_ref";
          }
          return { row_id: row.id, chosen, filtered_by: filteredBy };
        }),
      };
    },
  });
}
