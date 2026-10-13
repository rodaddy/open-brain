/**
 * The legacy-namespace top-up for a request scoped to a LIST of namespaces
 * (ported for issue 841 cut 1). Why it is a separate module, why it probes the
 * shared namespace on its own instead of gating on the primary result count,
 * and why it refuses to paginate:
 *
 * See docs/decisions/search-engine-scoped-fallback-separate-module-and-probe.md
 */
import { executeSearch } from "./search-engine.ts";
import { mergeFallbackRows } from "./search-engine-fallback.ts";
import { attachExplicitLinks } from "./search-engine-links.ts";
import { withCanonicalNamespaces } from "./search-engine-rows.ts";
import { sharedNamespaceConfig } from "./shared-namespace.ts";
import type { Tier } from "./search-constants.ts";
import type { NamespaceFilter } from "../domain/read-scope.ts";
import type {
  ExecuteSearchOptions,
  SearchDependencies,
  SearchMode,
  SearchRow,
  SearchSource,
} from "./search-engine-types.ts";

/** One scoped search, named rather than positional. */
export interface ScopedSharedFallbackRequest {
  readonly dependencies: SearchDependencies;
  readonly tables: readonly SearchSource[];
  readonly query: string;
  readonly limit: number;
  readonly mode?: SearchMode;
  readonly tier?: Tier;
  readonly offset?: number;
  /** The caller's readable set; the top-up is only reachable when it is a list. */
  readonly namespace?: NamespaceFilter;
  readonly options?: ExecuteSearchOptions;
}

/**
 * Whether the legacy top-up is reachable for this request at all.
 *
 * Four independent reasons to skip it, kept together so the entry below reads
 * as one decision: no migration source is configured, the operator has not
 * enabled the top-up, the request paginates, or the shared namespace is simply
 * not in the caller's scope.
 */
function scopedFallbackApplies(
  request: ScopedSharedFallbackRequest,
  config: ReturnType<typeof sharedNamespaceConfig>,
): boolean {
  if (!config.legacyFallbackEnabled) return false;
  if (config.legacySharedNamespace === "") return false;
  if ((request.offset ?? 0) !== 0) return false;
  const scoped = Array.isArray(request.namespace) ? request.namespace : [];
  return scoped.includes(config.physicalSharedNamespace);
}

/**
 * Search the caller's scope, topping up from the legacy namespace when the
 * shared namespace alone came back thin.
 *
 * EXPLICIT LINKS. This entry is one of the two surfaces the legacy REST route
 * used, and legacy attached `explicit_links` as the last shaping step of its
 * core execute (issue 841 cut 2, D3). Every return path therefore hydrates the
 * rows it is about to return, with the caller-facing `namespace` the entry
 * searched with. The modern core {@link executeSearch} deliberately does NOT
 * attach: widening the direct-execute consumers is outside cut 2.
 *
 * @returns Rows with namespaces canonicalized, exactly as the sibling entries
 *   return them, so a caller cannot tell which arm answered from the row shape.
 */
export async function executeSearchWithScopedSharedFallback(
  request: ScopedSharedFallbackRequest,
): Promise<SearchRow[]> {
  const {
    dependencies,
    tables,
    query,
    limit,
    mode = "hybrid",
    tier,
    offset = 0,
    namespace,
    options = {},
  } = request;
  const names = dependencies.sharedNamespaceNames;
  const config = sharedNamespaceConfig(names);

  const search = (scope: NamespaceFilter | undefined): Promise<SearchRow[]> =>
    executeSearch(dependencies, tables, query, limit, mode, tier, 0, scope, options);
  /** Canonicalize, then hydrate links, on whichever arm answered. */
  const shape = (rows: SearchRow[]): Promise<SearchRow[]> =>
    attachExplicitLinks(dependencies, withCanonicalNamespaces(rows, names), namespace);

  if (!scopedFallbackApplies(request, config)) {
    return shape(
      await executeSearch(
        dependencies,
        tables,
        query,
        limit,
        mode,
        tier,
        offset,
        namespace,
        options,
      ),
    );
  }

  const [primaryRows, sharedRows] = await Promise.all([
    search(namespace),
    search(config.physicalSharedNamespace),
  ]);
  // Enough shared truth was found; the legacy namespace has nothing to add.
  if (sharedRows.length >= limit || sharedRows.length >= config.fallbackMinResults) {
    return shape(primaryRows);
  }

  const legacyRows = await search(config.legacySharedNamespace);
  return shape(mergeFallbackRows(primaryRows, legacyRows, limit));
}
