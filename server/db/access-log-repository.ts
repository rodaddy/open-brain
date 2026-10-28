/**
 * Owns the one production write to `entry_access_log` (issue 1486).
 *
 * The table is the access LOG the tiering promotion scan
 * (`tiering-repository.ts`) and `access_report`
 * (`entity-report-repository.ts`) read. Its writers lived in the legacy
 * `search_brain` (`trackUsage`, context 'search') and `session_load`
 * (`logSessionAccess`, context 'session_load'); both were lost when those tools
 * moved to server/ and src/ was deleted, and the log stopped growing. The
 * statement below is the removed bulk insert, moved verbatim: one row per entry,
 * `accessed_at = NOW()`.
 *
 * The table carries no namespace column. The ids handed in come from reads that
 * were already namespace-bound, and both readers scope the log by joining back
 * to the owning row.
 *
 * Design authority: `docs/decisions/cognitive-tiering-dream-cycle.md`, "Access
 * tracking injection points".
 */
import type { QuerySurface } from "./transaction.ts";
import type { ResourceTable } from "../auth/types.ts";

/** The `context` values the removed writers used; the column's CHECK allows them. */
export type AccessContext = "search" | "session_load";

/** One entry that a read returned. */
export interface AccessedEntry {
  id: string;
  table: ResourceTable;
}

/**
 * Insert one `entry_access_log` row per accessed entry.
 *
 * A no-op for an empty list, so a read that returned nothing writes nothing.
 */
export async function insertEntryAccessLog(
  db: QuerySurface,
  input: {
    entries: readonly AccessedEntry[];
    queryText: string | null;
    context: AccessContext;
    accessedBy: string | null;
  },
): Promise<void> {
  if (input.entries.length === 0) return;
  await db.query(
    `INSERT INTO entry_access_log (entry_id, source_table, accessed_at, query_text, context, accessed_by)
       SELECT unnest($1::uuid[]), unnest($2::text[]), NOW(), $3, $4, $5`,
    [
      input.entries.map((entry) => entry.id),
      input.entries.map((entry) => entry.table),
      input.queryText,
      input.context,
      input.accessedBy,
    ],
  );
}
