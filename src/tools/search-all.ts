import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canRead } from "../permissions.ts";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { ALL_TABLES, buildTableCTE } from "./search-brain.ts";

interface UnifiedResult {
  source: "brain" | "qmd";
  type: string;
  content: string;
  score: number;
  id?: string;
  path?: string;
  tags?: string[];
  collection?: string;
}

interface QmdDocument {
  id?: string;
  path?: string;
  file?: string;
  content?: string;
  text?: string;
  preview?: string;
  score?: number;
  similarity?: number;
  collection?: string;
}

async function searchQmd(
  query: string,
  limit: number,
): Promise<UnifiedResult[]> {
  try {
    // Call qmd CLI directly (installed at /opt/qmd on server)
    const proc = Bun.spawn(
      [
        "bun",
        "/opt/qmd/src/qmd.ts",
        "search",
        query,
        "--json",
        "-n",
        String(limit),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      logger.warn("qmd search failed", { exitCode });
      return [];
    }

    const docs: QmdDocument[] = JSON.parse(stdout);
    if (!Array.isArray(docs)) return [];

    return docs.map((doc) => ({
      source: "qmd" as const,
      type: "file",
      content: (doc.content || doc.text || doc.preview || "").slice(0, 300),
      score: doc.score ?? doc.similarity ?? 0.5,
      path: doc.path || doc.file,
      collection: doc.collection,
    }));
  } catch (err) {
    logger.warn("qmd search error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export function registerSearchAll(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "search_all",
    {
      description:
        "Federated search across Open Brain knowledge AND qmd file index. Returns merged, ranked results from both sources.",
      inputSchema: {
        query: z.string().min(1).describe("Natural language search query"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results per source (default 10)"),
        sources: z
          .enum(["all", "brain", "qmd"])
          .optional()
          .describe("Which sources to search (default: all)"),
      },
      annotations: {
        title: "Search All",
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
              text: "Permission denied: not authenticated",
            },
          ],
          isError: true,
        };
      }

      const limit = args.limit ?? 10;
      const sources = (args.sources as "all" | "brain" | "qmd") ?? "all";
      const searchBrain = sources === "all" || sources === "brain";
      const searchQmdSource = sources === "all" || sources === "qmd";

      // Generate embedding for OB search (needed even if qmd-only, but skip if not)
      const embedding = searchBrain ? await deps.embedFn(args.query) : null;

      // Launch both searches in parallel
      const [brainResults, qmdResults] = await Promise.all([
        searchBrain && embedding
          ? searchOB(deps, auth, embedding, limit)
          : Promise.resolve([]),
        searchQmdSource ? searchQmd(args.query, limit) : Promise.resolve([]),
      ]);

      // Reciprocal Rank Fusion: merge results from different scoring systems
      // using position-based scoring: rrf = 1/(k + rank). k=60 is standard.
      // This ensures both sources get fair representation regardless of raw score scales.
      const RRF_K = 60;
      const withRrf: Array<UnifiedResult & { rrf: number }> = [];
      for (let i = 0; i < brainResults.length; i++) {
        withRrf.push({ ...brainResults[i]!, rrf: 1 / (RRF_K + i + 1) });
      }
      for (let i = 0; i < qmdResults.length; i++) {
        withRrf.push({ ...qmdResults[i]!, rrf: 1 / (RRF_K + i + 1) });
      }
      const merged = withRrf
        .sort((a, b) => b.rrf - a.rrf)
        .slice(0, limit)
        .map(({ rrf, ...rest }) => ({ ...rest, score: rrf }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              total: merged.length,
              brain_hits: brainResults.length,
              qmd_hits: qmdResults.length,
              results: merged,
            }),
          },
        ],
      };
    },
  );
}

async function searchOB(
  deps: ToolDeps,
  auth: AuthInfo,
  embedding: number[],
  limit: number,
): Promise<UnifiedResult[]> {
  const accessibleTables = ALL_TABLES.filter((t) => canRead(auth.role, t));
  if (accessibleTables.length === 0) return [];

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

  const { rows } = await deps.pool.query(sql, [toSql(embedding), limit]);

  // Fire-and-forget usage tracking
  if (rows.length > 0) {
    const byTable = new Map<Table, string[]>();
    for (const row of rows) {
      const table = tableFromLabel(row.source_type as string);
      if (!table) continue;
      const ids = byTable.get(table) ?? [];
      ids.push(row.id as string);
      byTable.set(table, ids);
    }
    for (const [table, ids] of byTable) {
      deps.pool
        .query(
          `UPDATE ${table} SET access_count = access_count + 1, last_accessed_at = NOW() WHERE id = ANY($1)`,
          [ids],
        )
        .catch(() => {});
    }
  }

  return rows.map((row) => ({
    source: "brain" as const,
    type: row.source_type as string,
    content: (row.content_preview as string).slice(0, 300),
    score: 1 - (row.distance as number), // invert distance to score (higher = better)
    id: row.id as string,
    tags: row.tags as string[],
  }));
}

const LABEL_TO_TABLE: Record<string, Table> = {
  thought: "thoughts",
  decision: "decisions",
  relationship: "relationships",
  project: "projects",
  session: "sessions",
};

function tableFromLabel(label: string): Table | undefined {
  return LABEL_TO_TABLE[label];
}
