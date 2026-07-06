import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import { canReadNamespace, namespaceFilterFor } from "../read-policy.ts";
import type { AuthInfo, Tier } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import {
  ALL_TABLES,
  executeSearch,
  executeSearchWithScopedSharedFallback,
  executeSearchWithSharedFallback,
  trackUsage,
  TIER_BOOST,
  type SearchMode,
  type SearchRow,
  type SourceScope,
  type SourceRef,
} from "./search-brain.ts";
import { isSharedNamespace } from "../shared-namespace.ts";
import { sourceScopeSchema } from "../source-refs.ts";

type NamespaceFilter = string | string[];

interface UnifiedResult {
  source: "brain" | "qmd";
  type: string;
  content: string;
  score: number;
  source_ref: SourceRef | QmdSourceRef;
  id?: string;
  path?: string;
  tags?: string[];
  collection?: string;
  tier?: string;
  explicit_links?: SearchRow["explicit_links"];
}

interface QmdSourceRef {
  source: "qmd";
  type: "file";
  path?: string;
  collection?: string;
}

interface QmdDocument {
  id?: string;
  path?: string;
  file?: string;
  content?: string;
  text?: string;
  preview?: string;
  snippet?: string;
  score?: number;
  similarity?: number;
  collection?: string;
}

const QMD_PATH = process.env.QMD_PATH ?? "/opt/qmd/src/qmd.ts";

const QMD_TIMEOUT_MS = 10_000;

async function searchQmd(
  query: string,
  limit: number,
  collection?: string,
): Promise<UnifiedResult[]> {
  try {
    const qmdArgs = [
      "bun",
      QMD_PATH,
      "search",
      query,
      "--json",
      "-n",
      String(limit),
    ];
    if (collection) qmdArgs.push("-c", collection);

    const proc = Bun.spawn(
      qmdArgs,
      { stdout: "pipe", stderr: "pipe" },
    );

    const result = await Promise.race([
      (async () => {
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        return { stdout, exitCode, timedOut: false };
      })(),
      new Promise<{ stdout: string; exitCode: number; timedOut: boolean }>(
        (resolve) =>
          setTimeout(() => {
            proc.kill();
            resolve({ stdout: "", exitCode: -1, timedOut: true });
          }, QMD_TIMEOUT_MS),
      ),
    ]);

    if (result.timedOut) {
      logger.warn("qmd search timed out", { timeoutMs: QMD_TIMEOUT_MS });
      return [];
    }

    if (result.exitCode !== 0) {
      logger.warn("qmd search failed", { exitCode: result.exitCode });
      return [];
    }

    const docs: QmdDocument[] = JSON.parse(result.stdout);
    if (!Array.isArray(docs)) return [];

    return docs.map((doc) => ({
      source: "qmd" as const,
      type: "file",
      content: (
        doc.content ||
        doc.text ||
        doc.preview ||
        doc.snippet ||
        ""
      ).slice(0, 300),
      score: doc.score ?? doc.similarity ?? 0.5,
      path: doc.path || doc.file,
      collection: doc.collection,
      source_ref: {
        source: "qmd" as const,
        type: "file" as const,
        path: doc.path || doc.file,
        collection: doc.collection,
      },
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
        namespace: z
          .string()
          .optional()
          .describe(
            "Optional: filter brain results to a specific namespace (e.g. clientId or 'shared-kb')",
          ),
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
        collection: z
          .string()
          .min(1)
          .optional()
          .describe("Optional: restrict qmd search to one collection"),
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
        source_scope: sourceScopeSchema
          .optional()
          .describe(
            "Optional: require matching source_refs client_id, matter_id, document_id, path, or dms_id before returning brain results. QMD results are suppressed while this is set.",
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
      const sourceScope = args.source_scope as SourceScope | undefined;
      const collection = args.collection as string | undefined;
      const requestedNamespace = args.namespace as string | undefined;
      if (sourceScope && sources === "qmd") {
        return {
          content: [
            {
              type: "text" as const,
              text: "source_scope applies only to Open Brain source_refs; use sources='brain' or omit source_scope for qmd.",
            },
          ],
          isError: true,
        };
      }
      if (requestedNamespace && !canReadNamespace(auth, requestedNamespace)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: namespace read access denied",
            },
          ],
          isError: true,
        };
      }
      const namespace = namespaceFilterFor(auth, requestedNamespace);
      const searchBrain = sources === "all" || sources === "brain";
      const searchQmdSource =
        !sourceScope && (sources === "all" || sources === "qmd");

      // Over-fetch to cover offset + limit, then slice after merge
      const totalNeeded = offset + limit;

      // Launch both searches in parallel
      const [brainResults, qmdResults] = await Promise.all([
        searchBrain
          ? searchOB(
              deps,
              auth,
              args.query,
              totalNeeded,
              mode,
              tier,
              namespace,
              sourceScope,
            )
          : Promise.resolve([]),
        searchQmdSource
          ? searchQmd(args.query, totalNeeded, collection)
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
        withRrf.push({
          ...result,
          rrf: Math.max(0, 1 / (RRF_K + i + 1) + boost),
        });
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
  namespace?: NamespaceFilter,
  sourceScope?: SourceScope,
): Promise<UnifiedResult[]> {
  const accessibleTables = ALL_TABLES.filter((t) => canRead(auth.role, t));
  if (accessibleTables.length === 0) return [];

  let rows: SearchRow[];
  try {
    rows =
      typeof namespace === "string" && isSharedNamespace(namespace)
        ? await executeSearchWithSharedFallback(
            deps,
            accessibleTables,
            query,
            limit,
            mode,
            tier,
            0,
            namespace,
            false,
            sourceScope,
          )
        : await executeSearchWithScopedSharedFallback(
            deps,
            accessibleTables,
            query,
            limit,
            mode,
            tier,
            0,
            namespace,
            false,
            sourceScope,
          );
  } catch (err) {
    logger.warn("searchOB_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  trackUsage(deps, rows, query, "search", auth.clientId);

  return rows.map((row) => {
    const preview = row.content_preview ?? "";
    return {
      source: "brain" as const,
      type: row.source_type,
      content: preview.slice(0, 300),
      score: row.distance != null ? 1 - row.distance : (row.fts_rank ?? 0.5),
      source_ref: row.source_ref ?? {
        source: "brain" as const,
        type: row.source_type,
        id: row.id,
        label: preview.slice(0, 120),
        preview: preview.slice(0, 300),
      },
      id: row.id,
      tags: row.tags ?? undefined,
      tier: row.tier,
      explicit_links: row.explicit_links,
    };
  });
}
