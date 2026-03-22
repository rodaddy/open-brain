import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canRead } from "../permissions.ts";
import type { AuthInfo, Table } from "../types.ts";
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
  sessions: "COALESCE(s.project || ': ', '') || LEFT(s.summary, 200)",
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

export interface SearchRow {
  source_type: string;
  id: string;
  content_preview: string;
  tags: string[] | null;
  created_at: string;
  usefulness: number;
  distance?: number;
  fts_rank?: number;
}

export function buildTableCTE(table: Table): string {
  const alias = TABLE_ALIAS[table];
  const label = SOURCE_LABELS[table];
  const preview = CONTENT_PREVIEW[table];
  const cteName = `${table}_results`;

  return `${cteName} AS (
  SELECT
    '${label}' AS source_type,
    ${alias}.id,
    ${preview} AS content_preview,
    ${alias}.tags,
    ${alias}.created_at,
    ${alias}.embedding <=> (SELECT emb FROM query_embedding) AS distance,
    COALESCE(${alias}.usefulness_score, 0.5) AS usefulness
  FROM ${table} ${alias}
  WHERE ${alias}.embedding IS NOT NULL AND ${alias}.archived_at IS NULL
)`;
}

function buildFtsCTE(table: Table): string {
  const alias = TABLE_ALIAS[table];
  const label = SOURCE_LABELS[table];
  const preview = CONTENT_PREVIEW[table];
  const cteName = `${table}_fts`;

  return `${cteName} AS (
  SELECT
    '${label}' AS source_type,
    ${alias}.id,
    ${preview} AS content_preview,
    ${alias}.tags,
    ${alias}.created_at,
    ts_rank_cd(${alias}.search_vector, plainto_tsquery('english', (SELECT q FROM fts_query))) AS fts_rank,
    COALESCE(${alias}.usefulness_score, 0.5) AS usefulness
  FROM ${table} ${alias}
  WHERE ${alias}.search_vector @@ plainto_tsquery('english', (SELECT q FROM fts_query))
    AND ${alias}.archived_at IS NULL
)`;
}

async function vectorSearch(
  deps: ToolDeps,
  accessibleTables: Table[],
  embedding: number[],
  fetchLimit: number,
): Promise<SearchRow[]> {
  const ctes = accessibleTables.map(buildTableCTE);
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
LIMIT $2`;

  const { rows } = await deps.pool.query(sql, [toSql(embedding), fetchLimit]);
  return rows as SearchRow[];
}

async function ftsSearch(
  deps: ToolDeps,
  accessibleTables: Table[],
  query: string,
  fetchLimit: number,
): Promise<SearchRow[]> {
  const ctes = accessibleTables.map(buildFtsCTE);
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
LIMIT $2`;

  const { rows } = await deps.pool.query(sql, [query, fetchLimit]);
  return rows as SearchRow[];
}

/**
 * Reciprocal Rank Fusion: merge ranked lists from different scoring systems.
 * Items appearing in both lists get summed RRF scores (boosted).
 * Items in only one list get a single RRF score.
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
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map(({ row }) => row);
}

export function trackUsage(deps: ToolDeps, rows: SearchRow[]): void {
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

  void Promise.allSettled(trackingPromises).catch(() => {});
}

export async function executeSearch(
  deps: ToolDeps,
  accessibleTables: Table[],
  query: string,
  limit: number,
  mode: SearchMode = "hybrid",
): Promise<SearchRow[]> {
  if (mode === "keyword") {
    return ftsSearch(deps, accessibleTables, query, limit);
  }

  // Vector and hybrid both need an embedding
  const embedding = await deps.embedFn(query);
  if (!embedding) {
    // Fall back to keyword-only if embedding fails in hybrid mode
    if (mode === "hybrid") {
      logger.warn("embedding_failed_fallback_fts", {
        query: query.slice(0, 50),
      });
      return ftsSearch(deps, accessibleTables, query, limit);
    }
    // In vector mode, null embedding is a hard failure -- signal via thrown error
    throw new Error("Failed to generate query embedding");
  }

  if (mode === "vector") {
    return vectorSearch(deps, accessibleTables, embedding, limit);
  }

  // Hybrid: run both in parallel, merge with RRF
  const fetchLimit = limit * HYBRID_FETCH_MULTIPLIER;
  const [vectorRows, ftsRows] = await Promise.all([
    vectorSearch(deps, accessibleTables, embedding, fetchLimit),
    ftsSearch(deps, accessibleTables, query, fetchLimit),
  ]);

  return rrfMerge(vectorRows, ftsRows, limit);
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
          .max(50)
          .optional()
          .describe("Maximum results to return (default 10)"),
        search_mode: z
          .enum(["hybrid", "vector", "keyword"])
          .optional()
          .describe(
            "Search mode: hybrid (default) = vector + keyword with RRF fusion, vector = semantic only, keyword = full-text only",
          ),
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
      const mode = (args.search_mode as SearchMode) ?? "hybrid";

      let rows;
      try {
        rows = await executeSearch(
          deps,
          accessibleTables,
          args.query,
          limit,
          mode,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }

      trackUsage(deps, rows);

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
