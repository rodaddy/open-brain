/**
 * REST read routes: search, single entry lookup and namespace counts (split of
 * the REST router in the L5 move, issue 864). Route paths, status codes, response shapes,
 * error strings and zod schemas are unchanged from the pre-split router.
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { canRead } from "../auth/permissions.ts";
// The modern engine (issue 841 cut 2). Both executors take their collaborators
// as an injected `SearchDependencies` rather than resolving shared-namespace
// config and the embedding timeout ambiently, so this route builds that object
// from `RestDeps` and the two arms differ only in calling convention: the
// shared arm is positional, the scoped arm takes a request object.
import { executeSearchWithSharedFallback } from "../tools/search-engine.ts";
import { executeSearchWithScopedSharedFallback } from "../tools/search-engine-scoped-fallback.ts";
import type { SearchDependencies, SearchMode } from "../tools/search-engine-types.ts";
import { ALL_TABLES } from "../db/table-constants.ts";
import { TABLE_COLUMNS } from "../domain/table-projections.ts";
import { createEntryReadRepository } from "../db/entry-read-repository.ts";
import { namespaceFilterFor, readableNamespaces } from "../domain/read-policy.ts";
import { isSharedNamespace } from "../security/shared-namespace-ambient.ts";
import type { AuthInfo, Table, Tier } from "../types.ts";
import {
  getAuth,
  isReadableNamespaceDenied,
  namespaceSchema,
  parseQuery,
  readNamespacePredicate,
  uuidSchema,
  type RestDeps,
} from "./rest-api-helpers.ts";

const validTableValues = ALL_TABLES as [Table, ...Table[]];

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1),
  namespace: namespaceSchema.optional(),
  limit: z.coerce.number().int().min(1).max(250).default(10),
  offset: z.coerce.number().int().min(0).default(0),
  table: z.enum(validTableValues).optional(),
  mode: z.enum(["hybrid", "vector", "keyword"]).default("hybrid"),
  tier: z.enum(["hot", "warm", "cold"]).optional(),
});

function accessibleTablesFor(auth: AuthInfo, table?: Table): Table[] {
  return table
    ? [table].filter((t) => ALL_TABLES.includes(t) && canRead(auth.role, t))
    : ALL_TABLES.filter((t) => canRead(auth.role, t));
}

export async function getSearch(
  deps: RestDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const auth = getAuth(req);
  if (!auth) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const parsed = parseQuery(searchQuerySchema, req.query, res);
  if (!parsed) return;
  const { q, namespace, limit, offset, table, mode, tier } = parsed;

  if (isReadableNamespaceDenied(auth, namespace)) {
    res.status(403).json({ error: "Permission denied: namespace read access denied" });
    return;
  }

  const accessibleTables = accessibleTablesFor(auth, table as Table | undefined);

  if (accessibleTables.length === 0) {
    res.status(403).json({ error: "No accessible tables" });
    return;
  }

  const namespaceFilter = namespaceFilterFor(auth, namespace);
  const searchDeps: SearchDependencies = {
    pool: deps.pool,
    embedFn: (text) => deps.embedFn(text),
    logger: deps.logger,
    searchEmbeddingTimeoutMs: deps.searchEmbeddingTimeoutMs,
    jev: deps.jev,
    // Without these the engine's shared-namespace helpers throw rather than
    // defaulting (`server/tools/shared-namespace.ts` `requireNames`), which is
    // the isolation boundary refusing to guess which partition it is binding.
    sharedNamespaceNames: deps.sharedNamespaceNames,
  };
  const rows =
    typeof namespaceFilter === "string" && isSharedNamespace(namespaceFilter)
      ? // The 10th argument is `requestedShared`, and this branch IS the
        // condition it names: the caller asked for the shared namespace by
        // name, which is what entitles the shared fallback to fan out.
        await executeSearchWithSharedFallback(
          searchDeps,
          accessibleTables,
          q,
          limit,
          mode as SearchMode,
          tier as Tier | undefined,
          offset,
          namespaceFilter,
          {},
          true,
        )
      : await executeSearchWithScopedSharedFallback({
          dependencies: searchDeps,
          tables: accessibleTables,
          query: q,
          limit,
          mode: mode as SearchMode,
          tier: tier as Tier | undefined,
          offset,
          namespace: namespaceFilter,
        });

  res.json({ results: rows, count: rows.length });
}

export async function getEntry(
  deps: RestDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const auth = getAuth(req);
  const table = req.params.table as Table;

  if (!ALL_TABLES.includes(table)) {
    res.status(400).json({ error: `Invalid table: ${table}` });
    return;
  }
  if (!auth || !canRead(auth.role, table)) {
    res.status(403).json({ error: "Permission denied" });
    return;
  }

  const id = uuidSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: "Invalid entry id" });
    return;
  }

  const columns = TABLE_COLUMNS[table];
  const readable = readableNamespaces(auth);
  const predicate = readNamespacePredicate(auth, 2);
  const params: unknown[] = readable ? [id.data, readable] : [id.data];
  const repository = createEntryReadRepository(deps.pool);
  const rows = await repository.selectRestEntry({
    table,
    columnsSql: columns,
    predicateClause: predicate,
    params,
  });

  if (rows.length === 0) {
    res.status(404).json({ error: "Entry not found or archived" });
    return;
  }

  const { source_refs: _sourceRefs, ...entry } = rows[0];
  res.json(entry);
}

interface NamespaceTotals {
  total: number;
  per_table: Record<string, number>;
}

function foldNamespaceRows(
  results: { rows: Record<string, unknown>[] }[],
): Map<string, NamespaceTotals> {
  const nsMap = new Map<string, NamespaceTotals>();
  for (const result of results) {
    for (const row of result.rows) {
      const ns = row.namespace as string;
      const existing = nsMap.get(ns) ?? { total: 0, per_table: {} };
      const count = Number(row.count);
      existing.total += count;
      existing.per_table[row.table_name as string] = count;
      nsMap.set(ns, existing);
    }
  }
  return nsMap;
}

export async function getNamespaces(
  deps: RestDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const auth = getAuth(req);
  if (!auth) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const accessibleTables = ALL_TABLES.filter((t) => canRead(auth.role, t));
  const readable = readableNamespaces(auth);
  const repository = createEntryReadRepository(deps.pool);
  const queries = accessibleTables.map(async (table) => {
    const predicate = readable ? " AND namespace = ANY($1::text[])" : "";
    const rows = await repository.countNamespaces({
      table,
      predicateClause: predicate,
      params: readable ? [readable] : [],
    });
    return { rows };
  });

  const results = await Promise.all(queries);
  const nsMap = foldNamespaceRows(results);

  const namespaces = Array.from(nsMap.entries())
    .map(([namespace, data]) => ({
      namespace,
      total: data.total,
      per_table: data.per_table,
    }))
    .sort((a, b) => b.total - a.total);

  res.json({ namespace_count: namespaces.length, namespaces });
}
