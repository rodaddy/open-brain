/**
 * Tier and archive MUTATIONS: `set_tier`, `bulk_set_tier`, `bulk_archive`,
 * `demote_entry`.
 *
 * Design authority: `docs/decisions/cognitive-tiering-dream-cycle.md` (the tier
 * model), `docs/identity-boundary.md` (token-derived identity), and
 * `docs/decisions/privilege-isolation-closed-brain.md` (server-side isolation).
 *
 * These are the WRITE half of the tiering surface whose read half is
 * `tiering.ts`. That split is the dream-cycle contract: `tier_recommendations`
 * and `list_stale` score and propose, and nothing in this file runs unless a
 * caller invoked it by name with the ids it wants changed. There is no planning
 * path into these handlers, so the dry-run default that governs DreamEngine has
 * nothing to default here -- an explicit `set_tier` call IS the opt-in.
 *
 * Every statement carries the auth-derived MUTATION predicate
 * (`namespacePredicate(identity, "write", ...)`), which resolves to the
 * caller's own namespace only -- never the shared read set. An ID-based update
 * without it writes whichever namespace happens to own the UUID, which is the
 * isolation bug class this repo's rules name explicitly. The predicate is on
 * the UPDATE itself, never a check in a prior statement, so there is no window
 * between the check and the write.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PoolClient } from "pg";
import { canDelete, canWrite } from "../auth/permissions.ts";
import { namespacePredicate } from "../auth/namespace-policy.ts";
import type { ResourceTable } from "../auth/types.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import { tableEnum, tierEnum } from "./curation-helpers.ts";

/**
 * Entries a bulk call accepts, reproduced from observed current-src.
 *
 * This is a FROZEN WIRE VALUE, not a new bound introduced here: both bulk tools
 * already advertise `.max(100)` in their published schemas, so changing it
 * would change the contract clients validate against.
 */
const BULK_ENTRIES_PER_CALL = 100;

export function registerTierMutationTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "set_tier",
    {
      description:
        "Set the cognitive tier (hot/warm/cold) for a brain entry. Hot entries are boosted in search, cold entries are deprioritized. Requires write permission.",
      inputSchema: {
        table: tableEnum.describe("Table containing the entry"),
        id: z.string().uuid().describe("UUID of the entry to update"),
        tier: tierEnum.describe(
          "Cognitive tier: hot (front-of-mind, boosted), warm (default), cold (deprioritized)",
        ),
      },
      annotations: {
        title: "Set Tier",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      const table = args.table as ResourceTable;
      if (!identity || !canWrite(identity.role, table)) {
        return errorResult(`Permission denied: cannot write to ${table}`);
      }

      // `table` reaches an interpolated position only after `tableEnum` has
      // narrowed it to one of five compile-time literals.
      const predicate = namespacePredicate(identity, "write", 3);
      const { rows } = await dependencies.pool.query(
        `UPDATE ${table} SET tier = $1
          WHERE id = $2 AND archived_at IS NULL${predicate.clause}
          RETURNING id, tier`,
        [args.tier, args.id, ...predicate.values],
      );

      // Not-mine and not-there collapse to ONE string, so this tool cannot be
      // used to probe which UUIDs exist in a namespace the caller cannot write.
      if (rows.length === 0) {
        dependencies.logger.info(
          { tool: "set_tier", table, matched: 0 },
          "set_tier_noop",
        );
        return errorResult("Entry not found or archived");
      }

      const row = rows[0] as { id: string; tier: string };
      dependencies.logger.info(
        { tool: "set_tier", table, id: row.id, tier: row.tier },
        "tool_result",
      );
      return textResult({ id: row.id, table, tier: row.tier });
    },
  );

  server.registerTool(
    "bulk_set_tier",
    {
      description:
        "Set cognitive tiers for multiple entries in a single transaction. Max 100 entries per call.",
      inputSchema: {
        entries: z
          .array(
            z.object({
              id: z.string().uuid().describe("UUID of the entry"),
              table: tableEnum.describe("Table containing the entry"),
              tier: tierEnum.describe("Target cognitive tier"),
            }),
          )
          .min(1)
          .max(BULK_ENTRIES_PER_CALL)
          .describe(`Array of entries to update (max ${BULK_ENTRIES_PER_CALL})`),
      },
      annotations: {
        title: "Bulk Set Tier",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return errorResult("Permission denied: not authenticated");

      const entries = args.entries;
      // Every referenced table is permission-checked BEFORE the transaction
      // opens. Checking inside the loop would let a partially-authorized batch
      // do real work and then roll back, which is a slower way to reach the
      // same refusal and leaves a write burst in the WAL on the way.
      for (const table of new Set(entries.map((entry) => entry.table))) {
        if (!canWrite(identity.role, table as ResourceTable)) {
          return errorResult(`Permission denied: cannot write to ${table}`);
        }
      }

      const predicate = namespacePredicate(identity, "write", 3);
      const result = await runBulkTransaction(
        dependencies,
        "bulk_set_tier",
        entries,
        (entry) => ({
          sql: `UPDATE ${entry.table as ResourceTable} SET tier = $1
                 WHERE id = $2 AND archived_at IS NULL${predicate.clause}`,
          values: [entry.tier, entry.id, ...predicate.values],
        }),
      );
      if (!result.ok) return result.response;

      dependencies.logger.info(
        { tool: "bulk_set_tier", requested: entries.length, updated: result.affected },
        "tool_result",
      );
      return textResult({ requested: entries.length, updated: result.affected });
    },
  );

  server.registerTool(
    "bulk_archive",
    {
      description:
        "Soft-delete multiple entries in a single transaction. Max 100 entries per call.",
      inputSchema: {
        entries: z
          .array(
            z.object({
              id: z.string().uuid().describe("UUID of the entry to archive"),
              table: tableEnum.describe("Table containing the entry"),
            }),
          )
          .min(1)
          .max(BULK_ENTRIES_PER_CALL)
          .describe(`Array of entries to archive (max ${BULK_ENTRIES_PER_CALL})`),
      },
      annotations: {
        title: "Bulk Archive",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return errorResult("Permission denied: not authenticated");

      const entries = args.entries;
      // Archiving is a DELETE-class operation, so the delete permission is the
      // authority here, not write. `discord` can write thoughts and must not be
      // able to archive them.
      for (const table of new Set(entries.map((entry) => entry.table))) {
        if (!canDelete(identity.role, table as ResourceTable)) {
          return errorResult(`Permission denied: cannot delete from ${table}`);
        }
      }

      const predicate = namespacePredicate(identity, "delete", 2);
      const result = await runBulkTransaction(
        dependencies,
        "bulk_archive",
        entries,
        (entry) => ({
          sql: `UPDATE ${entry.table as ResourceTable} SET archived_at = NOW()
                 WHERE id = $1 AND archived_at IS NULL${predicate.clause}`,
          values: [entry.id, ...predicate.values],
        }),
      );
      if (!result.ok) return result.response;

      dependencies.logger.info(
        { tool: "bulk_archive", requested: entries.length, archived: result.affected },
        "tool_result",
      );
      return textResult({ requested: entries.length, archived: result.affected });
    },
  );

  server.registerTool(
    "demote_entry",
    {
      description:
        "Archive a previously promoted entry, reversing a promotion. " +
        "Only works on entries that have promoted_from provenance metadata. Admin and ob-admin only.",
      inputSchema: {
        table: tableEnum.describe("Table name"),
        id: z.string().uuid().describe("UUID of the promoted entry to demote"),
      },
      annotations: {
        title: "Demote Entry",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      // Demotion reverses shared truth, so it is gated on the break-glass
      // identities by ROLE rather than the table permission matrix: a promoter
      // may promote INTO shared-kb but may not unwind what is already there.
      if (!identity || (identity.role !== "admin" && identity.role !== "ob-admin")) {
        return errorResult("Permission denied: admin or ob-admin role required");
      }

      const table = args.table as ResourceTable;
      const notFound = errorResult("Entry not found or already archived");

      const readPredicate = namespacePredicate(identity, "read", 2);
      const { rows } = await dependencies.pool.query(
        `SELECT id, namespace, promoted_from FROM ${table}
          WHERE id = $1 AND archived_at IS NULL${readPredicate.clause}`,
        [args.id, ...readPredicate.values],
      );
      if (rows.length === 0) return notFound;

      const provenance = (rows[0] as { promoted_from: unknown }).promoted_from;
      if (!provenance) {
        return errorResult("Entry was not promoted — cannot demote");
      }

      // The UPDATE re-derives its own predicate rather than trusting the SELECT
      // that just passed. The read scope is WIDER than the write scope (it
      // includes shared-kb), so reusing the read predicate here would let an
      // entry that is merely readable be archived.
      const writePredicate = namespacePredicate(identity, "delete", 2);
      const { rowCount } = await dependencies.pool.query(
        `UPDATE ${table} SET archived_at = NOW()
          WHERE id = $1 AND archived_at IS NULL${writePredicate.clause}`,
        [args.id, ...writePredicate.values],
      );
      if ((rowCount ?? 0) === 0) return notFound;

      const source = provenance as { source_id?: unknown; source_namespace?: unknown };
      dependencies.logger.info(
        {
          tool: "demote_entry",
          table,
          id: args.id,
          sourceId: source.source_id,
          sourceNamespace: source.source_namespace,
        },
        "tool_result",
      );
      return textResult({
        status: "demoted",
        archived_id: args.id,
        source_id: source.source_id,
        source_namespace: source.source_namespace,
      });
    },
  );
}

type BulkOutcome =
  | { readonly ok: true; readonly affected: number }
  | { readonly ok: false; readonly response: ReturnType<typeof errorResult> };

/**
 * Run one statement per entry inside a single transaction.
 *
 * Shared by both bulk tools because their failure handling is the part worth
 * having exactly once: a rollback plus a CONTENT-FREE error string. The raw
 * driver message can embed query fragments, row content, and namespace names
 * (the PR #275 / #262 pattern), so only the error class and SQLSTATE reach the
 * log and nothing reaches the caller.
 *
 * @param statementFor Builds the SQL and bound values for one entry.
 * @returns The affected row count, or a ready-to-return denial envelope.
 */
async function runBulkTransaction<TEntry>(
  dependencies: MemoryToolDependencies,
  tool: string,
  entries: readonly TEntry[],
  statementFor: (entry: TEntry) => { sql: string; values: unknown[] },
): Promise<BulkOutcome> {
  const client: PoolClient = await dependencies.pool.connect();
  let affected = 0;
  try {
    await client.query("BEGIN");
    for (const entry of entries) {
      const { sql, values } = statementFor(entry);
      const { rowCount } = await client.query(sql, values);
      affected += rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (error) {
    // A failed ROLLBACK must not mask the original failure, and it must not
    // throw out of a catch block: the connection is released either way, and
    // the caller still gets the stable refusal.
    await client.query("ROLLBACK").catch(() => undefined);
    dependencies.logger.error(
      {
        tool,
        errorName: error instanceof Error ? error.name : "unknown",
        errorCode: (error as { code?: string } | null | undefined)?.code,
      },
      "bulk_transaction_error",
    );
    return { ok: false, response: errorResult("Transaction failed") };
  } finally {
    client.release();
  }
  return { ok: true, affected };
}
