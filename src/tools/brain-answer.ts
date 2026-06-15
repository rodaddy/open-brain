import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import { canReadNamespace, namespaceFilterFor } from "../read-policy.ts";
import type { AuthInfo, Tier } from "../types.ts";
import type { ToolDeps } from "./index.ts";
import {
  ALL_TABLES,
  executeSearch,
  trackUsage,
  type SearchMode,
  type SearchRow,
  type SourceRef,
} from "./search-brain.ts";

type NamespaceFilter = string | string[];

interface Citation {
  index: number;
  source_ref: SourceRef;
  excerpt: string;
  score: number;
  stale: boolean;
}

function scoreFor(row: SearchRow): number {
  return row.distance != null ? 1 - row.distance : (row.fts_rank ?? 0.5);
}

function sentenceFor(row: SearchRow): string {
  return row.content_preview.replace(/\s+/g, " ").trim().slice(0, 500);
}

function rowTimestamp(row: SearchRow): Date | null {
  const raw = row.source_ref?.last_updated_at ?? row.source_ref?.created_at;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isStale(row: SearchRow, maxAgeDays: number): boolean {
  const timestamp = rowTimestamp(row);
  if (!timestamp) return true;
  const ageMs = Date.now() - timestamp.getTime();
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

function polarity(text: string): "positive" | "negative" | "unknown" {
  const lower = text.toLowerCase();
  if (/\b(no|not|never|disable|disabled|forbid|avoid|reject)\b/.test(lower)) {
    return "negative";
  }
  if (/\b(yes|should|must|use|enable|enabled|allow|prefer|approved)\b/.test(lower)) {
    return "positive";
  }
  return "unknown";
}

function hasContradiction(rows: SearchRow[]): boolean {
  const polarities = new Set(rows.map((row) => polarity(row.content_preview)));
  return polarities.has("positive") && polarities.has("negative");
}

function gapMessage(query: string): string {
  return `No readable Open Brain evidence was found for: ${query}`;
}

export function registerBrainAnswer(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "brain_answer",
    {
      description:
        "Answer from readable Open Brain evidence only. Returns cited extractive prose plus known gaps and uncertainty.",
      inputSchema: {
        query: z.string().min(1).describe("Question to answer from memory"),
        namespace: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .optional()
          .describe("Optional namespace filter; must be readable by caller"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Maximum evidence entries to cite (default 5)"),
        search_mode: z
          .enum(["hybrid", "vector", "keyword"])
          .optional()
          .describe("Retrieval mode (default hybrid)"),
        tier: z
          .enum(["hot", "warm", "cold"])
          .optional()
          .describe("Optional cognitive tier filter"),
        max_age_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe("Evidence older than this is flagged stale (default 180)"),
        include_raw: z
          .boolean()
          .optional()
          .describe("Include raw retrieved rows for debugging (default false)"),
      },
      annotations: {
        title: "Brain Answer",
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

      const requestedNamespace = args.namespace as string | undefined;
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

      const accessibleTables = ALL_TABLES.filter((table) =>
        canRead(auth.role, table),
      );
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

      const query = args.query;
      const limit = args.limit ?? 5;
      const mode = (args.search_mode as SearchMode) ?? "hybrid";
      const tier = args.tier as Tier | undefined;
      const maxAgeDays = args.max_age_days ?? 180;
      const namespace = namespaceFilterFor(
        auth,
        requestedNamespace,
      ) as NamespaceFilter;

      let rows: SearchRow[];
      try {
        rows = await executeSearch(
          deps,
          accessibleTables,
          query,
          limit,
          mode,
          tier,
          0,
          namespace,
          false,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }

      trackUsage(deps, rows, query, "search", auth.clientId);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                query,
                answer: null,
                evidence_count: 0,
                citations: [],
                known_gaps: [gapMessage(query)],
                uncertainty: ["No readable evidence was available to cite."],
              }),
            },
          ],
        };
      }

      const citations: Citation[] = rows.map((row, index) => ({
        index: index + 1,
        source_ref: row.source_ref!,
        excerpt: sentenceFor(row),
        score: scoreFor(row),
        stale: isStale(row, maxAgeDays),
      }));
      const staleCount = citations.filter((citation) => citation.stale).length;
      const contradictory = hasContradiction(rows);
      const knownGaps: string[] = [];
      const uncertainty: string[] = [];

      if (staleCount > 0) {
        uncertainty.push(
          `${staleCount} cited entr${staleCount === 1 ? "y is" : "ies are"} older than ${maxAgeDays} days or missing a usable timestamp.`,
        );
      }
      if (contradictory) {
        uncertainty.push(
          "Retrieved evidence contains both affirmative and negative signals; verify before treating this as settled.",
        );
      }
      if (rows.length < limit) {
        knownGaps.push(
          `Only ${rows.length} readable evidence entr${rows.length === 1 ? "y was" : "ies were"} found for this query.`,
        );
      }
      if (knownGaps.length === 0 && uncertainty.length === 0) {
        knownGaps.push("No obvious gaps were detected in the cited evidence.");
      }

      const answer = [
        "Based only on retrieved Open Brain evidence:",
        "",
        ...citations.map(
          (citation) => `- ${citation.excerpt} [${citation.index}]`,
        ),
      ].join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              query,
              answer,
              evidence_count: rows.length,
              citations,
              known_gaps: knownGaps,
              uncertainty,
              raw_results: args.include_raw ? rows : undefined,
            }),
          },
        ],
      };
    },
  );
}
