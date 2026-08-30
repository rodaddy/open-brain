import type { AuthInfo } from "../../types.ts";

/** The admin auth every durable_memory suite uses unless it varies the role. */
export const ADMIN_AUTH: AuthInfo = { role: "admin", clientId: "rico" };

/**
 * The MCP tool answers with a JSON envelope, so these tests read payload records
 * by key rather than against an exported type. `JsonRecord` names that shape
 * once. Values are `unknown`: a test that wants a string still has to say so,
 * which is what keeps the assertions honest.
 */
export type JsonRecord = Record<string, unknown>;

/**
 * The durable_memory section is a query-driven hybrid-RRF recall over the
 * caller's readable durable brain records, isolated to the auth-derived
 * namespace. These tests black-box the section through the MCP tool: they vary
 * scope, query, budget, and role, and assert the observable envelope, citations,
 * isolation predicate, and defined empty/degraded states — not the internal SQL
 * shape beyond the namespace security boundary the issue requires proving.
 */

/**
 * A mock pool that answers the hybrid search CTEs (vector + FTS) with a supplied
 * set of brain records and records every query's params so isolation predicates
 * can be asserted.
 */
export function searchPool(
  records: Array<Record<string, unknown>>,
  captured: Array<{ sql: string; params?: unknown[] }> = [],
) {
  return {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        // Vector CTE and FTS CTE both select from the brain tables; return the
        // records for either search path so RRF has both lists to merge.
        if (
          sql.includes("query_embedding") ||
          sql.includes("fts_query") ||
          sql.includes("FROM ob_")
        ) {
          return { rows: records };
        }
        return { rows: [] };
      },
    },
    captured,
  };
}

export function brainRecord(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    source_type: "decision",
    id: overrides.id ?? "dec-1",
    namespace: "rico",
    content_preview: "durable decision content",
    tags: null,
    created_by: "rico",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    usefulness: 0.9,
    tier: "warm",
    distance: 0.1,
    fts_rank: 0.9,
    ...overrides,
  };
}
