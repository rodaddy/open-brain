import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { trackUsage } from "./legacy-search-execute.ts";
import {
  executeSearchWithScopedSharedFallback,
  executeSearchWithSharedFallback,
} from "./legacy-search-fallback-executors.ts";
import { canRead } from "../../security/permissions.ts";
import { canReadNamespace, namespaceFilterFor } from "../../domain/read-policy.ts";
import { isSharedNamespace } from "../../../src/shared-namespace.ts";
import {
  sourceScopeAuthorizationError,
  sourceScopeSchema,
  type SourceScope,
} from "../../domain/source-refs.ts";
import type { AuthInfo, Tier } from "../../../src/types.ts";
import type { ToolDeps } from "../../../src/tools/index.ts";
import { logger } from "../../../src/logger.ts";
import { describeError } from "../../../src/observability/index.ts";
import { setActiveMcpTraceMetadata } from "../../observability/langfuse-tracing.ts";
import {
  DEFAULT_FTS_CONFIG,
  requestFtsConfigFromReader as requestFtsConfig,
  SUPPORTED_FTS_CONFIGS,
} from "./fts-config.ts";
import {
  NON_ENGLISH_FTS_AUTHORIZATION_ERROR,
  readableSearchTables,
  type SearchMode,
  type SearchTable,
} from "./legacy-search-tables-and-parsing.ts";
const SEARCH_BRAIN_DESCRIPTION =
  "Search across all brain tables. Supports hybrid (vector + keyword), pure vector, or keyword-only modes.";

const FTS_CONFIG_DESCRIPTION =
  `Optional: keyword full-text-search language configuration for this request. ` +
  `Accepts a supported Postgres regconfig (${SUPPORTED_FTS_CONFIGS.join(", ")}) ` +
  `or a language token (e.g. 'de', 'de-DE', 'spanish'). Unrecognized values ` +
  `fall back to the deployment corpus default (OPENBRAIN_FTS_CONFIG, else english). ` +
  `An explicitly requested effective non-English config requires admin or ob-admin ` +
  `for keyword/hybrid searches; vector mode performs no FTS, so fts_config is ` +
  `ignored there. For ordinary roles, a non-English deployment env default ` +
  `degrades to english rather than denying. ` +
  `Affects keyword/hybrid stemming only; english is byte-identical to prior behavior.`;

const SEARCH_BRAIN_INPUT_SCHEMA = {
  query: z.string().min(1).describe("Natural language search query"),
  table: z
    .enum([
      "thoughts",
      "decisions",
      "relationships",
      "projects",
      "sessions",
      "entities",
      "session_events",
    ])
    .optional()
    .describe("Optional: restrict search to a single named source"),
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
  source_scope: sourceScopeSchema
    .optional()
    .describe(
      "Optional: require matching source reference client_id, matter_id, document_id, path, and/or dms_id.",
    ),
  fts_config: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe(FTS_CONFIG_DESCRIPTION),
};

const SEARCH_BRAIN_ANNOTATIONS = {
  title: "Search Brain",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

/** The one content shape every branch of the handler returns. */
function textResult(text: string, isError = false) {
  const content = [{ type: "text" as const, text }];
  return isError ? { content, isError: true } : { content };
}

type ToolResult = ReturnType<typeof textResult>;

/** A phase either produced its value or produced the response to return. */
type PhaseFailure = { error: ToolResult };

/** Everything the handler settled from the arguments before any table read. */
type SearchRequest = {
  query: string;
  accessibleTables: SearchTable[];
  limit: number;
  offset: number;
  mode: SearchMode;
  tier: Tier | undefined;
  requestedNamespace: string | undefined;
  sourceScope: SourceScope | undefined;
  ftsConfig: ReturnType<typeof requestFtsConfig>;
};

/** The tables a single-table request may read, or the denial for that table. */
function tablesForFilter(
  tableFilter: SearchTable,
  auth: AuthInfo,
): SearchTable[] | PhaseFailure {
  if (tableFilter === "entities") {
    if (!canRead(auth.role, "sessions")) {
      return { error: textResult("Permission denied: cannot read entities", true) };
    }
    return ["entities"];
  }
  if (tableFilter === "session_events") {
    // Session events are session-scoped content, so they ride the
    // `sessions` read permission -- the same indirection `entities` uses
    // above. There is no `session_events` row in PERMISSIONS because the
    // corpus is read-only through this surface and never written here.
    if (!canRead(auth.role, "sessions")) {
      return {
        error: textResult("Permission denied: cannot read session_events", true),
      };
    }
    return ["session_events"];
  }
  if (!canRead(auth.role, tableFilter)) {
    return {
      error: textResult(`Permission denied: cannot read ${tableFilter}`, true),
    };
  }
  return [tableFilter];
}

/**
 * Settle the effective FTS config for this request. The non-English privilege
 * boundary applies to the EFFECTIVE config for keyword/hybrid searches
 * regardless of provenance (request argument or OPENBRAIN_FTS_CONFIG env
 * default), because either one selects the unindexed on-the-fly to_tsvector
 * path (#368 post-merge finding 1).
 */
function resolveFtsConfig(
  requestedFtsConfig: string | undefined,
  mode: SearchMode,
  auth: AuthInfo,
): ReturnType<typeof requestFtsConfig> | PhaseFailure {
  const ftsConfig = requestFtsConfig(requestedFtsConfig);
  const ftsPrivileged = auth.role === "admin" || auth.role === "ob-admin";
  if (ftsConfig === DEFAULT_FTS_CONFIG || ftsPrivileged) return ftsConfig;
  if (mode !== "vector" && requestedFtsConfig !== undefined) {
    // An ordinary role explicitly asked for an effective non-English
    // config on a mode that runs FTS: content-free denial (unchanged).
    return { error: textResult(NON_ENGLISH_FTS_AUTHORIZATION_ERROR, true) };
  }
  // Non-English arrived only via the operator env default, or the mode
  // is vector (which performs no FTS, so fts_config is unused -- #368
  // post-merge finding 2). Degrade to the GIN-indexed english default
  // instead of denying: ordinary roles keep exactly the pre-#341
  // availability and cost profile, and an unused argument can neither
  // deny nor influence execution.
  return DEFAULT_FTS_CONFIG;
}

/** Phase one: permissions on the requested tables, then the request values. */
function parseSearchRequest(
  args: {
    query: string;
    table?: string;
    namespace?: string;
    limit?: number;
    offset?: number;
    search_mode?: string;
    tier?: string;
    source_scope?: unknown;
    fts_config?: string;
  },
  auth: AuthInfo,
): { request: SearchRequest } | PhaseFailure {
  const tableFilter = args.table as SearchTable | undefined;
  let accessibleTables: SearchTable[];
  if (tableFilter) {
    const resolved = tablesForFilter(tableFilter, auth);
    if ("error" in resolved) return resolved;
    accessibleTables = resolved;
  } else {
    accessibleTables = readableSearchTables(auth.role, { includeEntities: true });
  }
  if (accessibleTables.length === 0) {
    return { error: textResult("Permission denied: no readable tables", true) };
  }

  const mode = (args.search_mode as SearchMode) ?? "hybrid";
  const ftsConfig = resolveFtsConfig(args.fts_config as string | undefined, mode, auth);
  if (typeof ftsConfig === "object" && "error" in ftsConfig) return ftsConfig;

  return {
    request: {
      query: args.query,
      accessibleTables,
      limit: args.limit ?? 10,
      offset: args.offset ?? 0,
      mode,
      tier: args.tier as Tier | undefined,
      requestedNamespace: args.namespace as string | undefined,
      sourceScope: args.source_scope as SourceScope | undefined,
      ftsConfig,
    },
  };
}

/** What the scope phase settles: the tables to read and the namespace filter. */
type SearchScope = {
  accessibleTables: SearchTable[];
  namespace: ReturnType<typeof namespaceFilterFor>;
  shouldUseSharedFallback: boolean;
};

/** Phase two: source-scope authorization, table exclusion, namespace filter. */
function resolveSearchScope(
  request: SearchRequest,
  auth: AuthInfo,
): { scope: SearchScope } | PhaseFailure {
  const { sourceScope, requestedNamespace } = request;
  const sourceScopeError = sourceScopeAuthorizationError(auth, sourceScope);
  if (sourceScopeError) return { error: textResult(sourceScopeError, true) };

  let accessibleTables = request.accessibleTables;
  if (sourceScope) {
    // Same reason as executeSearchInternal: no source_refs column means a
    // source scope cannot be honored, so the corpus is excluded rather
    // than silently ignoring the scope.
    accessibleTables = accessibleTables.filter(
      (table) => table !== "entities" && table !== "session_events",
    );
  }
  if (accessibleTables.length === 0) {
    return { error: textResult("No source-scoped tables are readable") };
  }
  if (requestedNamespace && !canReadNamespace(auth, requestedNamespace)) {
    return {
      error: textResult("Permission denied: namespace read access denied", true),
    };
  }

  const namespace = namespaceFilterFor(auth, requestedNamespace);
  setActiveMcpTraceMetadata({ resolved_namespace: namespace ?? null });
  return {
    scope: {
      accessibleTables,
      namespace,
      shouldUseSharedFallback:
        requestedNamespace !== undefined && isSharedNamespace(requestedNamespace),
    },
  };
}

/** Phase three: run the retrieval, turning a thrown failure into a response. */
async function runSearchRequest(
  deps: ToolDeps,
  request: SearchRequest,
  scope: SearchScope,
): Promise<
  { rows: Awaited<ReturnType<typeof executeSearchWithSharedFallback>> } | PhaseFailure
> {
  const { query, limit, mode, tier, offset, sourceScope, ftsConfig } = request;
  const searchOptions = {
    deps,
    accessibleTables: scope.accessibleTables,
    query,
    limit,
    mode,
    tier,
    offset,
    namespace: scope.namespace,
    includeLinks: undefined,
    sourceScope,
    tuning: { enableGraph: true, ftsConfig },
  };
  try {
    const rows = scope.shouldUseSharedFallback
      ? await executeSearchWithSharedFallback(searchOptions)
      : await executeSearchWithScopedSharedFallback(searchOptions);
    return { rows };
  } catch (err) {
    // "An empty result set" is this repo's named anti-pattern
    // (docs/GOTCHAS.md): a failed search and a search that found nothing
    // were indistinguishable in the logs. The pg fields exist only here.
    logger.error("search_brain_failed", {
      namespace: scope.namespace,
      mode,
      tier,
      ...describeError(err),
    });
    const message = err instanceof Error ? err.message : String(err);
    return { error: textResult(message, true) };
  }
}

/** Phase four: the rows as the tool's text content. */
function shapeSearchResult(rows: unknown): ToolResult {
  return textResult(JSON.stringify(rows));
}

export function registerSearchBrain(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "search_brain",
    {
      description: SEARCH_BRAIN_DESCRIPTION,
      inputSchema: SEARCH_BRAIN_INPUT_SCHEMA,
      annotations: SEARCH_BRAIN_ANNOTATIONS,
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth) return textResult("Permission denied: no readable tables", true);

      const parsed = parseSearchRequest(args, auth);
      if ("error" in parsed) return parsed.error;

      const scoped = resolveSearchScope(parsed.request, auth);
      if ("error" in scoped) return scoped.error;

      const outcome = await runSearchRequest(deps, parsed.request, scoped.scope);
      if ("error" in outcome) return outcome.error;

      trackUsage({
        deps,
        rows: outcome.rows,
        queryText: parsed.request.query,
        context: "search",
        accessedBy: auth.clientId,
      });

      return shapeSearchResult(outcome.rows);
    },
  );
}
