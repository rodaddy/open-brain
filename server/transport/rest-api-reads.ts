/**
 * REST read routes: search, single entry lookup and namespace counts (issue 864
 * split of `src/rest-api.ts`). Route paths, status codes, response shapes,
 * error strings and zod schemas are unchanged from the pre-split router.
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { canRead } from "../security/permissions.ts";
import {
  executeSearchWithScopedSharedFallback,
  executeSearchWithSharedFallback,
  type SearchMode,
} from "../../src/tools/search-brain.ts";
import { ALL_TABLES } from "../db/table-constants.ts";
import { TABLE_COLUMNS } from "../domain/table-projections.ts";
import { namespaceFilterFor, readableNamespaces } from "../domain/read-policy.ts";
import { isSharedNamespace } from "../../src/shared-namespace.ts";
import type { AuthInfo, Table, Tier } from "../../src/types.ts";
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
  const rows =
    typeof namespaceFilter === "string" && isSharedNamespace(namespaceFilter)
      ? await executeSearchWithSharedFallback(
          deps,
          accessibleTables,
          q,
          limit,
          mode as SearchMode,
          tier as Tier | undefined,
          offset,
          namespaceFilter,
        )
      : await executeSearchWithScopedSharedFallback(
          deps,
          accessibleTables,
          q,
          limit,
          mode as SearchMode,
          tier as Tier | undefined,
          offset,
          namespaceFilter,
        );

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
  const { rows } = await deps.pool.query(
    `SELECT ${columns} FROM ${table} WHERE id = $1${predicate} AND archived_at IS NULL`,
    params,
  );

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
  const queries = accessibleTables.map((table) => {
    const predicate = readable ? " AND namespace = ANY($1::text[])" : "";
    return deps.pool.query(
      `SELECT '${table}' AS table_name, namespace, COUNT(*) AS count
         FROM ${table} WHERE archived_at IS NULL${predicate}
         GROUP BY namespace ORDER BY count DESC`,
      readable ? [readable] : [],
    );
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
