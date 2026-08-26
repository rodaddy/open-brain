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
 * confident-looking answer with its caveats silently removed. The shaping of all
 * of that lives in `answer-evidence.ts`; this file owns the request path.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import {
  canReadNamespace,
  namespaceFilterFor,
  type NamespaceFilter,
} from "./read-scope.ts";
import { isSharedNamespace } from "./shared-namespace.ts";
import type { Tier } from "./search-constants.ts";
import { setActiveMcpTraceMetadata } from "../observability/langfuse-tracing.ts";
import {
  readableSearchSources,
  type SearchMode,
  type SearchRow,
  type SearchSource,
} from "./search-engine.ts";
import { respondToSearchFailure } from "./tool-failure.ts";
import {
  buildCitations,
  gapMessage,
  renderAnswer,
  uncertaintyFor,
  type Evidence,
} from "./answer-evidence.ts";
import {
  retrieveAnswerRows,
  selectCitableEvidence,
} from "./answer-retrieval.ts";

const NAMESPACE_DENIED = "Permission denied: namespace read access denied";
const NOT_AUTHENTICATED = "Permission denied: not authenticated";
const NO_READABLE_TABLES = "Permission denied: no readable tables";

/** Default staleness window; evidence older than this is flagged, not dropped. */
const DEFAULT_MAX_AGE_DAYS = 180;
const DEFAULT_EVIDENCE_LIMIT = 5;

/** The request as this tool resolves it, after auth and namespace scoping. */
interface AnswerRequest {
  query: string;
  limit: number;
  mode: SearchMode;
  tier: Tier | undefined;
  maxAgeDays: number;
  namespace: NamespaceFilter | undefined;
  requestedNamespace: string | undefined;
  tables: readonly SearchSource[];
  includeRaw: boolean;
}

/** The `brain_answer` input schema; frozen shape, defaults documented inline. */
const BRAIN_ANSWER_INPUT_SCHEMA = {
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
};

type BrainAnswerArgs = {
  query: string;
  namespace?: string | undefined;
  limit?: number | undefined;
  search_mode?: string | undefined;
  tier?: string | undefined;
  max_age_days?: number | undefined;
  include_raw?: boolean | undefined;
};

/** The no-evidence response, used when retrieval returned nothing at all. */
function noEvidenceResult(query: string): ReturnType<typeof textResult> {
  return textResult({
    query,
    answer: null,
    evidence_count: 0,
    citations: [],
    known_gaps: [gapMessage(query)],
    uncertainty: ["No readable evidence was available to cite."],
  });
}

/** The response for rows that were retrieved but none of which were citable. */
function noCitableEvidenceResult(options: {
  query: string;
  knownGaps: readonly string[];
  rows: SearchRow[];
  includeRaw: boolean;
}): ReturnType<typeof textResult> {
  const { query, knownGaps, rows, includeRaw } = options;
  return textResult({
    query,
    answer: null,
    evidence_count: 0,
    citations: [],
    known_gaps: [
      ...knownGaps,
      "No retrieved evidence had both citation metadata and usable preview text.",
    ],
    uncertainty: ["Readable rows were retrieved, but none were safe to cite."],
    raw_results: includeRaw ? rows : undefined,
  });
}

/** The cited answer, once at least one row survived selection. */
function citedAnswerResult(options: {
  request: AnswerRequest;
  evidence: readonly Evidence[];
  knownGaps: string[];
  rows: SearchRow[];
}): ReturnType<typeof textResult> {
  const { request, evidence, knownGaps, rows } = options;
  const citations = buildCitations(evidence, request.maxAgeDays);
  const uncertainty = uncertaintyFor({
    citations,
    evidence,
    retrievedCount: rows.length,
    maxAgeDays: request.maxAgeDays,
  });
  if (evidence.length < request.limit) {
    knownGaps.push(
      `Only ${evidence.length} citable evidence entr${evidence.length === 1 ? "y was" : "ies were"} found for this query.`,
    );
  }
  return textResult({
    query: request.query,
    answer: renderAnswer(citations),
    evidence_count: evidence.length,
    citations,
    known_gaps: knownGaps,
    uncertainty,
    raw_results: request.includeRaw ? rows : undefined,
  });
}

/**
 * Resolve the raw arguments into a scoped request, or the denial that stops it.
 *
 * #433 defect 1: brain_answer could not see `ob_session_events` at all. It
 * filtered ALL_TABLES — the PHYSICAL-table list, which drives PERMISSIONS and
 * the write paths — so the session-event corpus was structurally absent from
 * every question this tool answered. "What happened in the last day" answered
 * from months-old thoughts while the day's events sat unread. The selection now
 * lives in ONE exported function so a new recall source cannot reach one caller
 * and miss another, which is the shape of this defect.
 */
function resolveRequest(
  args: BrainAnswerArgs,
  identity: ReturnType<typeof authIdentity>,
): { request: AnswerRequest } | { denial: string } {
  if (!identity) return { denial: NOT_AUTHENTICATED };

  const requestedNamespace = args.namespace;
  if (requestedNamespace && !canReadNamespace(identity, requestedNamespace)) {
    return { denial: NAMESPACE_DENIED };
  }

  const tables = readableSearchSources(identity.role);
  if (tables.length === 0) return { denial: NO_READABLE_TABLES };

  return {
    request: {
      query: args.query,
      limit: args.limit ?? DEFAULT_EVIDENCE_LIMIT,
      mode: (args.search_mode as SearchMode | undefined) ?? "hybrid",
      tier: args.tier as Tier | undefined,
      maxAgeDays: args.max_age_days ?? DEFAULT_MAX_AGE_DAYS,
      namespace: namespaceFilterFor(identity, requestedNamespace),
      requestedNamespace,
      tables,
      includeRaw: args.include_raw === true,
    },
  };
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
      inputSchema: BRAIN_ANSWER_INPUT_SCHEMA,
      annotations: {
        title: "Brain Answer",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const resolved = resolveRequest(
        args as BrainAnswerArgs,
        authIdentity(extra.authInfo),
      );
      if ("denial" in resolved) return errorResult(resolved.denial);
      const { request } = resolved;

      setActiveMcpTraceMetadata({
        resolved_namespace: request.namespace ?? null,
      });

      let rows: SearchRow[];
      try {
        rows = await retrieveAnswerRows(dependencies, request, {
          shared:
            request.requestedNamespace !== undefined &&
            isSharedNamespace(request.requestedNamespace),
        });
      } catch (error) {
        // Retrieval failed. An empty citation list here would read as "the brain
        // knows nothing about this", which is a different and much worse claim.
        return respondToSearchFailure({
          logger: dependencies.logger,
          event: "brain_answer_retrieval_failed",
          error,
          namespace: request.namespace,
          mode: request.mode,
          tier: request.tier,
        });
      }

      if (rows.length === 0) return noEvidenceResult(request.query);

      const { evidence, knownGaps } = selectCitableEvidence(rows);
      if (evidence.length === 0) {
        return noCitableEvidenceResult({
          query: request.query,
          knownGaps,
          rows,
          includeRaw: request.includeRaw,
        });
      }

      return citedAnswerResult({ request, evidence, knownGaps, rows });
    },
  );
}
