import { executeSearch } from "./legacy-search-execute.ts";
import {
  mergeFallbackSearchRows,
  withCanonicalNamespaces,
  type SearchRow,
} from "./legacy-search-rows-and-fallback.ts";
import { sharedNamespaceConfig } from "../../../src/shared-namespace.ts";
import { type ExecuteSearchOptions } from "./legacy-search-tables-and-parsing.ts";

export async function executeSearchWithSharedFallback(
  options: ExecuteSearchOptions,
): Promise<SearchRow[]> {
  const { limit, offset = 0, namespace } = options;
  const config = sharedNamespaceConfig();
  if (
    !config.legacyFallbackEnabled ||
    config.legacySharedNamespace === "" ||
    offset !== 0 ||
    namespace !== config.sharedNamespace
  ) {
    return withCanonicalNamespaces(await executeSearch(options));
  }

  const sharedRows = await executeSearch({
    ...options,
    offset: 0,
    namespace: config.sharedNamespace,
  });
  if (sharedRows.length >= limit || sharedRows.length >= config.fallbackMinResults) {
    return withCanonicalNamespaces(sharedRows);
  }

  const legacyRows = await executeSearch({
    ...options,
    limit: limit - sharedRows.length,
    offset: 0,
    namespace: config.legacySharedNamespace,
  });
  return withCanonicalNamespaces(
    mergeFallbackSearchRows(sharedRows, legacyRows, limit),
  );
}

export async function executeSearchWithScopedSharedFallback(
  options: ExecuteSearchOptions,
): Promise<SearchRow[]> {
  const { limit, offset = 0, namespace } = options;
  const config = sharedNamespaceConfig();
  const scopedNamespaces = Array.isArray(namespace) ? namespace : [];
  if (
    !config.legacyFallbackEnabled ||
    config.legacySharedNamespace === "" ||
    offset !== 0 ||
    !scopedNamespaces.includes(config.physicalSharedNamespace)
  ) {
    return withCanonicalNamespaces(await executeSearch(options));
  }

  const [primaryRows, sharedRows] = await Promise.all([
    executeSearch({
      ...options,
      offset: 0,
    }),
    executeSearch({
      ...options,
      offset: 0,
      namespace: config.physicalSharedNamespace,
    }),
  ]);
  if (sharedRows.length >= limit || sharedRows.length >= config.fallbackMinResults) {
    return withCanonicalNamespaces(primaryRows);
  }

  const legacyRows = await executeSearch({
    ...options,
    offset: 0,
    namespace: config.legacySharedNamespace,
  });
  return withCanonicalNamespaces(
    mergeFallbackSearchRows(primaryRows, legacyRows, limit),
  );
}
