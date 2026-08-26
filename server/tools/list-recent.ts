/**
 * `list_recent` — chronological listing of recent brain entries.
 *
 * Design authority: `docs/decisions/privilege-isolation-closed-brain.md`
 * (namespace isolation is enforced server-side from token-derived identity).
 *
 * This is the browse surface, not the search surface: no query, no ranking, no
 * embedding. It answers "what went in lately" across every readable table, which
 * is the question `search_brain` cannot answer because there is nothing to match
 * against.
 *
 * TWO RESPONSE SHAPES, AND THE DEFAULT IS THE ENVELOPE. `response_format:
 * "array"` returns the bare row array that older clients parse; the default
 * returns `{entries, total_count, offset, limit, has_more}` because a bare array
 * cannot express whether more results exist — a caller receiving exactly `limit`
 * rows cannot tell a full page from the last one. Both shapes are part of the
 * frozen contract; the tool description tells clients how to accept either.
 *
 * `total_count` is allowed to be `null`. The count query runs alongside the data
 * query and is independently recoverable: if counting fails, the entries are
 * still returned with a null count rather than failing the whole call, because
 * the rows are the answer and the count is a convenience.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import { canRead } from "../auth/permissions.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import { readableNamespaces } from "./read-scope.ts";
import {
  ALL_TABLES,
  CONTENT_PREVIEW,
  SOURCE_LABELS,
  TABLE_ALIAS,
  VALID_TIERS,
  type Tier,
} from "./search-constants.ts";

const NO_READABLE_TABLES = "Permission denied: no readable tables";

/**
 * Shared WHERE clause for both the data and count queries.
 *
 * Both queries MUST use identical predicates. A count computed over a different
 * predicate than the rows produces a `has_more` that lies in whichever direction
 * the predicates differ, which is worse than no count at all.
 *
 * `$1` is always the day window. The namespace parameter index differs between
 * the two queries because they bind different numbers of preceding parameters,
 * so it is passed in rather than assumed.
 */
function buildWhereClause(
  alias: string,
  includeArchived: boolean,
  tier: Tier | undefined,
  namespaceParamIndex: number | undefined,
): string {
  const archiveFilter = includeArchived
    ? ""
    : ` AND ${alias}.archived_at IS NULL`;
  const tierFilter = tier ? ` AND ${alias}.tier = '${tier}'` : "";
  const namespaceFilter = namespaceParamIndex
    ? ` AND ${alias}.namespace = ANY($${namespaceParamIndex}::text[])`
    : "";
  return `WHERE ${alias}.created_at >= NOW() - INTERVAL '1 day' * $1${archiveFilter}${tierFilter}${namespaceFilter}`;
}

/** Reject a tier that is not on the allowlist before it can reach SQL. */
function assertTier(tier: Tier | undefined): void {
  if (tier && !VALID_TIERS.has(tier)) throw new Error(`Invalid tier: ${tier}`);
}

/** Build one table's row SELECT for the UNION. */
function buildTableSelect(
  table: ResourceTable,
  includeArchived: boolean,
  tier: Tier | undefined,
  namespaceParamIndex: number | undefined,
): string {
  assertTier(tier);
  const alias = TABLE_ALIAS[table];
  return `SELECT
    '${SOURCE_LABELS[table]}' AS source_type,
    ${alias}.id,
    ${CONTENT_PREVIEW[table]} AS content_preview,
    ${alias}.tags,
    ${alias}.tier,
    ${alias}.created_at
  FROM ${table} ${alias}
  ${buildWhereClause(alias, includeArchived, tier, namespaceParamIndex)}`;
}

/** Build one table's count SELECT for the UNION. */
function buildCountSelect(
  table: ResourceTable,
  includeArchived: boolean,
  tier: Tier | undefined,
  namespaceParamIndex: number | undefined,
): string {
  assertTier(tier);
  const alias = TABLE_ALIAS[table];
  return `SELECT COUNT(*) AS cnt
  FROM ${table} ${alias}
  ${buildWhereClause(alias, includeArchived, tier, namespaceParamIndex)}`;
}

const listRecentDescription =
  "List recent brain entries chronologically. Returns {entries, total_count, has_more} envelope by default, " +
  "or raw array with response_format='array'. " +
  "Resilient parsing: const entries = Array.isArray(result) ? result : result.entries ?? [];";

const listRecentInputSchema = {
  table: z
    .enum(["thoughts", "decisions", "relationships", "projects", "sessions"])
    .optional()
    .describe("Optional: filter to a specific table"),
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe("Number of days to look back (default 7)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Maximum entries to return (default 20, max 500)"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of entries to skip for pagination (default 0)"),
  include_archived: z
    .boolean()
    .optional()
    .describe("Include archived entries (default false)"),
  tier: z
    .enum(["hot", "warm", "cold"])
    .optional()
    .describe("Optional: filter to a specific cognitive tier"),
  response_format: z
    .enum(["envelope", "array"])
    .optional()
    .describe(
      "Response format: 'envelope' (default) returns {entries, total_count, has_more}; 'array' returns raw array for backwards compatibility",
    ),
};

const listRecentAnnotations = {
  title: "List Recent",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

/** The `list_recent` arguments as published by {@link listRecentInputSchema}. */
interface ListRecentArgs {
  readonly table?: string;
  readonly days?: number;
  readonly limit?: number;
  readonly offset?: number;
  readonly include_archived?: boolean;
  readonly tier?: string;
  readonly response_format?: string;
}

/** The arguments after the documented defaults are applied. */
interface ListRecentRequest {
  readonly days: number;
  readonly limit: number;
  readonly offset: number;
  readonly includeArchived: boolean;
  readonly tier: Tier | undefined;
  readonly asArray: boolean;
}

/**
 * Apply the documented argument defaults.
 *
 * These defaults are part of the frozen client contract, so they live in one
 * place rather than inline where a later edit could move one and not the other.
 *
 * @param args Caller-supplied arguments, already schema-validated.
 * @returns The normalized request.
 */
function normalizeListRecentArgs(args: ListRecentArgs): ListRecentRequest {
  return {
    days: args.days ?? 7,
    limit: args.limit ?? 20,
    offset: args.offset ?? 0,
    includeArchived: args.include_archived ?? false,
    tier: args.tier as Tier | undefined,
    asArray: args.response_format === "array",
  };
}

/**
 * Resolve which tables this identity may list, or the reason it may not.
 *
 * The role gate runs against the table the caller named so an unreadable table
 * is denied by name, rather than silently widening to the readable set.
 *
 * @param identity Token-derived identity.
 * @param requested The caller-supplied table argument, if any.
 * @returns The readable tables, or a `denied` message to return verbatim.
 */
function resolveListRecentTables(
  identity: AuthIdentity,
  requested: ResourceTable | undefined,
): { tables: ResourceTable[] } | { denied: string } {
  if (requested) {
    if (!canRead(identity.role, requested)) {
      return { denied: `Permission denied: cannot read ${requested}` };
    }
    return { tables: [requested] };
  }
  const tables = ALL_TABLES.filter((table) => canRead(identity.role, table));
  if (tables.length === 0) return { denied: NO_READABLE_TABLES };
  return { tables };
}

/** The two SQL strings and the parameters each one binds. */
interface ListRecentQueries {
  readonly dataSql: string;
  readonly dataParams: unknown[];
  readonly countSql: string;
  readonly countParams: unknown[];
}

/**
 * Build the data and count queries for one listing.
 *
 * @param options Readable tables, the normalized request, and the readable
 *   namespaces (`undefined` for a role whose reads are global by design).
 * @returns Both queries with their bound parameters.
 */
function buildListRecentQueries(options: {
  tables: readonly ResourceTable[];
  request: ListRecentRequest;
  readable: string[] | undefined;
}): ListRecentQueries {
  const { tables, request, readable } = options;
  const { days, limit, offset, includeArchived, tier } = request;
  // The data query binds days/limit/offset first, so namespaces land at $4.
  // The count query binds only days, so they land at $2. Getting these two
  // indexes crossed would silently constrain the wrong parameter.
  const dataNamespaceIndex = readable ? 4 : undefined;
  const countNamespaceIndex = readable ? 2 : undefined;

  const dataSql = `${tables
    .map((table) =>
      buildTableSelect(table, includeArchived, tier, dataNamespaceIndex),
    )
    .join("\nUNION ALL\n")}\nORDER BY created_at DESC\nLIMIT $2 OFFSET $3`;

  const countSql = `SELECT SUM(cnt)::int AS total_count FROM (${tables
    .map((table) =>
      buildCountSelect(table, includeArchived, tier, countNamespaceIndex),
    )
    .join("\nUNION ALL\n")}) counts`;

  return {
    dataSql,
    dataParams: readable
      ? [days, limit, offset, readable]
      : [days, limit, offset],
    countSql,
    countParams: readable ? [days, readable] : [days],
  };
}

/**
 * Run the data query and the independently-recoverable count query together.
 *
 * A failed count yields `null` rather than failing the call: the rows are the
 * answer and the count is a convenience.
 *
 * @param options The built queries and the pool/logger they run against.
 * @returns The data rows and the total count, which may be `null`.
 */
async function runListRecentQueries(options: {
  queries: ListRecentQueries;
  dependencies: MemoryToolDependencies;
}): Promise<{ rows: unknown[]; totalCount: number | null }> {
  const { queries, dependencies } = options;
  const [dataResult, countResult] = await Promise.all([
    dependencies.pool.query(queries.dataSql, queries.dataParams),
    // Independently recoverable: the entries are the answer, the count is a
    // convenience, so a failed count yields null rather than failing the call.
    dependencies.pool
      .query(queries.countSql, queries.countParams)
      .catch((error: unknown) => {
        dependencies.logger.warn(
          {
            error_message:
              error instanceof Error ? error.message : String(error),
          },
          "list_recent_count_failed",
        );
        return null;
      }),
  ]);

  const totalCount =
    (countResult?.rows[0] as { total_count?: number } | undefined)
      ?.total_count ?? null;

  return { rows: dataResult.rows, totalCount };
}

/**
 * Shape the response in whichever of the two frozen formats the caller asked for.
 *
 * @param options The rows, the count, and the normalized request.
 * @returns The tool result.
 */
function listRecentResult(options: {
  rows: unknown[];
  totalCount: number | null;
  request: ListRecentRequest;
}) {
  const { rows, totalCount, request } = options;
  if (request.asArray) return textResult(rows);
  return textResult({
    entries: rows,
    total_count: totalCount,
    offset: request.offset,
    limit: request.limit,
    // Unknowable without a count, and `false` is the honest answer there:
    // it claims no knowledge of further pages rather than inventing one.
    has_more:
      totalCount !== null ? request.offset + rows.length < totalCount : false,
  });
}

export function registerListRecentTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "list_recent",
    {
      description: listRecentDescription,
      inputSchema: listRecentInputSchema,
      annotations: listRecentAnnotations,
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return errorResult(NO_READABLE_TABLES);

      const scope = resolveListRecentTables(
        identity,
        args.table as ResourceTable | undefined,
      );
      if ("denied" in scope) return errorResult(scope.denied);

      const request = normalizeListRecentArgs(args);
      // `undefined` here means a global read, which is only reachable for a role
      // whose reads are global by design; every other role gets the predicate.
      const readable = readableNamespaces(
        identity,
        {},
        dependencies.sharedNamespaceNames,
      );
      const queries = buildListRecentQueries({
        tables: scope.tables,
        request,
        readable,
      });
      const { rows, totalCount } = await runListRecentQueries({
        queries,
        dependencies,
      });
      return listRecentResult({ rows, totalCount, request });
    },
  );
}
