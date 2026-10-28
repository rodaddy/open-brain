/**
 * `find_duplicates`: pairwise vector-similarity duplicate discovery. READ-ONLY
 * -- it reports pairs and archives nothing; acting on a pair is a separate
 * explicit `bulk_archive` call. The self-join is always namespace-bounded,
 * including for a global role, and runs in a bounded READ ONLY transaction.
 *
 * Why it is bounded, with the measured #485 defect behind it:
 * See docs/decisions/1214-find-duplicates-namespace-bounded-self-join.md
 *
 * Design authority: docs/decisions/cognitive-tiering-dream-cycle.md and
 * docs/decisions/privilege-isolation-closed-brain.md
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createEntryWriteRepository,
  type EntryWriteRepository,
} from "../db/entry-write-repository.ts";
import { withTransaction } from "../db/transaction.ts";
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
    return canTargetNamespace(identity, "read", requested) ? [requested] : undefined;
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

  const requestedTables = args.table ? [args.table as ResourceTable] : ALL_TABLES;
  const tables = requestedTables.filter((table) => canRead(identity.role, table));
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
  repository: EntryWriteRepository;
  table: ResourceTable;
  scope: DuplicateScanScope;
  remaining: number;
}): Promise<Record<string, unknown>[]> {
  const { repository, table, scope, remaining } = options;
  return repository.selectDuplicatePairs({
    table,
    previewA: previewForAlias(table, "a"),
    previewB: previewForAlias(table, "b"),
    previewWidth: PREVIEW_WIDTH,
    threshold: scope.threshold,
    remaining,
    namespaces: scope.namespaces,
  });
}

/**
 * Scan every accessible table through one repository bound to one transaction.
 *
 * The caller opens that transaction READ ONLY with the statement timeout, so
 * one connection covers the whole scan. Taking a fresh pooled connection per
 * table would re-arm the timeout each time but would also let a slow table hold
 * a connection the next table then waits for.
 *
 * @returns The pairs found, nearest first within each table, in table order.
 */
async function scanTablesForDuplicates(
  repository: EntryWriteRepository,
  scope: DuplicateScanScope,
): Promise<DuplicatePair[]> {
  const duplicates: DuplicatePair[] = [];

  for (const table of scope.tables) {
    if (duplicates.length >= scope.wanted) break;
    const rows = await queryDuplicatePairs({
      repository,
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
  try {
    duplicates = await withTransaction({
      pool: dependencies.pool,
      readOnly: true,
      statementTimeoutMs: SELF_JOIN_STATEMENT_TIMEOUT_MS,
      run: async (tx) => scanTablesForDuplicates(createEntryWriteRepository(tx), scope),
      onRollbackFailure: (rollbackError: unknown) => {
        dependencies.logger.warn(
          {
            tool: "find_duplicates",
            errorName: rollbackError instanceof Error ? rollbackError.name : "unknown",
          },
          "find_duplicates_rollback_failed",
        );
      },
    });
  } catch (error) {
    return respondToScanFailure(dependencies, error);
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
