/**
 * `search_all` — federated search across Open Brain records and the qmd file index.
 *
 * Design authority: `docs/qmd-ob-layered-recall.md` (the peer-federation model
 * and its fail-open rule), #327 (one shared retrieval stack on the brain side),
 * and `docs/decisions/privilege-isolation-closed-brain.md` (namespace isolation
 * is server-side).
 *
 * WHAT THIS IS, per that design: PEER federation. Both sources are searched
 * independently and their results are rank-merged. It is explicitly NOT the
 * layered recall the same document specifies for scope-derived repo questions —
 * that entry point resolves a repo first and then reaches one `.qmd`, and it is
 * a separate surface. Peer federation keeps its place for genuinely cross-repo
 * questions; the caller names the collection here rather than having one derived.
 *
 * QMD FEDERATION FAILS OPEN, THE BRAIN SIDE DOES NOT. If qmd is missing, slow,
 * or returns malformed JSON, its results are dropped and the brain results are
 * still returned. That asymmetry is the design's stated choice: qmd indexes
 * files that can be re-indexed at any time, so degrading to brain-only loses
 * less than failing the call, while the brain is the authoritative memory.
 *
 * Fusion is by RANK, never by raw score: qmd's similarity numbers and the
 * brain's RRF values are incomparable scales, and blending them directly would
 * let whichever source emits larger numbers win regardless of relevance.
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
import {
  ALL_TABLES,
  RRF_K,
  TIER_BOOST,
  type Tier,
} from "./search-constants.ts";
import {
  setActiveMcpTraceMetadata,
  traceRetrievalSpan,
  traceRetrievalSpanSync,
} from "../observability/langfuse-tracing.ts";
import {
  executeSearchWithSharedFallback,
  type SearchMode,
  type SearchRow,
  type SourceRef,
} from "./search-engine.ts";

const NOT_AUTHENTICATED = "Permission denied: not authenticated";
const NAMESPACE_DENIED = "Permission denied: namespace read access denied";

/** Longest a qmd subprocess may run before its results are abandoned. */
const QMD_TIMEOUT_MS = 10_000;
/** Longest content excerpt carried per federated result. */
const MAX_CONTENT_CHARS = 300;

interface QmdSourceRef {
  source: "qmd";
  type: "file";
  path?: string;
  collection?: string;
}

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
}

function federatedFilteredBy(
  chosen: boolean,
  rankIndex: number,
  offset: number,
): "pagination_offset" | "federated_rank_window" | null {
  if (chosen) return null;
  if (rankIndex < offset) return "pagination_offset";
  return "federated_rank_window";
}

/** One qmd hit; every field is optional because the shape varies by version. */
interface QmdDocument {
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

/**
 * Resolve the qmd entry point, treating a blank value as unconfigured.
 *
 * `docs/qmd-ob-layered-recall.md` records the exact defect this avoids: the
 * dogfood environment sets `QMD_PATH=` (empty, not absent), and a `?? default`
 * resolution treats empty-string as a configured value, so the caller spawned
 * `bun "" search …` and the qmd arm silently produced nothing forever. Trimming
 * to `undefined` means an unusable value disables federation loudly at the call
 * site instead of failing inside a subprocess that fails open.
 *
 * @returns The configured path, or `undefined` when none is usable.
 */
export function resolveQmdPath(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const configured = env.QMD_PATH?.trim();
  return configured ? configured : undefined;
}

/**
 * Search the qmd file index, returning `[]` on every failure.
 *
 * Fails open by design (see the module header). A timeout, a non-zero exit, or
 * unparseable output all degrade to no qmd results rather than failing the whole
 * federated search. Each is logged, so the degradation is visible rather than
 * merely quiet — the design's R4 objection is to SILENT staleness, not to
 * degradation itself.
 *
 * @param qmdPath Resolved qmd entry point; never empty (see resolveQmdPath).
 */
async function searchQmdInternal(
  dependencies: MemoryToolDependencies,
  qmdPath: string,
  query: string,
  limit: number,
  collection: string | undefined,
): Promise<UnifiedResult[]> {
  try {
    const command = [
      "bun",
      qmdPath,
      "search",
      query,
      "--json",
      "-n",
      String(limit),
    ];
    if (collection) command.push("-c", collection);

    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    // The timer handle is held outside the race so the winner can cancel the
    // loser. Without the clearTimeout below, a subprocess that finishes first
    // leaves the timer armed and it fires later, against an already-settled
    // race -- after the test that started it has ended. That is how #608/#632
    // surfaced: `Unhandled error between tests` with `0 fail`, exit 1.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      (async () => {
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        return { stdout, exitCode, timedOut: false };
      })(),
      new Promise<{ stdout: string; exitCode: number; timedOut: boolean }>(
        (resolve) => {
          timeoutHandle = setTimeout(() => {
            // Kill before resolving: an abandoned subprocess would hold its file
            // handles and its share of the box for the life of the server.
            // `kill` is guarded rather than called outright: a test double
            // for `Bun.spawn` returns a plain object carrying only the fields
            // the happy path reads (stdout/stderr/exited), so `.kill()` on it
            // throws `TypeError: proc.kill is not a function` -- the exact
            // error in #632. Guarding keeps the timeout path honest under a
            // partial spawn handle.
            if (typeof proc.kill === "function") proc.kill();
            resolve({ stdout: "", exitCode: -1, timedOut: true });
          }, QMD_TIMEOUT_MS);
        },
      ),
    ]);
    clearTimeout(timeoutHandle);

    if (outcome.timedOut) {
      dependencies.logger.warn(
        { timeout_ms: QMD_TIMEOUT_MS },
        "qmd_search_timeout",
      );
      return [];
    }
    if (outcome.exitCode !== 0) {
      dependencies.logger.warn(
        { exit_code: outcome.exitCode },
        "qmd_search_failed",
      );
      return [];
    }

    const docs = JSON.parse(outcome.stdout) as QmdDocument[];
    if (!Array.isArray(docs)) return [];

    return docs.map((doc) => {
      const path = doc.path ?? doc.file;
      return {
        source: "qmd" as const,
        type: "file",
        content: (
          doc.content ??
          doc.text ??
          doc.preview ??
          doc.snippet ??
          ""
        ).slice(0, MAX_CONTENT_CHARS),
        score: doc.score ?? doc.similarity ?? 0.5,
        path,
        collection: doc.collection,
        source_ref: {
          source: "qmd" as const,
          type: "file" as const,
          path,
          collection: doc.collection,
        },
      };
    });
  } catch (error) {
    dependencies.logger.warn(
      { error_message: error instanceof Error ? error.message : String(error) },
      "qmd_search_error",
    );
    return [];
  }
}

function searchQmd(
  dependencies: MemoryToolDependencies,
  qmdPath: string,
  query: string,
  limit: number,
  collection: string | undefined,
): Promise<UnifiedResult[]> {
  return traceRetrievalSpan({
    name: "retrieval.qmd_query",
    input: { query, limit, collection },
    metadata: { stage: "candidate_generation", source: "qmd" },
    run: () =>
      searchQmdInternal(dependencies, qmdPath, query, limit, collection),
    output: (rows) => ({
      count: rows.length,
      candidates: rows.map((row) => ({
        path: row.path ?? null,
        collection: row.collection ?? null,
        content: row.content,
        score: row.score,
      })),
    }),
  });
}

/** Project a brain search row into the federated result shape. */
function toUnifiedResult(row: SearchRow): UnifiedResult {
  const preview = row.content_preview ?? "";
  return {
    source: "brain" as const,
    type: row.source_type,
    content: preview.slice(0, MAX_CONTENT_CHARS),
    // Pre-fusion score only. The handler overwrites `score` with the fused rank
    // value before emitting, so a raw distance or rank never reaches the caller.
    score: row.distance != null ? 1 - row.distance : (row.fts_rank ?? 0.5),
    source_ref: row.source_ref ?? {
      source: "brain" as const,
      type: row.source_type,
      id: row.id,
      label: preview.slice(0, 120),
      preview: preview.slice(0, MAX_CONTENT_CHARS),
    },
    id: row.id,
    tags: row.tags ?? undefined,
    tier: row.tier,
  };
}

export function registerSearchAllTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
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
      },
      annotations: {
        title: "Search All",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return errorResult(NOT_AUTHENTICATED);

      const limit = args.limit ?? 10;
      const offset = args.offset ?? 0;
      const sources = args.sources ?? "all";
      const mode = (args.search_mode as SearchMode | undefined) ?? "hybrid";
      const tier = args.tier as Tier | undefined;
      const requestedNamespace = args.namespace;

      if (
        requestedNamespace &&
        !canReadNamespace(identity, requestedNamespace)
      ) {
        return errorResult(NAMESPACE_DENIED);
      }

      const namespace = namespaceFilterFor(identity, requestedNamespace);
      setActiveMcpTraceMetadata({ resolved_namespace: namespace ?? null });
      const wantBrain = sources === "all" || sources === "brain";
      const qmdPath = dependencies.qmdPath ?? resolveQmdPath();
      const wantQmd =
        (sources === "all" || sources === "qmd") && qmdPath !== undefined;
      if ((sources === "all" || sources === "qmd") && qmdPath === undefined) {
        // Say it once, at the boundary. Without this the qmd arm's absence is
        // indistinguishable from a search that found no files.
        dependencies.logger.warn({}, "qmd_search_unconfigured");
      }
      // Over-fetch to cover the requested window, then slice after the merge.
      const totalNeeded = offset + limit;

      const brainSearch = async (): Promise<UnifiedResult[]> => {
        const tables = ALL_TABLES.filter((table) =>
          canRead(identity.role, table),
        );
        if (tables.length === 0) return [];
        try {
          const rows = await executeSearchWithSharedFallback(
            dependencies,
            tables,
            args.query,
            totalNeeded,
            mode,
            tier,
            0,
            namespace,
            {},
            requestedNamespace !== undefined &&
              isSharedNamespace(requestedNamespace),
          );
          return rows.map(toUnifiedResult);
        } catch (error) {
          dependencies.logger.warn(
            {
              error_message:
                error instanceof Error ? error.message : String(error),
            },
            "search_all_brain_failed",
          );
          return [];
        }
      };

      const [brainResults, qmdResults] = await Promise.all([
        wantBrain ? brainSearch() : Promise.resolve<UnifiedResult[]>([]),
        wantQmd && qmdPath
          ? searchQmd(
              dependencies,
              qmdPath,
              args.query,
              totalNeeded,
              args.collection,
            )
          : Promise.resolve<UnifiedResult[]>([]),
      ]);

      // Position-based fusion, so both sources get fair representation whatever
      // their raw score scales. Brain rows additionally carry the cognitive-tier
      // boost, floored at zero so a cold-tier penalty cannot go negative.
      const fused: Array<UnifiedResult & { rrf: number }> = [];
      brainResults.forEach((result, index) => {
        fused.push({
          ...result,
          rrf: Math.max(
            0,
            1 / (RRF_K + index + 1) +
              TIER_BOOST[(result.tier ?? "warm") as Tier],
          ),
        });
      });
      qmdResults.forEach((result, index) => {
        fused.push({ ...result, rrf: 1 / (RRF_K + index + 1) });
      });

      type RankedCandidate = UnifiedResult & {
        rrf: number;
        trace_index: number;
      };
      let rankedCandidates: RankedCandidate[] = [];
      const selectedCandidates = traceRetrievalSpanSync({
        name: "retrieval.federated_rank",
        input: {
          brain_count: brainResults.length,
          qmd_count: qmdResults.length,
        },
        metadata: {
          stage: "scoring_ranking",
          filter_names: ["pagination_offset", "federated_rank_window"],
        },
        run: () => {
          rankedCandidates = fused
            .map((row, trace_index) => ({ ...row, trace_index }))
            .sort((a, b) => b.rrf - a.rrf);
          return rankedCandidates.slice(offset, offset + limit);
        },
        output: (selected) => {
          const selectedIndexes = new Set(
            selected.map((row) => row.trace_index),
          );
          return {
            candidate_count: rankedCandidates.length,
            selected_count: selected.length,
            returned_row_ids: selected
              .filter((row) => row.source === "brain")
              .map((row) => row.id),
            candidates: rankedCandidates.map((row, rankIndex) => {
              const chosen = selectedIndexes.has(row.trace_index);
              return {
                source: row.source,
                row_id: row.id ?? null,
                path: row.path ?? null,
                content: row.content,
                raw_score: row.score,
                rrf_score: row.rrf,
                chosen,
                filtered_by: federatedFilteredBy(chosen, rankIndex, offset),
              };
            }),
          };
        },
      });
      const tracedMerged = selectedCandidates.map(
        ({ rrf, trace_index: _traceIndex, ...rest }) => ({
          ...rest,
          score: rrf,
        }),
      );

      return textResult({
        total: tracedMerged.length,
        brain_hits: brainResults.length,
        qmd_hits: qmdResults.length,
        results: tracedMerged,
      });
    },
  );
}
