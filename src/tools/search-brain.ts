import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canRead } from "../permissions.ts";
import type { AuthInfo, Table, Tier } from "../types.ts";
import type { ToolDeps } from "./index.ts";
import { logger } from "../logger.ts";

export const ALL_TABLES: Table[] = [
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
];

/** Singular labels for search results */
const SOURCE_LABELS: Record<Table, string> = {
  thoughts: "thought",
  decisions: "decision",
  relationships: "relationship",
  projects: "project",
  sessions: "session",
};

/** Reverse map: singular label -> table name for tracking UPDATEs */
const LABEL_TO_TABLE: Record<string, Table> = Object.fromEntries(
  Object.entries(SOURCE_LABELS).map(([table, label]) => [
    label,
    table as Table,
  ]),
) as Record<string, Table>;

/**
 * Content preview SQL expression per table.
 * Each produces a single text column normalized for search results.
 */
const CONTENT_PREVIEW: Record<Table, string> = {
  thoughts: "t.content",
  decisions: "d.title || ': ' || COALESCE(d.rationale, '')",
  relationships: "r.person_name || ': ' || COALESCE(r.context, '')",
  projects: "p.name || ': ' || COALESCE(p.description, '')",
  sessions:
    "COALESCE(s.project || ': ', '') || LEFT(s.summary, 300)" +
    " || CASE WHEN s.key_decisions IS NOT NULL AND array_length(s.key_decisions, 1) > 0" +
    " THEN E'\\nDecisions: ' || immutable_array_to_string(s.key_decisions, '; ') ELSE '' END" +
    " || CASE WHEN s.next_steps IS NOT NULL AND array_length(s.next_steps, 1) > 0" +
    " THEN E'\\nNext: ' || immutable_array_to_string(s.next_steps, '; ') ELSE '' END",
};

/** Table alias used in CTE SELECTs */
const TABLE_ALIAS: Record<Table, string> = {
  thoughts: "t",
  decisions: "d",
  relationships: "r",
  projects: "p",
  sessions: "s",
};

export type SearchMode = "hybrid" | "vector" | "keyword";

/** RRF constant -- standard value from Cormack et al. 2009 */
const RRF_K = 60;

/** Over-fetch multiplier for hybrid mode (fetch N*3 from each path, merge to N) */
const HYBRID_FETCH_MULTIPLIER = 3;

/** Tier-based RRF score adjustments for cognitive tiering */
export const TIER_BOOST: Record<Tier, number> = {
  hot: 0.3,
  warm: 0,
  cold: -0.2,
};

export interface SearchRow {
  source_type: string;
  id: string;
  content_preview: string;
  tags: string[] | null;
  created_at: string;
  usefulness: number;
  tier?: string;
  distance?: number;
  fts_rank?: number;
  access_count?: number;
  extracted_metadata?: {
    topics?: string[];
    people?: string[];
    action_items?: string[];
    dates?: string[];
  };
}

const HAS_EXTRACTED_METADATA: Set<Table> = new Set(["thoughts", "decisions"]);

export function buildTableCTE(table: Table, tier?: Tier): string {
  const alias = TABLE_ALIAS[table];
  const label = SOURCE_LABELS[table];
  const preview = CONTENT_PREVIEW[table];
  const cteName = `${table}_results`;
  const tierFilter = tier ? ` AND ${alias}.tier = '${tier}'` : "";
  const metaCol = HAS_EXTRACTED_METADATA.has(table)
    ? `${alias}.extracted_metadata`
    : "NULL::jsonb AS extracted_metadata";

  return `${cteName} AS (
  SELECT
    '${label}' AS source_type,
    ${alias}.id,
    ${preview} AS content_preview,
    ${alias}.tags,
    ${alias}.created_at,
    ${alias}.tier,
    ${alias}.embedding <=> (SELECT emb FROM query_embedding) AS distance,
    COALESCE(${alias}.usefulness_score, 0.5) AS usefulness,
    COALESCE(${alias}.access_count, 0) AS access_count,
    ${metaCol}
  FROM ${table} ${alias}
  WHERE ${alias}.embedding IS NOT NULL AND ${alias}.archived_at IS NULL${tierFilter}
)`;
}

function buildFtsCTE(table: Table, tier?: Tier): string {
  const alias = TABLE_ALIAS[table];
  const label = SOURCE_LABELS[table];
  const preview = CONTENT_PREVIEW[table];
  const cteName = `${table}_fts`;
  const tierFilter = tier ? ` AND ${alias}.tier = '${tier}'` : "";

  const metaCol = HAS_EXTRACTED_METADATA.has(table)
    ? `${alias}.extracted_metadata`
    : "NULL::jsonb AS extracted_metadata";

  return `${cteName} AS (
  SELECT
    '${label}' AS source_type,
    ${alias}.id,
    ${preview} AS content_preview,
    ${alias}.tags,
    ${alias}.created_at,
    ${alias}.tier,
    ts_rank_cd(${alias}.search_vector, plainto_tsquery('english', (SELECT q FROM fts_query))) AS fts_rank,
    COALESCE(${alias}.usefulness_score, 0.5) AS usefulness,
    COALESCE(${alias}.access_count, 0) AS access_count,
    ${metaCol}
  FROM ${table} ${alias}
  WHERE ${alias}.search_vector @@ plainto_tsquery('english', (SELECT q FROM fts_query))
    AND ${alias}.archived_at IS NULL${tierFilter}
)`;
}

async function vectorSearch(
  deps: ToolDeps,
  accessibleTables: Table[],
  embedding: number[],
  fetchLimit: number,
  tier?: Tier,
  offset = 0,
): Promise<SearchRow[]> {
  const ctes = accessibleTables.map((t) => buildTableCTE(t, tier));
  const cteNames = accessibleTables.map((t) => `${t}_results`);
  const unionAll = cteNames
    .map((name) => `SELECT * FROM ${name}`)
    .join("\nUNION ALL\n");

  const sql = `WITH query_embedding AS (
  SELECT $1::halfvec(768) AS emb
),
${ctes.join(",\n")}
SELECT * FROM (
${unionAll}
) AS combined
ORDER BY (distance * 0.8 + (1.0 - COALESCE(usefulness, 0.5)) * 0.2) ASC
LIMIT $2 OFFSET $3`;

  const { rows } = await deps.pool.query(sql, [
    toSql(embedding),
    fetchLimit,
    offset,
  ]);
  return rows as SearchRow[];
}

async function ftsSearch(
  deps: ToolDeps,
  accessibleTables: Table[],
  query: string,
  fetchLimit: number,
  tier?: Tier,
  offset = 0,
): Promise<SearchRow[]> {
  const ctes = accessibleTables.map((t) => buildFtsCTE(t, tier));
  const cteNames = accessibleTables.map((t) => `${t}_fts`);
  const unionAll = cteNames
    .map((name) => `SELECT * FROM ${name}`)
    .join("\nUNION ALL\n");

  const sql = `WITH fts_query AS (
  SELECT $1::text AS q
),
${ctes.join(",\n")}
SELECT * FROM (
${unionAll}
) AS combined
ORDER BY fts_rank DESC
LIMIT $2 OFFSET $3`;

  const { rows } = await deps.pool.query(sql, [query, fetchLimit, offset]);
  return rows as SearchRow[];
}

/**
 * Reciprocal Rank Fusion: merge ranked lists from different scoring systems.
 * Items appearing in both lists get summed RRF scores (boosted).
 * Items in only one list get a single RRF score.
 * Hot entries get +0.3 boost, cold entries get -0.2, warm is unchanged.
 */
function rrfMerge(
  vectorRows: SearchRow[],
  ftsRows: SearchRow[],
  limit: number,
): SearchRow[] {
  const scoreMap = new Map<string, { row: SearchRow; rrf: number }>();

  for (let i = 0; i < vectorRows.length; i++) {
    const row = vectorRows[i]!;
    const key = `${row.source_type}:${row.id}`;
    scoreMap.set(key, { row, rrf: 1 / (RRF_K + i + 1) });
  }

  for (let i = 0; i < ftsRows.length; i++) {
    const row = ftsRows[i]!;
    const key = `${row.source_type}:${row.id}`;
    const existing = scoreMap.get(key);
    if (existing) {
      existing.rrf += 1 / (RRF_K + i + 1);
    } else {
      scoreMap.set(key, { row, rrf: 1 / (RRF_K + i + 1) });
    }
  }

  return Array.from(scoreMap.values())
    .map(({ row, rrf }) => ({
      row,
      rrf: Math.max(0, rrf + TIER_BOOST[(row.tier ?? "warm") as Tier]),
    }))
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map(({ row }) => row);
}

export function trackUsage(
  deps: ToolDeps,
  rows: SearchRow[],
  queryText: string,
  context = "search",
): void {
  if (rows.length === 0) return;

  const byTable = new Map<Table, string[]>();
  for (const row of rows) {
    const table = LABEL_TO_TABLE[row.source_type];
    if (!table) continue;
    const ids = byTable.get(table) ?? [];
    ids.push(row.id);
    byTable.set(table, ids);
  }

  const trackingPromises: Promise<unknown>[] = [];
  for (const [table, ids] of byTable) {
    trackingPromises.push(
      deps.pool
        .query(
          `UPDATE ${table} SET access_count = access_count + 1, last_accessed_at = NOW() WHERE id = ANY($1)`,
          [ids],
        )
        .catch((err: unknown) => {
          logger.warn("search_tracking_error", {
            table,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
    );
  }

  // Bulk-insert into entry_access_log for all returned entries
  const logRows = rows.filter((r) => LABEL_TO_TABLE[r.source_type]);
  if (logRows.length > 0) {
    const entryIds = logRows.map((r) => r.id);
    const sourceTables = logRows.map((r) => LABEL_TO_TABLE[r.source_type]);
    trackingPromises.push(
      deps.pool
        .query(
          `INSERT INTO entry_access_log (entry_id, source_table, accessed_at, query_text, context)
           SELECT unnest($1::uuid[]), unnest($2::text[]), NOW(), $3, $4`,
          [entryIds, sourceTables, queryText, context],
        )
        .catch((err: unknown) => {
          logger.warn("access_log_error", {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
    );
  }

  void Promise.allSettled(trackingPromises).catch(() => {});
}

export async function executeSearch(
  deps: ToolDeps,
  accessibleTables: Table[],
  query: string,
  limit: number,
  mode: SearchMode = "hybrid",
  tier?: Tier,
  offset = 0,
): Promise<SearchRow[]> {
  if (mode === "keyword") {
    return ftsSearch(deps, accessibleTables, query, limit, tier, offset);
  }

  // Vector and hybrid both need an embedding
  const embedding = await deps.embedFn(query);
  if (!embedding) {
    // Fall back to keyword-only if embedding fails in hybrid mode
    if (mode === "hybrid") {
      logger.warn("embedding_failed_fallback_fts", {
        query: query.slice(0, 50),
      });
      return ftsSearch(deps, accessibleTables, query, limit, tier, offset);
    }
    // In vector mode, null embedding is a hard failure -- signal via thrown error
    throw new Error("Failed to generate query embedding");
  }

  if (mode === "vector") {
    return vectorSearch(deps, accessibleTables, embedding, limit, tier, offset);
  }

  // Hybrid: run both in parallel, merge with RRF
  // Over-fetch to cover offset + limit, then slice after merge
  const totalNeeded = offset + limit;
  const fetchLimit = totalNeeded * HYBRID_FETCH_MULTIPLIER;
  const [vectorRows, ftsRows] = await Promise.all([
    vectorSearch(deps, accessibleTables, embedding, fetchLimit, tier),
    ftsSearch(deps, accessibleTables, query, fetchLimit, tier),
  ]);

  const merged = rrfMerge(vectorRows, ftsRows, totalNeeded);
  return merged.slice(offset);
}

export function registerSearchBrain(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "search_brain",
    {
      description:
        "Search across all brain tables. Supports hybrid (vector + keyword), pure vector, or keyword-only modes.",
      inputSchema: {
        query: z.string().min(1).describe("Natural language search query"),
        table: z
          .enum([
            "thoughts",
            "decisions",
            "relationships",
            "projects",
            "sessions",
          ])
          .optional()
          .describe("Optional: limit search to a specific table"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(250)
          .optional()
          .describe("Maximum results to return (default 10)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Number of results to skip for pagination (default 0)"),
        search_mode: z
          .enum(["hybrid", "vector", "keyword"])
          .optional()
          .describe(
            "Search mode: hybrid (default) = vector + keyword with RRF fusion, vector = semantic only, keyword = full-text only",
          ),
        tier: z
          .enum(["hot", "warm", "cold"])
          .optional()
          .describe("Optional: filter results to a specific cognitive tier"),
      },
      annotations: {
        title: "Search Brain",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: no readable tables",
            },
          ],
          isError: true,
        };
      }

      const tableFilter = args.table as Table | undefined;
      let accessibleTables: Table[];

      if (tableFilter) {
        if (!canRead(auth.role, tableFilter)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Permission denied: cannot read ${tableFilter}`,
              },
            ],
            isError: true,
          };
        }
        accessibleTables = [tableFilter];
      } else {
        accessibleTables = ALL_TABLES.filter((t) => canRead(auth.role, t));
      }

      if (accessibleTables.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: no readable tables",
            },
          ],
          isError: true,
        };
      }

      const limit = args.limit ?? 10;
      const offset = args.offset ?? 0;
      const mode = (args.search_mode as SearchMode) ?? "hybrid";
      const tier = args.tier as Tier | undefined;

      let rows;
      try {
        rows = await executeSearch(
          deps,
          accessibleTables,
          args.query,
          limit,
          mode,
          tier,
          offset,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }

      trackUsage(deps, rows, args.query);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(rows),
          },
        ],
      };
    },
  );
}
/**
 * Build a namespace filter SQL clause.
 * Inlines namespace values as a SQL array literal (safe for known internal values).
 * If namespaces is null (admin/no filter), returns empty string.
 */
export function buildNsClause(
  alias: string,
  namespaces: string[] | null,
): string {
  if (!namespaces || namespaces.length === 0) return "";
  const escaped = namespaces
    .map((ns) => "'" + ns.replace(/'/g, "''") + "'")
    .join(",");
  return ` AND ${alias}.namespace IN (${escaped})`;
}
