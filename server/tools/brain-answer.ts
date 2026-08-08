/**
 * `brain_answer` — cited, extractive answers over readable brain records.
 *
 * Design authority: `docs/decisions/privilege-isolation-closed-brain.md`
 * (namespace isolation is server-side) and #327 (one shared recall stack).
 *
 * This tool NEVER GENERATES PROSE. The `answer` field is the retrieved excerpts
 * themselves, bulleted and numbered against the citation list — nothing is
 * paraphrased, summarized, or inferred. That constraint is the entire point: an
 * answer a caller cannot trace back to a stored record is worse than no answer,
 * because it is indistinguishable from one that can be. Every emitted bullet
 * carries a `[n]` that indexes a citation, and every citation carries the
 * `source_ref` needed to fetch the record it came from.
 *
 * `known_gaps` and `uncertainty` are first-class output, not decoration. They
 * are how the tool says what it does NOT know: evidence older than the staleness
 * window, rows retrieved but not safely citable, fewer citable records than
 * requested, and evidence that contradicts itself. Dropping them would leave a
 * confident-looking answer with its caveats silently removed.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../auth/permissions.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import { canReadNamespace, namespaceFilterFor } from "./read-scope.ts";
import { isSharedNamespace } from "./shared-namespace.ts";
import type { Tier } from "./search-constants.ts";
import {
  setActiveMcpTraceMetadata,
  traceRetrievalSpanSync,
} from "../observability/langfuse-tracing.ts";
import {
  executeSearchWithSharedFallback,
  readableSearchSources,
  type SearchMode,
  type SearchRow,
  type SourceRef,
} from "./search-engine.ts";

const NAMESPACE_DENIED = "Permission denied: namespace read access denied";
const NOT_AUTHENTICATED = "Permission denied: not authenticated";
const NO_READABLE_TABLES = "Permission denied: no readable tables";

/** Default staleness window; evidence older than this is flagged, not dropped. */
const DEFAULT_MAX_AGE_DAYS = 180;
const DEFAULT_EVIDENCE_LIMIT = 5;
/** Longest excerpt quoted per citation. */
const MAX_EXCERPT_CHARS = 500;

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

/**
 * Clamp a relevance score into a finite `[0,1]`.
 *
 * Neither raw input is bounded: `ts_rank_cd` is only *typically* below 1, and
 * cosine distance can exceed 1, which makes `1 - distance` negative. Clamping at
 * this consumer boundary keeps the emitted score a comparable relevance value
 * rather than an artifact of whichever arm produced it.
 */
function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Relevance score for one row, from whichever arm ranked it. */
function scoreFor(row: SearchRow): number {
  return clampScore(
    row.distance != null ? 1 - row.distance : (row.fts_rank ?? 0.5),
  );
}

/** Collapse whitespace and bound one row's quotable excerpt. */
function excerptFor(row: SearchRow): string | null {
  const excerpt = (row.content_preview ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EXCERPT_CHARS);
  return excerpt.length > 0 ? excerpt : null;
}

/**
 * Whether a row is older than the staleness window.
 *
 * A row with no usable timestamp counts as STALE. Age cannot be proven, and the
 * failure modes are asymmetric: flagging fresh evidence costs a caveat, while
 * silently presenting undateable evidence as current is the error this exists to
 * prevent.
 */
function isStale(row: SearchRow, maxAgeDays: number): boolean {
  const raw = row.source_ref?.last_updated_at ?? row.source_ref?.created_at;
  if (!raw) return true;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return true;
  return Date.now() - parsed.getTime() > maxAgeDays * 86_400_000;
}

/** Normalize a "use X" target so the two polarities compare on equal footing. */
function normalizeUseTarget(target: string): string {
  return target
    .toLowerCase()
    .replace(/[`~"'()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Collect every normalized target matched by a polarity pattern. */
function useTargets(text: string, pattern: RegExp): Set<string> {
  const targets = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const target = normalizeUseTarget(match[1] ?? "");
    if (target) targets.add(target);
  }
  return targets;
}

/**
 * Detect evidence that both endorses and forbids the same target.
 *
 * A deliberately shallow lexical check, and it is reported as UNCERTAINTY rather
 * than resolved: two records saying "use X" and "never use X" are usually a
 * superseded decision, and picking a winner by recency would silently discard a
 * still-current constraint. The tool surfaces the conflict and lets the caller
 * decide.
 */
function hasConflictingUseTargets(evidence: readonly Evidence[]): boolean {
  const negative = new Set<string>();
  const affirmative = new Set<string>();
  for (const item of evidence) {
    const lower = item.excerpt.toLowerCase();
    for (const target of useTargets(
      lower,
      /\b(?:should not|must not|do not|don't|never)\s+use\s+([^.;,]+)/g,
    )) {
      negative.add(target);
    }
    for (const target of useTargets(
      lower,
      /\b(?<!not\s)(?:should\s+use|must\s+use|use)\s+([^.;,]+)/g,
    )) {
      affirmative.add(target);
    }
  }
  for (const target of negative) {
    if (affirmative.has(target)) return true;
  }
  return false;
}

/** The exact no-evidence gap sentence; frozen by the parity contract. */
function gapMessage(query: string): string {
  return `No readable Open Brain evidence was found for: ${query}`;
}

export function registerBrainAnswerTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
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
      const identity = authIdentity(extra.authInfo);
      if (!identity) return errorResult(NOT_AUTHENTICATED);

      const requestedNamespace = args.namespace;
      if (
        requestedNamespace &&
        !canReadNamespace(identity, requestedNamespace)
      ) {
        return errorResult(NAMESPACE_DENIED);
      }

      // #433 defect 1: brain_answer could not see `ob_session_events` at all.
      // It filtered ALL_TABLES -- the PHYSICAL-table list, which drives
      // PERMISSIONS and the write paths -- so the session-event corpus was
      // structurally absent from every question this tool answered. "What
      // happened in the last day" answered from months-old thoughts while the
      // day's events sat unread. The selection now lives in ONE exported
      // function so a new recall source cannot reach one caller and miss
      // another, which is the shape of this defect.
      const tables = readableSearchSources(identity.role);
      if (tables.length === 0) return errorResult(NO_READABLE_TABLES);

      const query = args.query;
      const limit = args.limit ?? DEFAULT_EVIDENCE_LIMIT;
      const mode = (args.search_mode as SearchMode | undefined) ?? "hybrid";
      const tier = args.tier as Tier | undefined;
      const maxAgeDays = args.max_age_days ?? DEFAULT_MAX_AGE_DAYS;
      const namespace = namespaceFilterFor(identity, requestedNamespace);
      setActiveMcpTraceMetadata({ resolved_namespace: namespace ?? null });

      let rows: SearchRow[];
      try {
        rows = await executeSearchWithSharedFallback(
          dependencies,
          tables,
          query,
          limit,
          mode,
          tier,
          0,
          namespace,
          {},
          requestedNamespace !== undefined &&
            isSharedNamespace(requestedNamespace),
        );
      } catch (error) {
        // Retrieval failed. An empty citation list here would read as "the brain
        // knows nothing about this", which is a different and much worse claim.
        dependencies.logger.error(
          {
            namespace,
            mode,
            tier,
            error_message:
              error instanceof Error ? error.message : String(error),
          },
          "brain_answer_retrieval_failed",
        );
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }

      if (rows.length === 0) {
        return textResult({
          query,
          answer: null,
          evidence_count: 0,
          citations: [],
          known_gaps: [gapMessage(query)],
          uncertainty: ["No readable evidence was available to cite."],
        });
      }

      const filtered = traceRetrievalSpanSync({
        name: "retrieval.citation_filter",
        input: {
          candidate_count: rows.length,
          candidates: rows.map((row) => ({
            row_id: row.id,
            source_type: row.source_type,
            namespace: row.namespace ?? null,
            content_preview: row.content_preview,
            distance: row.distance ?? null,
            similarity: row.distance === undefined ? null : 1 - row.distance,
            bm25_score: row.fts_rank ?? null,
          })),
        },
        metadata: {
          stage: "filtering",
          filter_names: ["missing_source_ref", "empty_excerpt"],
        },
        run: () => {
          const evidence: Evidence[] = [];
          const knownGaps: string[] = [];
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
          return { evidence, knownGaps };
        },
        output: ({ evidence }) => {
          const selected = new Set(evidence.map((item) => item.row.id));
          return {
            selected_count: evidence.length,
            selected_row_ids: evidence.map((item) => item.row.id),
            candidates: rows.map((row) => {
              const chosen = selected.has(row.id);
              let filteredBy: string | null = null;
              if (!chosen) {
                filteredBy = row.source_ref
                  ? "empty_excerpt"
                  : "missing_source_ref";
              }
              return { row_id: row.id, chosen, filtered_by: filteredBy };
            }),
          };
        },
      });
      const { evidence, knownGaps } = filtered;
      const uncertainty: string[] = [];

      if (evidence.length === 0) {
        return textResult({
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
        });
      }

      const citations: Citation[] = evidence.map((item, index) => ({
        index: index + 1,
        source_ref: item.source_ref,
        excerpt: item.excerpt,
        score: scoreFor(item.row),
        stale: isStale(item.row, maxAgeDays),
      }));

      const staleCount = citations.filter((citation) => citation.stale).length;
      if (staleCount > 0) {
        uncertainty.push(
          `${staleCount} cited entr${staleCount === 1 ? "y is" : "ies are"} older than ${maxAgeDays} days or missing a usable timestamp.`,
        );
      }
      if (hasConflictingUseTargets(evidence)) {
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

      // Extractive by construction: every bullet is a stored excerpt followed by
      // the index of the citation it came from. No sentence here originates in
      // this tool.
      const answer = [
        "Cited Open Brain evidence:",
        "",
        ...citations.map(
          (citation) => `- ${citation.excerpt} [${citation.index}]`,
        ),
      ].join("\n");

      return textResult({
        query,
        answer,
        evidence_count: evidence.length,
        citations,
        known_gaps: knownGaps,
        uncertainty,
        raw_results: args.include_raw ? rows : undefined,
      });
    },
  );
}
