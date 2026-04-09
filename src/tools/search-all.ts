import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import type { AuthInfo, Tier } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import {
  ALL_TABLES,
  executeSearch,
  trackUsage,
  TIER_BOOST,
  type SearchMode,
  type SearchRow,
} from "./search-brain.ts";

interface UnifiedResult {
  source: "brain" | "qmd";
  type: string;
  content: string;
  score: number;
  id?: string;
  path?: string;
  tags?: string[];
  collection?: string;
  tier?: string;
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
          .max(250)
          .optional()
          .describe("Max results per source (default 10)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Number of results to skip for pagination (default 0)"),
        sources: z
          .enum(["all", "brain", "qmd"])
          .optional()
          .describe("Which sources to search (default: all)"),
        search_mode: z
          .enum(["hybrid", "vector", "keyword"])
          .optional()
          .describe(
            "Brain search mode: hybrid (default) = vector + keyword with RRF, vector = semantic only, keyword = full-text only",
          ),
        tier: z
          .enum(["hot", "warm", "cold"])
          .optional()
          .describe(
            "Optional: filter brain results to a specific cognitive tier",
          ),
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
      const offset = args.offset ?? 0;
      const sources = (args.sources as "all" | "brain" | "qmd") ?? "all";
      const mode = (args.search_mode as SearchMode) ?? "hybrid";
      const tier = args.tier as Tier | undefined;
      const searchBrain = sources === "all" || sources === "brain";
      const searchQmdSource = sources === "all" || sources === "qmd";

      // Over-fetch to cover offset + limit, then slice after merge
      const totalNeeded = offset + limit;

      // Launch both searches in parallel
      const [brainResults, qmdResults] = await Promise.all([
        searchBrain
          ? searchOB(deps, auth, args.query, totalNeeded, mode, tier)
          : Promise.resolve([]),
        searchQmdSource
          ? searchQmd(args.query, totalNeeded)
          : Promise.resolve([]),
      ]);

      // Reciprocal Rank Fusion: merge results from different scoring systems
      // using position-based scoring: rrf = 1/(k + rank). k=60 is standard.
      // This ensures both sources get fair representation regardless of raw score scales.
      // Brain entries also receive a tier boost: hot=+0.3, cold=-0.2, warm=0.
      const RRF_K = 60;
      const withRrf: Array<UnifiedResult & { rrf: number }> = [];
      for (let i = 0; i < brainResults.length; i++) {
        const result = brainResults[i]!;
        const boost = TIER_BOOST[(result.tier ?? "warm") as Tier];
        withRrf.push({ ...result, rrf: 1 / (RRF_K + i + 1) + boost });
      }
      for (let i = 0; i < qmdResults.length; i++) {
        withRrf.push({ ...qmdResults[i]!, rrf: 1 / (RRF_K + i + 1) });
      }
      const merged = withRrf
        .sort((a, b) => b.rrf - a.rrf)
        .slice(offset, offset + limit)
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
  query: string,
  limit: number,
  mode: SearchMode = "hybrid",
  tier?: Tier,
): Promise<UnifiedResult[]> {
  const accessibleTables = ALL_TABLES.filter((t) => canRead(auth.role, t));
  if (accessibleTables.length === 0) return [];

  let rows: SearchRow[];
  try {
    rows = await executeSearch(
      deps,
      accessibleTables,
      query,
      limit,
      mode,
      tier,
    );
  } catch (err) {
    logger.warn("searchOB_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  trackUsage(deps, rows, query);

  return rows.map((row) => ({
    source: "brain" as const,
    type: row.source_type,
    content: row.content_preview.slice(0, 300),
    score: row.distance != null ? 1 - row.distance : (row.fts_rank ?? 0.5),
    id: row.id,
    tags: row.tags ?? undefined,
    tier: row.tier,
  }));
}
