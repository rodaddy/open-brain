/**
 * Tier and archive MUTATIONS: `set_tier`, `bulk_set_tier`, `bulk_archive`,
 * `demote_entry`. The WRITE half of the tiering surface whose read half is
 * `tiering.ts`; every statement carries the auth-derived mutation predicate
 * `namespacePredicate(identity, "write", ...)` on the UPDATE itself.
 *
 * See docs/decisions/tier-mutations-explicit-call-and-update-predicate.md for
 * why these handlers need no dry-run default and why that predicate is not a
 * prior check, and for the design authority this file answers to
 * (docs/decisions/cognitive-tiering-dream-cycle.md,
 * docs/identity-boundary.md, and
 * docs/decisions/privilege-isolation-closed-brain.md).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withTransaction } from "../db/transaction.ts";
import { createTieringStatements } from "../db/tiering-repository.ts";
import { BULK_SET_TIER_CAUSE } from "../db/tier-moves.ts";
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
 * Entries a bulk call accepts.
 *
 * This is a FROZEN WIRE VALUE, not a new bound introduced here: both bulk tools
 * already advertise `.max(100)` in their published schemas, so changing it
 * would change the contract clients validate against.
 */
const BULK_ENTRIES_PER_CALL = 100;

const setTierInputSchema = {
  table: tableEnum.describe("Table containing the entry"),
  id: z.string().uuid().describe("UUID of the entry to update"),
  tier: tierEnum.describe(
    "Cognitive tier: hot (front-of-mind, boosted), warm (default), cold (deprioritized)",
  ),
};

const setTierAnnotations = {
  title: "Set Tier",
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

const bulkSetTierInputSchema = {
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
};

const bulkSetTierAnnotations = {
  title: "Bulk Set Tier",
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

const bulkArchiveInputSchema = {
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
};

const bulkArchiveAnnotations = {
  title: "Bulk Archive",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
};

const demoteEntryInputSchema = {
  table: tableEnum.describe("Table name"),
  id: z.string().uuid().describe("UUID of the promoted entry to demote"),
};

const demoteEntryAnnotations = {
  title: "Demote Entry",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
};

export function registerTierMutationTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "set_tier",
    {
      description:
        "Set the cognitive tier (hot/warm/cold) for a brain entry. Hot entries are boosted in search, cold entries are deprioritized. Requires write permission.",
      inputSchema: setTierInputSchema,
      annotations: setTierAnnotations,
    },
    async (args, extra) => handleSetTier(dependencies, args, extra),
  );

  server.registerTool(
    "bulk_set_tier",
    {
      description:
        "Set cognitive tiers for multiple entries in a single transaction. Max 100 entries per call.",
      inputSchema: bulkSetTierInputSchema,
      annotations: bulkSetTierAnnotations,
    },
    async (args, extra) => handleBulkSetTier(dependencies, args, extra),
  );

  server.registerTool(
    "bulk_archive",
    {
      description:
        "Soft-delete multiple entries in a single transaction. Max 100 entries per call.",
      inputSchema: bulkArchiveInputSchema,
      annotations: bulkArchiveAnnotations,
    },
    async (args, extra) => handleBulkArchive(dependencies, args, extra),
  );

  server.registerTool(
    "demote_entry",
    {
      description:
        "Archive a previously promoted entry, reversing a promotion. " +
        "Only works on entries that have promoted_from provenance metadata. Admin and ob-admin only.",
      inputSchema: demoteEntryInputSchema,
      annotations: demoteEntryAnnotations,
    },
    async (args, extra) => handleDemoteEntry(dependencies, args, extra),
  );
}

/** Minimal shape of the handler `extra` argument these tools read. */
interface HandlerExtra {
  authInfo?: Parameters<typeof authIdentity>[0];
}

/**
 * Check one permission per DISTINCT table referenced by a bulk batch.
 *
 * Both bulk tools check every referenced table BEFORE their transaction opens.
 * Checking inside the loop would let a partially-authorized batch do real work
 * and then roll back, which is a slower way to reach the same refusal and
 * leaves a write burst in the WAL on the way.
 *
 * @param entries Batch entries, each naming the table it targets.
 * @param permitted Role check for one table: `canWrite` or `canDelete`.
 * @param denial Builds the observed current-src refusal string for a table.
 * @returns The denial envelope for the first unauthorized table, else `undefined`.
 */
function denyUnauthorizedTables(
  entries: readonly { table: string }[],
  permitted: (table: ResourceTable) => boolean,
  denial: (table: string) => string,
): ReturnType<typeof errorResult> | undefined {
  for (const table of new Set(entries.map((entry) => entry.table))) {
    if (!permitted(table as ResourceTable)) {
      return errorResult(denial(table));
    }
  }
  return undefined;
}

/** `set_tier`: retier ONE entry the caller may write, in its own namespace. */
async function handleSetTier(
  dependencies: MemoryToolDependencies,
  args: { table: string; id: string; tier: string },
  extra: HandlerExtra,
) {
  const identity = authIdentity(extra.authInfo);
  const table = args.table as ResourceTable;
  if (!identity || !canWrite(identity.role, table)) {
    return errorResult(`Permission denied: cannot write to ${table}`);
  }

  // `table` reaches an interpolated position only after `tableEnum` has
  // narrowed it to one of five compile-time literals.
  const predicate = namespacePredicate(identity, "write", 3);
  const rows = await createTieringStatements(dependencies.pool).setTier({
    table,
    predicateClause: predicate.clause,
    params: [args.tier, args.id, ...predicate.values],
  });

  // Not-mine and not-there collapse to ONE string, so this tool cannot be
  // used to probe which UUIDs exist in a namespace the caller cannot write.
  if (rows.length === 0) {
    dependencies.logger.info({ tool: "set_tier", table, matched: 0 }, "set_tier_noop");
    return errorResult("Entry not found or archived");
  }

  const row = rows[0] as { id: string; tier: string };
  dependencies.logger.info(
    { tool: "set_tier", table, id: row.id, tier: row.tier },
    "tool_result",
  );
  return textResult({ id: row.id, table, tier: row.tier });
}

/** `bulk_set_tier`: retier a batch in ONE transaction, all-or-nothing. */
async function handleBulkSetTier(
  dependencies: MemoryToolDependencies,
  args: { entries: { id: string; table: string; tier: string }[] },
  extra: HandlerExtra,
) {
  const identity = authIdentity(extra.authInfo);
  if (!identity) return errorResult("Permission denied: not authenticated");

  const entries = args.entries;
  const denied = denyUnauthorizedTables(
    entries,
    (table) => canWrite(identity.role, table),
    (table) => `Permission denied: cannot write to ${table}`,
  );
  if (denied) return denied;

  const predicate = namespacePredicate(identity, "write", 3);
  const result = await runBulkTransaction(
    dependencies,
    "bulk_set_tier",
    entries,
    // Each entry's UPDATE also appends its `tier_moves` row (#1469 item 5),
    // inside the transaction `runBulkTransaction` already opens -- so a batch
    // that rolls back takes its history with it rather than leaving moves
    // recorded for tiers that never changed.
    //
    // `affected` must keep counting ROWS UPDATED, so the outer statement
    // selects from `moved`: the history INSERT is a side CTE whose own row
    // count is not reported. `pre` supplies `from_tier`, which the UPDATE's
    // `RETURNING` cannot see. The UPDATE text and its predicates are unchanged.
    (entry) => ({
      sql: `WITH pre AS (
                   SELECT id, tier FROM ${entry.table as ResourceTable} WHERE id = $2
                 ), moved AS (
                   UPDATE ${entry.table as ResourceTable} SET tier = $1
                    WHERE id = $2 AND archived_at IS NULL${predicate.clause}
                    RETURNING id, tier
                 ), history AS (
                   INSERT INTO tier_moves
                     (entry_id, source_table, from_tier, to_tier, cause, routing_run_id)
                   SELECT moved.id, $${predicate.values.length + 4},
                          pre.tier, moved.tier, $${predicate.values.length + 3}, NULL
                     FROM moved JOIN pre ON pre.id = moved.id
                 )
                 SELECT id FROM moved`,
      values: [
        entry.tier,
        entry.id,
        ...predicate.values,
        BULK_SET_TIER_CAUSE,
        entry.table as ResourceTable,
      ],
    }),
  );
  if (!result.ok) return result.response;

  dependencies.logger.info(
    {
      tool: "bulk_set_tier",
      requested: entries.length,
      updated: result.affected,
    },
    "tool_result",
  );
  return textResult({ requested: entries.length, updated: result.affected });
}

/** `bulk_archive`: soft-delete a batch in ONE transaction, all-or-nothing. */
async function handleBulkArchive(
  dependencies: MemoryToolDependencies,
  args: { entries: { id: string; table: string }[] },
  extra: HandlerExtra,
) {
  const identity = authIdentity(extra.authInfo);
  if (!identity) return errorResult("Permission denied: not authenticated");

  const entries = args.entries;
  // Archiving is a DELETE-class operation, so the delete permission is the
  // authority here, not write. `discord` can write thoughts and must not be
  // able to archive them.
  const denied = denyUnauthorizedTables(
    entries,
    (table) => canDelete(identity.role, table),
    (table) => `Permission denied: cannot delete from ${table}`,
  );
  if (denied) return denied;

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
    {
      tool: "bulk_archive",
      requested: entries.length,
      archived: result.affected,
    },
    "tool_result",
  );
  return textResult({ requested: entries.length, archived: result.affected });
}

/**
 * Archive the promoted entry, re-deriving the write predicate.
 *
 * The UPDATE re-derives its own predicate rather than trusting the SELECT that
 * just passed. The read scope is WIDER than the write scope (it includes
 * shared-kb), so reusing the read predicate here would let an entry that is
 * merely readable be archived.
 *
 * @returns Rows affected by the archiving UPDATE.
 */
async function archiveDemotedEntry(
  dependencies: MemoryToolDependencies,
  identity: NonNullable<ReturnType<typeof authIdentity>>,
  table: ResourceTable,
  id: string,
): Promise<number> {
  const writePredicate = namespacePredicate(identity, "delete", 2);
  return createTieringStatements(dependencies.pool).archiveDemotedEntry({
    table,
    predicateClause: writePredicate.clause,
    params: [id, ...writePredicate.values],
  });
}

/** `demote_entry`: reverse a promotion, break-glass roles only. */
async function handleDemoteEntry(
  dependencies: MemoryToolDependencies,
  args: { table: string; id: string },
  extra: HandlerExtra,
) {
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
  const rows = await createTieringStatements(dependencies.pool).selectDemoteSource({
    table,
    predicateClause: readPredicate.clause,
    params: [args.id, ...readPredicate.values],
  });
  if (rows.length === 0) return notFound;

  const provenance = (rows[0] as { promoted_from: unknown }).promoted_from;
  if (!provenance) {
    return errorResult("Entry was not promoted — cannot demote");
  }

  if ((await archiveDemotedEntry(dependencies, identity, table, args.id)) === 0) {
    return notFound;
  }

  const source = provenance as {
    source_id?: unknown;
    source_namespace?: unknown;
  };
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
  let affected = 0;
  try {
    await withTransaction({
      pool: dependencies.pool,
      run: async (tx) => {
        const statements = createTieringStatements(tx);
        for (const entry of entries) {
          const { sql, values } = statementFor(entry);
          affected += await statements.runBulkStatement({ sql, params: values });
        }
      },
      // A failed ROLLBACK must not mask the original failure, and it must not
      // throw out of a catch block: the connection is released either way, and
      // the caller still gets the stable refusal.
      onRollbackFailure: (rollbackError: unknown) => {
        dependencies.logger.warn(
          {
            tool,
            errorName: rollbackError instanceof Error ? rollbackError.name : "unknown",
          },
          "bulk_transaction_rollback_failed",
        );
      },
    });
  } catch (error) {
    dependencies.logger.error(
      {
        tool,
        errorName: error instanceof Error ? error.name : "unknown",
        errorCode: (error as { code?: string } | null | undefined)?.code,
      },
      "bulk_transaction_error",
    );
    return { ok: false, response: errorResult("Transaction failed") };
  }
  return { ok: true, affected };
}
