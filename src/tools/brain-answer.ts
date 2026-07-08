import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import { canReadNamespace, namespaceFilterFor } from "../read-policy.ts";
import type { AuthInfo, Tier } from "../types.ts";
import type { ToolDeps } from "./index.ts";
import {
  ALL_TABLES,
  executeSearch,
  executeSearchWithScopedSharedFallback,
  executeSearchWithSharedFallback,
  type SearchMode,
  type SearchRow,
  type SourceScope,
  type SourceRef,
} from "./search-brain.ts";
import { isSharedNamespace } from "../shared-namespace.ts";
import {
  sourceScopeAuthorizationError,
  sourceScopeSchema,
} from "../source-refs.ts";

type NamespaceFilter = string | string[];

interface Citation {
  index: number;
  source_ref: SourceRef;
  excerpt: string;
  score: number;
  stale: boolean;
}

interface Evidence {
  row: SearchRow;
  excerpt: string;
  source_ref: SourceRef;
}

function scoreFor(row: SearchRow): number {
  return row.distance != null ? 1 - row.distance : (row.fts_rank ?? 0.5);
}

function excerptFor(row: SearchRow): string | null {
  const excerpt = (row.content_preview ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return excerpt.length > 0 ? excerpt : null;
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

function normalizeUseTarget(target: string): string {
  return target
    .toLowerCase()
    .replace(/[`~"'()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function useTargets(
  text: string,
  pattern: RegExp,
): Set<string> {
  const targets = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const target = normalizeUseTarget(match[1] ?? "");
    if (target) targets.add(target);
  }
  return targets;
}

function hasConflictingUseTargets(evidence: Evidence[]): boolean {
  const negativeTargets = new Set<string>();
  const affirmativeTargets = new Set<string>();

  for (const item of evidence) {
    const lower = item.excerpt.toLowerCase();
    for (const target of useTargets(
      lower,
      /\b(?:should not|must not|do not|don't|never)\s+use\s+([^.;,]+)/g,
    )) {
      negativeTargets.add(target);
    }
    for (const target of useTargets(
      lower,
      /\b(?<!not\s)(?:should\s+use|must\s+use|use)\s+([^.;,]+)/g,
    )) {
      affirmativeTargets.add(target);
    }
  }

  for (const target of negativeTargets) {
    if (affirmativeTargets.has(target)) return true;
  }
  return false;
}

function gapMessage(query: string): string {
  return `No readable Open Brain evidence was found for: ${query}`;
}

export function registerBrainAnswer(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "brain_answer",
    {
      description:
        "Render cited evidence from readable Open Brain rows only. Returns extractive bullets plus known gaps and uncertainty.",
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
        source_scope: sourceScopeSchema
          .optional()
          .describe(
            "Optional: require matching source_refs client_id, matter_id, document_id, path, or dms_id before citing brain evidence",
          ),
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
      const sourceScope = args.source_scope as SourceScope | undefined;
      const sourceScopeError = sourceScopeAuthorizationError(auth, sourceScope);
      if (sourceScopeError) {
        return {
          content: [{ type: "text" as const, text: sourceScopeError }],
          isError: true,
        };
      }
      const maxAgeDays = args.max_age_days ?? 180;
      const namespace = namespaceFilterFor(
        auth,
        requestedNamespace,
      ) as NamespaceFilter;

      let rows: SearchRow[];
      try {
        // #268: inherit search_brain's graph-expanded retrieval arm. Graph
        // candidates hydrate into normal SearchRows with standard source_refs,
        // so extractive/cited answer behavior is unchanged; namespace and
        // archived predicates are enforced inside the shared arm (#267).
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
                { enableGraph: true },
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
                { enableGraph: true },
              );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }

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

      const evidence: Evidence[] = [];
      const knownGaps: string[] = [];
      const uncertainty: string[] = [];

      for (const row of rows) {
        const excerpt = excerptFor(row);
        if (!row.source_ref || !excerpt) {
          knownGaps.push(
            `Skipped ${row.source_type}:${row.id} because it lacked citation metadata or usable preview text.`,
          );
          continue;
        }
        evidence.push({ row, excerpt, source_ref: row.source_ref });
      }

      if (evidence.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                query,
                answer: null,
                evidence_count: 0,
                citations: [],
                known_gaps: [
                  ...knownGaps,
                  "No retrieved evidence had both citation metadata and usable preview text.",
                ],
                uncertainty: [
                  "Readable rows were retrieved, but none were safe to cite.",
                ],
                raw_results: args.include_raw ? rows : undefined,
              }),
            },
          ],
        };
      }

      const citations: Citation[] = evidence.map((item, index) => ({
        index: index + 1,
        source_ref: item.source_ref,
        excerpt: item.excerpt,
        score: scoreFor(item.row),
        stale: isStale(item.row, maxAgeDays),
      }));
      const staleCount = citations.filter((citation) => citation.stale).length;
      const hasMixedUseTargets = hasConflictingUseTargets(evidence);

      if (staleCount > 0) {
        uncertainty.push(
          `${staleCount} cited entr${staleCount === 1 ? "y is" : "ies are"} older than ${maxAgeDays} days or missing a usable timestamp.`,
        );
      }
      if (hasMixedUseTargets) {
        uncertainty.push(
          "Retrieved evidence contains both affirmative and negative wording; verify whether these are truly contradictory before treating this as settled.",
        );
      }
      if (evidence.length < rows.length) {
        uncertainty.push(
          "Some retrieved rows were omitted because they were not safe to cite.",
        );
      }
      if (evidence.length < limit) {
        knownGaps.push(
          `Only ${evidence.length} citable evidence entr${evidence.length === 1 ? "y was" : "ies were"} found for this query.`,
        );
      }

      const answer = [
        "Cited Open Brain evidence:",
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
                evidence_count: evidence.length,
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
