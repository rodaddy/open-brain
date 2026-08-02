/**
 * Parameterized database query boundary.
 *
 * Design authority: `docs/decisions/privilege-isolation-closed-brain.md`
 * requires server-side isolation that fails closed. Dynamic table identifiers
 * are accepted only through the closed Zod allowlist below.
 */
import { z } from "zod";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import type { NamespaceOperation } from "../auth/namespace-policy.ts";
import { namespacePredicate } from "../auth/namespace-policy.ts";

export const resourceTableSchema = z.enum([
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
]);

type Queryable = Pick<Pool | PoolClient, "query">;

export interface IdQuery {
  readonly table: ResourceTable;
  readonly id: string;
  readonly identity: AuthIdentity;
  readonly operation: NamespaceOperation;
}

/** Run a parameterized query and return typed rows. */
export async function queryRows<Row extends QueryResultRow>(
  database: Queryable,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly Row[]> {
  const result = await database.query<Row>(text, [...values]);
  return result.rows;
}

/** Read one row by ID while enforcing an auth-derived namespace predicate. */
export async function selectById<Row extends QueryResultRow>(
  database: Queryable,
  input: IdQuery,
): Promise<Row | undefined> {
  const table = resourceTableSchema.parse(input.table);
  const predicate = namespacePredicate(input.identity, input.operation, 2);
  const rows = await queryRows<Row>(
    database,
    `SELECT * FROM ${table} WHERE id = $1${predicate.clause}`,
    [input.id, ...predicate.values],
  );
  return rows[0];
}

/** Delete one row by ID while enforcing the same namespace boundary. */
export async function deleteById(
  database: Queryable,
  input: Omit<IdQuery, "operation">,
): Promise<boolean> {
  const table = resourceTableSchema.parse(input.table);
  const predicate = namespacePredicate(input.identity, "delete", 2);
  const result: QueryResult = await database.query(
    `DELETE FROM ${table} WHERE id = $1${predicate.clause}`,
    [input.id, ...predicate.values],
  );
  return (result.rowCount ?? 0) > 0;
}
