/**
 * Direct JSON-RPC handler for stateless MCP clients.
 *
 * Bypasses the MCP SDK's StreamableHTTPServerTransport entirely.
 * Plain JSON in, plain JSON out -- no SSE, no sessions, no initialization.
 *
 * Supports: tools/list, tools/call
 * Clients: mcp2cli, curl, n8n webhooks, any HTTP client
 */

import type pg from "pg";
import type { generateEmbedding } from "./embedding.ts";
import { canRead } from "./permissions.ts";
import {
  ALL_TABLES,
  executeSearch,
  trackUsage,
  type SearchMode,
} from "./tools/search-brain.ts";
import type { AuthInfo, Table, Tier } from "./types.ts";
import { logger } from "./logger.ts";

interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: any;
  id?: string | number | null;
}

interface JsonRpcResponse {
  jsonrpc: string;
  result?: any;
  error?: { code: number; message: string; data?: any };
  id: string | number | null;
}

export interface ToolDeps {
  pool: pg.Pool;
  embedFn: typeof generateEmbedding;
}

/** Tool registry -- maps tool names to handler functions */
type ToolHandler = (
  args: Record<string, any>,
  auth: AuthInfo,
  deps: ToolDeps,
) => Promise<any>;

const TOOL_SCHEMAS: Record<string, { description: string; inputSchema: any }> =
  {
    search_brain: {
      description:
        "Search across all brain tables. Supports hybrid (vector + keyword), pure vector, or keyword-only modes.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language search query",
          },
          table: {
            type: "string",
            enum: [
              "thoughts",
              "decisions",
              "relationships",
              "projects",
              "sessions",
            ],
            description: "Optional: limit search to a specific table",
          },
          limit: {
            type: "number",
            description: "Maximum results to return (default 10)",
          },
          search_mode: {
            type: "string",
            enum: ["hybrid", "vector", "keyword"],
            description: "Search mode (default: hybrid)",
          },
          namespace: {
            type: "string",
            description:
              "Override namespace filter. Default: caller's own namespace + collab. Admins see all.",
          },
          tier: {
            type: "string",
            enum: ["hot", "warm", "cold"],
            description:
              "Optional: filter results to a specific cognitive tier",
          },
        },
        required: ["query"],
      },
    },
    search_all: {
      description:
        "Federated search across Open Brain knowledge AND qmd file index.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language search query",
          },
          limit: {
            type: "number",
            description: "Max results per source (default 10)",
          },
          sources: {
            type: "string",
            enum: ["all", "brain", "qmd"],
            description: "Which sources to search (default: all)",
          },
          search_mode: {
            type: "string",
            enum: ["hybrid", "vector", "keyword"],
            description: "Brain search mode (default: hybrid)",
          },
          namespace: {
            type: "string",
            description:
              "Override namespace filter. Default: caller's own namespace + collab. Admins see all.",
          },
          tier: {
            type: "string",
            enum: ["hot", "warm", "cold"],
            description:
              "Optional: filter brain results to a specific cognitive tier",
          },
        },
        required: ["query"],
      },
    },
  };

const toolHandlers: Record<string, ToolHandler> = {
  async search_brain(args, auth, deps) {
    const query = args.query as string;
    if (!query || query.length < 1) throw new Error("query is required");

    const tableFilter = args.table as Table | undefined;
    let accessibleTables: Table[];

    if (tableFilter) {
      if (!canRead(auth.role, tableFilter)) {
        throw new Error(`Permission denied: cannot read ${tableFilter}`);
      }
      accessibleTables = [tableFilter];
    } else {
      accessibleTables = ALL_TABLES.filter((t) => canRead(auth.role, t));
    }

    if (accessibleTables.length === 0) {
      throw new Error("Permission denied: no readable tables");
    }

    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    const mode = (args.search_mode as SearchMode) ?? "hybrid";
    const tier = args.tier as Tier | undefined;

    const rows = await executeSearch(
      deps,
      accessibleTables,
      query,
      limit,
      mode,
      tier,
    );
    trackUsage(deps, rows, query);
    return rows;
  },

  async search_all(args, auth, deps) {
    const query = args.query as string;
    if (!query || query.length < 1) throw new Error("query is required");

    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    const sources = (args.sources as "all" | "brain" | "qmd") ?? "all";
    const mode = (args.search_mode as SearchMode) ?? "hybrid";
    const searchBrain = sources === "all" || sources === "brain";
    const searchQmd = sources === "all" || sources === "qmd";

    const accessibleTables = ALL_TABLES.filter((t) => canRead(auth.role, t));
    const tier = args.tier as Tier | undefined;

    const [brainResults, qmdResults] = await Promise.all([
      searchBrain && accessibleTables.length > 0
        ? executeSearch(deps, accessibleTables, query, limit, mode, tier).catch(
            (err) => {
              logger.warn("brain search failed in direct handler", {
                error: err instanceof Error ? err.message : String(err),
              });
              return [];
            },
          )
        : Promise.resolve([]),
      searchQmd ? searchQmdCli(query, limit) : Promise.resolve([]),
    ]);

    // RRF merge
    const RRF_K = 60;
    const withRrf: Array<any & { rrf: number }> = [];
    for (let i = 0; i < brainResults.length; i++) {
      withRrf.push({
        source: "brain",
        type: brainResults[i]!.source_type,
        content: brainResults[i]!.content_preview.slice(0, 300),
        score:
          brainResults[i]!.distance != null
            ? 1 - brainResults[i]!.distance!
            : (brainResults[i]!.fts_rank ?? 0.5),
        id: brainResults[i]!.id,
        tags: brainResults[i]!.tags ?? undefined,
        rrf: 1 / (RRF_K + i + 1),
      });
    }
    for (let i = 0; i < qmdResults.length; i++) {
      withRrf.push({ ...qmdResults[i]!, rrf: 1 / (RRF_K + i + 1) });
    }
    const merged = withRrf
      .sort((a, b) => b.rrf - a.rrf)
      .slice(0, limit)
      .map(({ rrf, ...rest }) => ({ ...rest, score: rrf }));

    if (brainResults.length > 0) {
      trackUsage(deps, brainResults, query);
    }

    return {
      total: merged.length,
      brain_hits: brainResults.length,
      qmd_hits: qmdResults.length,
      results: merged,
    };
  },
};

/** qmd CLI search -- same as search-all.ts */
async function searchQmdCli(query: string, limit: number): Promise<any[]> {
  try {
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
    if (exitCode !== 0) return [];
    const docs = JSON.parse(stdout);
    if (!Array.isArray(docs)) return [];
    return docs.map((doc: any) => ({
      source: "qmd",
      type: "file",
      content: (doc.content || doc.text || doc.preview || "").slice(0, 300),
      score: doc.score ?? doc.similarity ?? 0.5,
      path: doc.path || doc.file,
      collection: doc.collection,
    }));
  } catch {
    return [];
  }
}

export function createDirectHandler(
  deps: ToolDeps,
): (
  body: JsonRpcRequest,
  auth: AuthInfo | undefined,
) => Promise<JsonRpcResponse> {
  return async (body, auth) => {
    const id = body.id ?? null;

    if (!auth) {
      return {
        jsonrpc: "2.0",
        error: { code: -32600, message: "Not authenticated" },
        id,
      };
    }

    // Handle tools/list
    if (body.method === "tools/list") {
      const tools = Object.entries(TOOL_SCHEMAS).map(([name, schema]) => ({
        name,
        ...schema,
      }));
      return { jsonrpc: "2.0", result: { tools }, id };
    }

    // Handle tools/call
    if (body.method === "tools/call") {
      const toolName = body.params?.name as string;
      const toolArgs = body.params?.arguments ?? {};

      const handler = toolHandlers[toolName];
      if (!handler) {
        return {
          jsonrpc: "2.0",
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
          id,
        };
      }

      try {
        const result = await handler(toolArgs, auth, deps);
        return {
          jsonrpc: "2.0",
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
          },
          id,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: "2.0",
          result: {
            content: [{ type: "text", text: message }],
            isError: true,
          },
          id,
        };
      }
    }

    // Handle notifications (fire and forget)
    if (body.method?.startsWith("notifications/")) {
      return { jsonrpc: "2.0", result: {}, id };
    }

    return {
      jsonrpc: "2.0",
      error: { code: -32601, message: `Method not found: ${body.method}` },
      id,
    };
  };
}
