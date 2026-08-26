/**
 * `find_duplicates`: pairwise vector-similarity duplicate discovery.
 *
 * Design authority: `docs/decisions/cognitive-tiering-dream-cycle.md` (curation
 * is a proposal step) and `docs/decisions/privilege-isolation-closed-brain.md`
 * (server-side isolation).
 *
 * READ-ONLY. It reports pairs; it archives nothing. Acting on a pair is a
 * separate explicit `bulk_archive` call, which is the same proposal/mutation
 * split `tiering.ts` and `tier-mutations.ts` sit on either side of.
 *
 * ## #485: the global-role self-join must stay scoped
 *
 * Current-src builds this self-join by appending a read predicate to each side:
 *
 *     const namespacePredicateA = appendReadNamespacePredicate(auth, params, "a.namespace");
 *     const namespacePredicateB = appendReadNamespacePredicate(auth, params, "b.namespace");
 *
 * For a global role (`admin`, `ob-admin`) the readable-namespace set is
 * `undefined`, so BOTH predicates collapse to the empty string and the join runs
 * over every pair in the table. Measured on `open_brain_local_play` (24,845
 * embedded non-archived thoughts, ~308M pairwise halfvec distances, and no index
 * able to serve `a.embedding <=> b.embedding < $1` across arbitrary pairs):
 *
 *   | shape                    | result                                   |
 *   |--------------------------|------------------------------------------|
 *   | namespace-scoped         | 256.7 ms, 5 rows                         |
 *   | unscoped (the admin path)| cancelled at 60,074 ms by statement_timeout |
 *
 * `ORDER BY distance ASC` means the row ceiling cannot help: every surviving
 * pair's distance is computed before anything can be ordered. Worse than slow,
 * the pooled connections never came back -- 42 backends were observed still
 * `state='active'` on this join five minutes after the run that launched them
 * had ended, which turned one query into a cascade of unrelated red in `bun test`
 * and made a #463 parity run report 13 failures where only 6 were real.
 *
 * The port carries the fix, not the defect, taking both complementary
 * directions the issue named:
 *
 *   1. **The join is always namespace-bounded.** A global role resolves to a
 *      concrete namespace set rather than to "no predicate at all": it defaults
 *      to its own namespace and may name another via `namespace`. There is no
 *      input that produces an unscoped self-join.
 *   2. **The statement is bounded anyway.** The query runs in a `READ ONLY`
 *      transaction carrying a server-side `statement_timeout`, so even a
 *      pathological namespace cannot hold a pooled connection open forever. This
 *      is the same net `search_brain`'s unindexed FTS path already uses.
 *
 * (1) is the fix; (2) is the safety net. Cross-namespace duplicate PAIRS are not
 * reported for a global caller, which is a real behavior change and is stated
 * here rather than assumed: reporting them is what requires the unbounded join.
 */
import { z } from "zod";
import type { PoolClient } from "pg";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../auth/permissions.ts";
import { canTargetNamespace } from "../auth/namespace-policy.ts";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import {
  ALL_TABLES,
  DUPLICATE_THRESHOLD,
  PREVIEW_WIDTH,
  tableEnum,
} from "./curation-helpers.ts";

/**
 * How long one table's self-join may run before Postgres cancels it.
 *
 * This is the #485 safety net, not a product decision: without it a single call
 * pins a pooled connection indefinitely and every later query waiting on that
 * pool fails too. Postgres cancels the statement; it never truncates a result.
 */
const SELF_JOIN_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Duplicate pairs returned when the caller names no preference.
 *
 * Frozen observed current-src value, reproduced so clients see the same default
 * shape from either server.
 */
const DEFAULT_PAIRS = 20;

/**
 * Alias-qualified preview expression per table.
 *
 * Written out per alias rather than derived by pattern-replacing column names,
 * for the reason `tiering.ts` records: a textual rewrite also edits matching
 * words inside string literals. These are static SQL fragments, never caller
 * input.
 */
function previewForAlias(table: ResourceTable, alias: string): string {
  switch (table) {
    case "thoughts":
      return `${alias}.content`;
    case "decisions":
      return `${alias}.title || ': ' || COALESCE(${alias}.rationale, '')`;
    case "relationships":
      return `${alias}.person_name || ': ' || COALESCE(${alias}.context, '')`;
    case "projects":
      return `${alias}.name || ': ' || COALESCE(${alias}.description, '')`;
    case "sessions":
      return `COALESCE(${alias}.project || ': ', '') || LEFT(${alias}.summary, 200)`;
  }
}

/**
 * Resolve the namespace set BOTH sides of the self-join are bound to.
 *
 * This is the #485 fix expressed as a total function: it returns a non-empty
 * list for every identity, so there is no branch in which the join runs
 * unscoped. A global role, which `namespacePredicate` would give an empty
 * clause, is bound to a concrete namespace here instead.
 *
 * @param requested Caller-supplied namespace, if any.
 * @returns The namespaces to scan, or `undefined` when the caller may not read
 *   the one it named.
 */
function scanNamespaces(
  identity: AuthIdentity,
  requested: string | undefined,
): readonly string[] | undefined {
  if (requested !== undefined) {
    return canTargetNamespace(identity, "read", requested)
      ? [requested]
      : undefined;
  }
  return [identity.clientId];
}

const findDuplicatesInputSchema = {
  table: tableEnum
    .optional()
    .describe("Optional: limit to a specific table (default: all)"),
  namespace: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Namespace to scan for duplicate pairs (defaults to the caller's own namespace)",
    ),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      `Cosine distance threshold for duplicates (default ${DUPLICATE_THRESHOLD}, lower = stricter)`,
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(`Max duplicate pairs to return (default ${DEFAULT_PAIRS})`),
};

const findDuplicatesAnnotations = {
  title: "Find Duplicates",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

interface FindDuplicatesArgs {
  readonly table?: string;
  readonly namespace?: string;
  readonly threshold?: number;
  readonly limit?: number;
}

/** One reported pair, in the frozen observed wire shape. */
interface DuplicatePair {
  entry_a: { id: string; preview: string };
  entry_b: { id: string; preview: string };
  table: string;
  distance: number;
}

/** The resolved, permission-checked scope of one duplicate scan. */
interface DuplicateScanScope {
  readonly namespaces: readonly string[];
  readonly tables: readonly ResourceTable[];
  readonly threshold: number;
  readonly wanted: number;
}

/**
 * Resolve the scope of one scan, or the reason the caller may not have it.
 *
 * Every denial message is returned verbatim so the two servers answer a refused
 * call identically. The namespace resolution is the #485 fix: `scanNamespaces`
 * is total, so a resolved scope can never carry an unscoped join.
 *
 * @returns The resolved scope, or a `denied` message to return as-is.
 */
function resolveDuplicateScanScope(
  identity: AuthIdentity,
  args: FindDuplicatesArgs,
): { scope: DuplicateScanScope } | { denied: string } {
  const namespaces = scanNamespaces(identity, args.namespace);
  if (namespaces === undefined) {
    return {
      denied: `Permission denied: cannot read namespace '${String(args.namespace)}'`,
    };
  }

  const requestedTables = args.table
    ? [args.table as ResourceTable]
    : ALL_TABLES;
  const tables = requestedTables.filter((table) =>
    canRead(identity.role, table),
  );
  if (tables.length === 0) {
    return { denied: "Permission denied: no readable tables" };
  }

  return {
    scope: {
      namespaces,
      tables,
      threshold: args.threshold ?? DUPLICATE_THRESHOLD,
      wanted: args.limit ?? DEFAULT_PAIRS,
    },
  };
}

/**
 * Query one table's nearest duplicate pairs within the resolved namespaces.
 *
 * BOTH sides of the self-join are bound to the same resolved namespace list.
 * Binding only one side still admits a cross-namespace pair, which is both an
 * isolation leak and the unbounded shape #485 measured.
 *
 * @param remaining Pairs still wanted, passed straight to `LIMIT`.
 * @returns The raw rows, nearest pair first.
 */
async function queryDuplicatePairs(options: {
  client: PoolClient;
  table: ResourceTable;
  scope: DuplicateScanScope;
  remaining: number;
}): Promise<Record<string, unknown>[]> {
  const { client, table, scope, remaining } = options;
  const { rows } = await client.query(
    `SELECT
       a.id AS id_a,
       LEFT(${previewForAlias(table, "a")}, ${PREVIEW_WIDTH}) AS preview_a,
       b.id AS id_b,
       LEFT(${previewForAlias(table, "b")}, ${PREVIEW_WIDTH}) AS preview_b,
       a.embedding <=> b.embedding AS distance
     FROM ${table} a
     JOIN ${table} b ON a.id < b.id
       AND b.archived_at IS NULL
       AND b.embedding IS NOT NULL
       AND b.namespace = ANY($3::text[])
     WHERE a.archived_at IS NULL
       AND a.embedding IS NOT NULL
       AND a.namespace = ANY($3::text[])
       AND a.embedding <=> b.embedding < $1
     ORDER BY distance ASC
     LIMIT $2`,
    [scope.threshold, remaining, scope.namespaces],
  );
  return rows;
}

/**
 * Scan every accessible table inside one bounded READ ONLY transaction.
 *
 * One connection covers the whole scan. Taking a fresh pooled connection per
 * table would re-arm the timeout each time but would also let a slow table hold
 * a connection the next table then waits for.
 *
 * @returns The pairs found, nearest first within each table, in table order.
 */
async function scanTablesForDuplicates(
  client: PoolClient,
  scope: DuplicateScanScope,
): Promise<DuplicatePair[]> {
  const duplicates: DuplicatePair[] = [];
  await client.query("BEGIN READ ONLY");
  await client.query("SELECT set_config('statement_timeout', $1, true)", [
    `${SELF_JOIN_STATEMENT_TIMEOUT_MS}ms`,
  ]);

  for (const table of scope.tables) {
    if (duplicates.length >= scope.wanted) break;
    const rows = await queryDuplicatePairs({
      client,
      table,
      scope,
      remaining: scope.wanted - duplicates.length,
    });

    for (const row of rows) {
      duplicates.push({
        entry_a: { id: row.id_a as string, preview: row.preview_a as string },
        entry_b: { id: row.id_b as string, preview: row.preview_b as string },
        table,
        distance: Number(row.distance),
      });
    }
  }
  await client.query("COMMIT");
  return duplicates;
}

/**
 * Log a failed scan and map it to the refusal the caller can act on.
 *
 * `57014` is a statement cancelled by the timeout above. It is reported as its
 * own refusal rather than a generic failure, because the caller CAN act on it:
 * narrowing the table or tightening the threshold makes the same call succeed.
 *
 * @returns The tool error response.
 */
function respondToScanFailure(
  dependencies: MemoryToolDependencies,
  error: unknown,
): ReturnType<typeof errorResult> {
  const code = (error as { code?: string } | null | undefined)?.code;
  dependencies.logger.error(
    {
      tool: "find_duplicates",
      errorName: error instanceof Error ? error.name : "unknown",
      errorCode: code,
    },
    "find_duplicates_error",
  );
  return errorResult(
    code === "57014"
      ? "Duplicate scan exceeded its time bound; narrow it with table or a stricter threshold"
      : "Database error during duplicate scan",
  );
}

async function handleFindDuplicates(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity | null | undefined,
  args: FindDuplicatesArgs,
) {
  if (!identity) return errorResult("Permission denied: not authenticated");

  const resolved = resolveDuplicateScanScope(identity, args);
  if ("denied" in resolved) return errorResult(resolved.denied);
  const { scope } = resolved;

  let duplicates: DuplicatePair[];
  const client = await dependencies.pool.connect();
  try {
    duplicates = await scanTablesForDuplicates(client, scope);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return respondToScanFailure(dependencies, error);
  } finally {
    client.release();
  }

  dependencies.logger.info(
    {
      tool: "find_duplicates",
      tablesScanned: scope.tables.length,
      duplicatesFound: duplicates.length,
    },
    "tool_result",
  );
  return textResult({
    threshold: scope.threshold,
    namespaces: scope.namespaces,
    duplicates_found: duplicates.length,
    duplicates,
  });
}

export function registerFindDuplicatesTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "find_duplicates",
    {
      description:
        "Discover potential duplicate entries using vector similarity. Read-only -- does NOT archive anything. " +
        "The pairwise scan is always bounded to one namespace: it defaults to the caller's own and can be pointed " +
        "at any namespace the caller may read.",
      inputSchema: findDuplicatesInputSchema,
      annotations: findDuplicatesAnnotations,
    },
    async (args, extra) =>
      handleFindDuplicates(dependencies, authIdentity(extra.authInfo), args),
  );
}
