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
import type { ResourceTable } from "../auth/types.ts";
import { canRead } from "../auth/permissions.ts";
import { authIdentity, errorResult, textResult, type MemoryToolDependencies } from "./types.ts";
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
  const archiveFilter = includeArchived ? "" : ` AND ${alias}.archived_at IS NULL`;
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

export function registerListRecentTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "list_recent",
    {
      description:
        "List recent brain entries chronologically. Returns {entries, total_count, has_more} envelope by default, " +
        "or raw array with response_format='array'. " +
        "Resilient parsing: const entries = Array.isArray(result) ? result : result.entries ?? [];",
      inputSchema: {
        table: z
          .enum([
            "thoughts",
            "decisions",
            "relationships",
            "projects",
            "sessions",
          ])
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
      },
      annotations: {
        title: "List Recent",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return errorResult(NO_READABLE_TABLES);

      const requested = args.table as ResourceTable | undefined;
      let tables: ResourceTable[];
      if (requested) {
        if (!canRead(identity.role, requested)) {
          return errorResult(`Permission denied: cannot read ${requested}`);
        }
        tables = [requested];
      } else {
        tables = ALL_TABLES.filter((table) => canRead(identity.role, table));
      }
      if (tables.length === 0) return errorResult(NO_READABLE_TABLES);

      const days = args.days ?? 7;
      const limit = args.limit ?? 20;
      const offset = args.offset ?? 0;
      const includeArchived = args.include_archived ?? false;
      const tier = args.tier as Tier | undefined;
      const asArray = args.response_format === "array";

      // `undefined` here means a global read, which is only reachable for a role
      // whose reads are global by design; every other role gets the predicate.
      const readable = readableNamespaces(identity);
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

      const dataParams = readable
        ? [days, limit, offset, readable]
        : [days, limit, offset];
      const countParams = readable ? [days, readable] : [days];

      const [dataResult, countResult] = await Promise.all([
        dependencies.pool.query(dataSql, dataParams),
        // Independently recoverable: the entries are the answer, the count is a
        // convenience, so a failed count yields null rather than failing the call.
        dependencies.pool.query(countSql, countParams).catch((error: unknown) => {
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

      if (asArray) return textResult(dataResult.rows);

      return textResult({
        entries: dataResult.rows,
        total_count: totalCount,
        offset,
        limit,
        // Unknowable without a count, and `false` is the honest answer there:
        // it claims no knowledge of further pages rather than inventing one.
        has_more:
          totalCount !== null ? offset + dataResult.rows.length < totalCount : false,
      });
    },
  );
}
