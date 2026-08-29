// MCP tool registration for repo facts: the upsert and list boundaries. The
// vocabulary, schema, and pure helpers live in ./repo-facts-model.ts and
// ./repo-facts-source-urls.ts (issue 864).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canRead, canWrite } from "../../src/permissions.ts";
import { canWriteNamespace } from "../../src/namespace-policy.ts";
import { canReadNamespace, namespaceFilterFor } from "../../src/read-policy.ts";
import {
  isSharedNamespace,
  sharedNamespaceConfig,
} from "../../src/shared-namespace.ts";
import type { AuthInfo } from "../../src/types.ts";
import { logger } from "../../src/logger.ts";
import type { ToolDeps } from "../../src/tools/index.ts";
import {
  canonicalId,
  canonicalizeRepoFactRows,
  containsSecretLikeValue,
  entityName,
  factSubject,
  looksLikeRawCodeDump,
  mergeRepoFactFallbackRows,
  namespaceClause,
  repoFactMetadata,
  FACT_TYPES,
} from "./repo-facts-model.ts";

// The vocabulary, schema, contracts, and pure helpers keep one import site for
// callers, exactly as they had when all of this lived in one file.
export * from "./repo-facts-model.ts";

export function registerUpsertRepoFact(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "upsert_repo_fact",
    {
      description:
        "Upsert a curated qmd-derived repository fact into Open Brain graph entity metadata. " +
        "This stores stable operating knowledge plus source pointers, not raw code chunks.",
      inputSchema: {
        namespace: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .optional()
          .describe("Namespace for isolation (defaults to agent's clientId)."),
        metadata: repoFactMetadata.describe(
          "Curated qmd-derived repository fact metadata.",
        ),
      },
      annotations: {
        title: "Upsert Repo Fact",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => await handleUpsertRepoFact(args, extra, deps),
  );
}

// A content-free tool error. The text is the whole payload the caller sees.
function toolError(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

// Authorization for an upsert: the role must be able to write sessions, and the
// resolved namespace must pass the server-side namespace check. Returns the
// resolved namespace, or the error the caller should return unchanged.
function authorizeUpsert(
  auth: AuthInfo | undefined,
  requestedNamespace: string | undefined,
): { ns: string; auth: AuthInfo } | { error: ReturnType<typeof toolError> } {
  if (!auth || !canWrite(auth.role, "sessions")) {
    return { error: toolError("Permission denied: cannot write repo facts") };
  }
  const ns = requestedNamespace ?? auth.clientId;
  const nsCheck = canWriteNamespace(auth, ns);
  if (!nsCheck.allowed) {
    return { error: toolError(`Permission denied: ${nsCheck.reason}`) };
  }
  return { ns, auth };
}

// The fact text screens. Repo facts carry operating knowledge, never raw code
// and never credential-like material.
function screenFactText(fact: string): ReturnType<typeof toolError> | null {
  if (looksLikeRawCodeDump(fact)) {
    return toolError("Rejected repo fact: fact appears to contain a raw code chunk");
  }
  if (containsSecretLikeValue(fact)) {
    return toolError(
      "Rejected repo fact: fact appears to contain credential-like material",
    );
  }
  return null;
}

// Best-effort embedding. A failure is logged content-free and the row is stored
// without a vector rather than losing the fact.
async function embedRepoFact(
  metadata: ReturnType<typeof repoFactMetadata.parse>,
  factCanonicalId: string,
  deps: ToolDeps,
): Promise<number[] | null> {
  try {
    return await deps.embedFn(
      `${metadata.repo} ${metadata.path} ${factSubject(metadata)} ${metadata.fact}`,
    );
  } catch (err) {
    logger.warn("upsert_repo_fact_embed_error", {
      canonical_id: factCanonicalId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function handleUpsertRepoFact(
  args: { namespace?: string; metadata: unknown },
  extra: { authInfo?: unknown },
  deps: ToolDeps,
) {
  const authorized = authorizeUpsert(
    extra.authInfo as AuthInfo | undefined,
    args.namespace,
  );
  if ("error" in authorized) return authorized.error;
  const { ns, auth } = authorized;

  const metadata = repoFactMetadata.parse(args.metadata);
  const screened = screenFactText(metadata.fact);
  if (screened) return screened;

  const factCanonicalId = canonicalId(metadata);
  const name = entityName(metadata);
  const storedMetadata = {
    ...metadata,
    fact_id: factCanonicalId,
    promoted_as: "repo_fact",
  };

  const embedding = await embedRepoFact(metadata, factCanonicalId, deps);

  const { rows } = await deps.pool.query(
    `INSERT INTO ob_entities
       (entity_type, name, canonical_id, namespace, metadata, embedding, created_by)
     VALUES ('repo_fact', $1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (namespace, entity_type, lower(name))
     WHERE archived_at IS NULL
     DO UPDATE SET
       canonical_id = EXCLUDED.canonical_id,
       metadata = EXCLUDED.metadata,
       embedding = COALESCE(EXCLUDED.embedding, ob_entities.embedding),
       archived_at = NULL,
       updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new, entity_type, name, canonical_id, namespace, metadata, created_at, updated_at`,
    [
      name,
      factCanonicalId,
      ns,
      JSON.stringify(storedMetadata),
      embedding ? toSql(embedding) : null,
      auth.clientId,
    ],
  );

  return {
    content: [{ type: "text" as const, text: JSON.stringify(rows[0]) }],
  };
}

export function registerListRepoFacts(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_repo_facts",
    {
      description:
        "List curated qmd-derived repository facts from Open Brain graph entity metadata.",
      inputSchema: {
        namespace: z.string().trim().min(1).max(500).optional(),
        repo: z.string().trim().min(1).max(300).optional(),
        collection: z.string().trim().min(1).max(300).optional(),
        path: z.string().trim().min(1).max(1000).optional(),
        fact_type: z.enum(FACT_TYPES).optional(),
        subject: z.string().trim().min(1).max(500).optional(),
        limit: z.number().int().min(1).max(250).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: {
        title: "List Repo Facts",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => await handleListRepoFacts(args, extra, deps),
  );
}

// The metadata columns a caller may filter on, and the SQL each one produces.
// Column names and the JSON keys are literals here; every value is bound.
const LIST_METADATA_FILTERS = [
  { arg: "repo", sql: (p: number) => `metadata->>'repo' = $${p}` },
  { arg: "collection", sql: (p: number) => `metadata->>'collection' = $${p}` },
  { arg: "path", sql: (p: number) => `metadata->>'path' = $${p}` },
  { arg: "fact_type", sql: (p: number) => `metadata->>'fact_type' = $${p}` },
  {
    arg: "subject",
    sql: (p: number) => `(metadata->>'subject' = $${p} OR metadata->>'symbol' = $${p})`,
  },
] as const;

type ListRepoFactsArgs = Record<string, unknown> & {
  namespace?: string;
  limit?: number;
  offset?: number;
};

// One page of repo-fact rows for a namespace filter. Bound to the caller's args
// so the fallback paths below can re-run it against a different namespace.
function repoFactPageQuery(args: ListRepoFactsArgs, deps: ToolDeps) {
  return async (
    queryNamespace: string | string[] | undefined,
    queryLimit: number,
    queryOffset: number,
  ): Promise<Record<string, unknown>[]> => {
    const params: unknown[] = [];
    const filters = ["entity_type = 'repo_fact'", "archived_at IS NULL"];
    const ns = namespaceClause(queryNamespace, params);
    if (ns) filters.push(ns.slice(" AND ".length));
    for (const filter of LIST_METADATA_FILTERS) {
      const value = args[filter.arg];
      if (!value) continue;
      params.push(value);
      filters.push(filter.sql(params.length));
    }

    params.push(queryLimit, queryOffset);
    const { rows } = await deps.pool.query(
      `SELECT id, entity_type, name, canonical_id, namespace, metadata, created_by, created_at, updated_at
       FROM ob_entities
       WHERE ${filters.join(" AND ")}
       ORDER BY updated_at DESC, created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows as Record<string, unknown>[];
  };
}

type PageQuery = ReturnType<typeof repoFactPageQuery>;
type SharedConfig = ReturnType<typeof sharedNamespaceConfig>;

// Whether the legacy shared-namespace fallback is even eligible: it is enabled,
// a legacy namespace is configured, and this is the first page.
function legacyFallbackEligible(config: SharedConfig, offset: number): boolean {
  return (
    config.legacyFallbackEnabled && config.legacySharedNamespace !== "" && offset === 0
  );
}

// The shared-namespace read already returned enough, so the legacy namespace
// does not need to be consulted at all.
function sharedReadIsSufficient(
  sharedRows: Record<string, unknown>[],
  limit: number,
  config: SharedConfig,
): boolean {
  return sharedRows.length >= limit || sharedRows.length >= config.fallbackMinResults;
}

// A read scoped to the shared namespace itself.
async function readSharedNamespace(
  queryRows: PageQuery,
  limit: number,
  config: SharedConfig,
): Promise<Record<string, unknown>[]> {
  const sharedRows = await queryRows(config.sharedNamespace, limit, 0);
  if (sharedReadIsSufficient(sharedRows, limit, config)) return sharedRows;
  const legacyRows = await queryRows(config.legacySharedNamespace, limit, 0);
  return mergeRepoFactFallbackRows(sharedRows, legacyRows, limit);
}

// A multi-namespace read that includes the shared namespace. The shared read
// decides whether the legacy namespace is consulted; the rows returned are the
// caller's own primary page either way.
async function readNamespaceSetWithShared(
  queryRows: PageQuery,
  namespace: string[],
  limit: number,
  config: SharedConfig,
): Promise<Record<string, unknown>[]> {
  const [primaryRows, sharedRows] = await Promise.all([
    queryRows(namespace, limit, 0),
    queryRows(config.physicalSharedNamespace, limit, 0),
  ]);
  if (sharedReadIsSufficient(sharedRows, limit, config)) return primaryRows;
  const legacyRows = await queryRows(config.legacySharedNamespace, limit, 0);
  return mergeRepoFactFallbackRows(primaryRows, legacyRows, limit);
}

interface ReadRepoFactPageArgs {
  namespace: string | string[] | undefined;
  limit: number;
  offset: number;
  queryRows: PageQuery;
}

// Which read path the namespace filter earns: the shared namespace on its own,
// a namespace set that includes it, or a plain paged read. Only the first two
// consult the legacy shared namespace, and only on the first page.
async function readRepoFactPage(
  args: ReadRepoFactPageArgs,
): Promise<Record<string, unknown>[]> {
  const { namespace, limit, offset, queryRows } = args;
  const config = sharedNamespaceConfig();
  if (legacyFallbackEligible(config, offset)) {
    if (typeof namespace === "string" && isSharedNamespace(namespace)) {
      return await readSharedNamespace(queryRows, limit, config);
    }
    if (
      Array.isArray(namespace) &&
      namespace.includes(config.physicalSharedNamespace)
    ) {
      return await readNamespaceSetWithShared(queryRows, namespace, limit, config);
    }
  }
  return await queryRows(namespace, limit, offset);
}

async function handleListRepoFacts(
  args: ListRepoFactsArgs,
  extra: { authInfo?: unknown },
  deps: ToolDeps,
) {
  const auth = extra.authInfo as AuthInfo | undefined;
  if (!auth || !canRead(auth.role, "sessions")) {
    return toolError("Permission denied: cannot read repo facts");
  }

  const requestedNamespace = args.namespace;
  if (requestedNamespace && !canReadNamespace(auth, requestedNamespace)) {
    return toolError("Permission denied: namespace read access denied");
  }

  const namespace = namespaceFilterFor(auth, requestedNamespace);
  const rows = await readRepoFactPage({
    namespace,
    limit: args.limit ?? 50,
    offset: args.offset ?? 0,
    queryRows: repoFactPageQuery(args, deps),
  });

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(canonicalizeRepoFactRows(rows)),
      },
    ],
  };
}
