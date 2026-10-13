/** Transaction-local PostgreSQL settings for filtered HNSW candidate recovery. */
import type { Pool } from "pg";
import { createEntryReadRepository, type EntryRows } from "./entry-read-repository.ts";
import { withTransaction } from "./transaction.ts";

export const VECTOR_SEARCH_EF_SEARCH = "400";
export const VECTOR_SEARCH_ITERATIVE_SCAN = "strict_order";

export interface RunVectorSearchSqlOptions {
  readonly pool: Pool;
  readonly sql: string;
  readonly params: unknown[];
  readonly onRollbackFailure?: (error: unknown) => void;
}

/** Run one vector candidate query with settings scoped to its transaction. */
export async function runVectorSearchSql(
  options: RunVectorSearchSqlOptions,
): Promise<EntryRows> {
  return withTransaction({
    pool: options.pool,
    readOnly: true,
    onRollbackFailure: options.onRollbackFailure,
    run: async (tx) => {
      await tx.query("SELECT set_config('hnsw.ef_search', $1, true)", [
        VECTOR_SEARCH_EF_SEARCH,
      ]);
      await tx.query("SELECT set_config('hnsw.iterative_scan', $1, true)", [
        VECTOR_SEARCH_ITERATIVE_SCAN,
      ]);
      return createEntryReadRepository(tx).runSearchSql({
        sql: options.sql,
        params: options.params,
      });
    },
  });
}
