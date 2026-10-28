/**
 * Hydrate a result set with the `ob_links` edges touching it.
 *
 * Links are an enrichment on top of an answer the caller already has, so a
 * lookup that throws is warned and every row gets an empty array.
 *
 * See docs/decisions/search-engine-links-port-keeps-explicit-links.md
 */
import {
  createEntryReadRepository,
  EXPLICIT_LINK_ROW_MAX,
  type EntryReadRepository,
  type LinkJoinRow,
} from "../db/entry-read-repository.ts";
import type { NamespaceFilter } from "../domain/read-scope.ts";
import { appendNamespaceParam, namespaceFilterSql } from "./search-engine-sql.ts";
import type {
  ExplicitLink,
  SearchDependencies,
  SearchRow,
} from "./search-engine-types.ts";

/** The key a row looks itself up by; one string per (type, id) pair. */
function linkKey(type: string, id: string): string {
  return `${type}:${id}`;
}

/** Read the links touching this result set, on either end. */
async function fetchExplicitLinkRows(
  repository: EntryReadRepository,
  logger: SearchDependencies["logger"],
  rows: SearchRow[],
  namespace?: NamespaceFilter,
): Promise<LinkJoinRow[]> {
  const resultTypes = rows.map((row) => row.source_type);
  const resultIds = rows.map((row) => row.id);
  const params: unknown[] = [resultTypes, resultIds];
  const namespaceParamIndex = appendNamespaceParam(params, namespace);
  const namespaceFilter = namespaceFilterSql(
    "l",
    namespaceParamIndex,
    Array.isArray(namespace),
  );

  const linkRows = await repository.selectExplicitLinkRows({
    params,
    namespaceFilter,
  });

  if (linkRows.length === EXPLICIT_LINK_ROW_MAX) {
    logger.warn(
      { result_count: rows.length, link_limit: EXPLICIT_LINK_ROW_MAX },
      "explicit_links_truncated",
    );
  }
  return linkRows;
}

/** Index the link rows by each end they touch, so a result can look itself up. */
function groupLinksByResult(linkRows: LinkJoinRow[]): Map<string, ExplicitLink[]> {
  const linksByResult = new Map<string, ExplicitLink[]>();
  const add = (key: string, link: ExplicitLink): void => {
    const existing = linksByResult.get(key) ?? [];
    existing.push(link);
    linksByResult.set(key, existing);
  };
  for (const link of linkRows) {
    const shared = {
      id: link.id,
      relation: link.relation,
      weight: link.weight,
      metadata: link.metadata ?? {},
      created_at: new Date(link.created_at).toISOString(),
    };
    add(linkKey(link.from_type, link.from_id), {
      ...shared,
      direction: "outgoing",
      linked_type: link.to_type,
      linked_id: link.to_id,
      linked_name: link.to_name,
      canonical_id: link.to_canonical_id,
    });
    add(linkKey(link.to_type, link.to_id), {
      ...shared,
      direction: "incoming",
      linked_type: link.from_type,
      linked_id: link.from_id,
      linked_name: link.from_name,
      canonical_id: link.from_canonical_id,
    });
  }
  return linksByResult;
}

/**
 * Give every row its `explicit_links`, or an empty array if the lookup fails.
 *
 * @param dependencies Pool and logger; the same bundle the arms run on.
 * @param rows The result set to enrich, returned unchanged when empty.
 * @param namespace The read scope the links must also satisfy, so a link is
 *   never surfaced from outside the namespace the search itself was bounded to.
 */
export async function attachExplicitLinks(
  dependencies: SearchDependencies,
  rows: SearchRow[],
  namespace?: NamespaceFilter,
): Promise<SearchRow[]> {
  if (rows.length === 0) return rows;
  try {
    const repository = createEntryReadRepository(dependencies.pool);
    const linkRows = await fetchExplicitLinkRows(
      repository,
      dependencies.logger,
      rows,
      namespace,
    );
    const linksByResult = groupLinksByResult(linkRows);
    return rows.map((row) => ({
      ...row,
      explicit_links: linksByResult.get(linkKey(row.source_type, row.id)) ?? [],
    }));
  } catch (err) {
    dependencies.logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "explicit_links_lookup_failed",
    );
    return rows.map((row) => ({ ...row, explicit_links: [] }));
  }
}
