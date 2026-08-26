/**
 * `search_brain` — the primary retrieval surface over the brain tables.
 *
 * Design authority: #341 (the FTS regconfig allowlist and the privilege boundary
 * on non-English configurations) and `docs/decisions/privilege-isolation-closed-brain.md`
 * (namespace isolation is enforced server-side, from token-derived identity).
 *
 * The tool ARGUMENTS are a frozen contract. Existing clients pass `query`,
 * `table`, `namespace`, `limit`, `offset`, `search_mode`, `tier`, and
 * `fts_config`; those names, types, and bounds are reproduced here exactly.
 *
 * Two behaviors are easy to get wrong and are asserted by tests rather than left
 * to review:
 *
 *   1. AN EMPTY RESULT SET IS NOT AN ERROR. `[]` with `isError` unset means the
 *      query ran and matched nothing. A failure returns `isError: true` and logs
 *      `search_brain_failed` with the driver's diagnostic fields. Collapsing the
 *      two is this repo's named anti-pattern (`docs/GOTCHAS.md`): it makes an
 *      outage look like an empty brain, and nothing downstream can tell them
 *      apart afterwards.
 *
 *   2. DENIALS ARE CONTENT-FREE. A namespace the caller may not read returns one
 *      fixed string that does not echo the requested namespace back, so the
 *      denial cannot be used to probe which namespaces exist.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResourceTable } from "../auth/types.ts";
import { canRead } from "../auth/permissions.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import { respondToSearchFailure } from "./tool-failure.ts";
import { canReadNamespace, namespaceFilterFor } from "./read-scope.ts";
import { isSharedNamespace } from "./shared-namespace.ts";
import { ALL_TABLES, type Tier } from "./search-constants.ts";
import {
  executeSearchWithSharedFallback,
  type SearchMode,
} from "./search-engine.ts";
import { setActiveMcpTraceMetadata } from "../observability/langfuse-tracing.ts";
import {
  DEFAULT_FTS_CONFIG,
  type FtsConfig,
  requestFtsConfig,
  SUPPORTED_FTS_CONFIGS,
} from "./fts-config.ts";

/** Content-free denial for an unreadable namespace; never echoes the request. */
const NAMESPACE_DENIED = "Permission denied: namespace read access denied";
const NO_READABLE_TABLES = "Permission denied: no readable tables";
const NON_ENGLISH_FTS_DENIED =
  "Permission denied: non-English FTS configuration requires admin or ob-admin";

/**
 * Resolve which tables this search reads.
 *
 * @returns The accessible tables, or a denial message when none are readable or
 *   the explicitly requested table is not.
 */
function resolveTables(
  role: Parameters<typeof canRead>[0],
  requested: ResourceTable | undefined,
): { tables: ResourceTable[] } | { denial: string } {
  if (requested) {
    if (!canRead(role, requested)) {
      return { denial: `Permission denied: cannot read ${requested}` };
    }
    return { tables: [requested] };
  }
  const tables = ALL_TABLES.filter((table) => canRead(role, table));
  if (tables.length === 0) return { denial: NO_READABLE_TABLES };
  return { tables: [...tables] };
}

/** Frozen `search_brain` argument contract: the names, types, and rule values are the API. */
const searchBrainInputSchema = {
  query: z.string().min(1).describe("Natural language search query"),
  table: z
    .enum(["thoughts", "decisions", "relationships", "projects", "sessions"])
    .optional()
    .describe("Optional: limit search to a specific table"),
  namespace: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Optional: filter results to a specific namespace (e.g. clientId or 'shared-kb')",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(250)
    .optional()
    .describe("Maximum results to return (default 10)"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of results to skip for pagination (default 0)"),
  search_mode: z
    .enum(["hybrid", "vector", "keyword"])
    .optional()
    .describe(
      "Search mode: hybrid (default) = vector + keyword with RRF fusion, vector = semantic only, keyword = full-text only",
    ),
  tier: z
    .enum(["hot", "warm", "cold"])
    .optional()
    .describe("Optional: filter results to a specific cognitive tier"),
  fts_config: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe(
      `Optional: keyword full-text-search language configuration for this request. ` +
        `Accepts a supported Postgres regconfig (${SUPPORTED_FTS_CONFIGS.join(", ")}) ` +
        `or a language token (e.g. 'de', 'de-DE', 'spanish'). Unrecognized values ` +
        `fall back to the deployment corpus default (OPENBRAIN_FTS_CONFIG, else english). ` +
        `An explicitly requested effective non-English config requires admin or ob-admin ` +
        `for keyword/hybrid searches; vector mode performs no FTS, so fts_config is ` +
        `ignored there. For ordinary roles, a non-English deployment env default ` +
        `degrades to english rather than denying. ` +
        `Affects keyword/hybrid stemming only; english is byte-identical to prior behavior.`,
    ),
};

/** Tool annotations; `search_brain` reads and never mutates. */
const searchBrainAnnotations = {
  title: "Search Brain",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

/** The request-shaped arguments after defaults are applied. */
interface NormalizedSearchArgs {
  limit: number;
  offset: number;
  mode: SearchMode;
  tier: Tier | undefined;
  requestedNamespace: string | undefined;
  requestedFtsConfig: string | undefined;
}

/**
 * Apply the documented argument defaults.
 *
 * @returns The normalized arguments; the defaults are part of the frozen contract.
 */
function normalizeSearchArgs(args: {
  limit?: number;
  offset?: number;
  search_mode?: string;
  tier?: string;
  namespace?: string;
  fts_config?: string;
}): NormalizedSearchArgs {
  return {
    limit: args.limit ?? 10,
    offset: args.offset ?? 0,
    mode: (args.search_mode as SearchMode | undefined) ?? "hybrid",
    tier: args.tier as Tier | undefined,
    requestedNamespace: args.namespace,
    requestedFtsConfig: args.fts_config,
  };
}

/**
 * Resolve the effective FTS configuration under the non-English privilege boundary.
 *
 * The boundary applies to the EFFECTIVE configuration for arms that actually run
 * FTS, regardless of where it came from: both an explicit argument and the
 * deployment env default select the same unindexed on-the-fly `to_tsvector` path
 * (#368 finding 1).
 *
 * @returns The resolved config, or a denial when an ordinary role explicitly
 *   requested a non-English config for an arm that runs FTS.
 */
function resolveCallerFtsConfig(options: {
  role: string;
  mode: SearchMode;
  requestedFtsConfig: string | undefined;
  ftsCorpusConfig: FtsConfig | undefined;
}): { ftsConfig: FtsConfig } | { denial: string } {
  const { role, mode, requestedFtsConfig, ftsCorpusConfig } = options;
  const ftsPrivileged = role === "admin" || role === "ob-admin";
  const ftsConfig = requestFtsConfig(requestedFtsConfig, ftsCorpusConfig);
  if (ftsConfig === DEFAULT_FTS_CONFIG || ftsPrivileged) return { ftsConfig };
  if (mode !== "vector" && requestedFtsConfig !== undefined) {
    return { denial: NON_ENGLISH_FTS_DENIED };
  }
  // Reached only when the non-English config came from the operator env
  // default, or the mode is vector and performs no FTS at all (#368
  // finding 2). Degrade to the GIN-indexed english path instead of
  // denying: an ordinary role keeps exactly the pre-#341 availability and
  // cost, and an argument that cannot influence execution must not deny.
  return { ftsConfig: DEFAULT_FTS_CONFIG };
}

export function registerSearchBrainTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "search_brain",
    {
      description:
        "Search across all brain tables. Supports hybrid (vector + keyword), pure vector, or keyword-only modes.",
      inputSchema: searchBrainInputSchema,
      annotations: searchBrainAnnotations,
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return errorResult(NO_READABLE_TABLES);

      const resolved = resolveTables(
        identity.role,
        args.table as ResourceTable | undefined,
      );
      if ("denial" in resolved) return errorResult(resolved.denial);

      const { limit, offset, mode, tier, requestedNamespace, requestedFtsConfig } =
        normalizeSearchArgs(args);

      const fts = resolveCallerFtsConfig({
        role: identity.role,
        mode,
        requestedFtsConfig,
        ftsCorpusConfig: dependencies.ftsCorpusConfig,
      });
      if ("denial" in fts) return errorResult(fts.denial);
      const ftsConfig = fts.ftsConfig;

      if (
        requestedNamespace &&
        !canReadNamespace(identity, requestedNamespace)
      ) {
        return errorResult(NAMESPACE_DENIED);
      }
      const namespace = namespaceFilterFor(identity, requestedNamespace);
      setActiveMcpTraceMetadata({ resolved_namespace: namespace ?? null });

      try {
        const rows = await executeSearchWithSharedFallback(
          dependencies,
          resolved.tables,
          args.query,
          limit,
          mode,
          tier,
          offset,
          namespace,
          { ftsConfig },
          requestedNamespace !== undefined &&
            isSharedNamespace(requestedNamespace),
        );
        return textResult(rows);
      } catch (error) {
        // The one place the driver's diagnostic fields still exist. By the time
        // this is a text response they are gone, and an empty array would be
        // indistinguishable from a genuine no-match.
        return respondToSearchFailure({
          logger: dependencies.logger,
          event: "search_brain_failed",
          error,
          namespace,
          mode,
          tier,
        });
      }
    },
  );
}
