/**
 * Curated qmd-derived repository facts, stored as `repo_fact` graph entities.
 *
 * Design authority: `docs/decisions/shared-kb-canonical-namespace.md` for the
 * canonical/legacy shared-namespace split and its read-time fallback.
 *
 * A repo fact is STABLE OPERATING KNOWLEDGE plus source pointers -- never a raw
 * code chunk and never credential-like material. Both refusals are enforced
 * here on the write path, and the validators are imported from the current-src
 * module rather than reimplemented: a second copy of a secret detector that
 * drifts is a detector that silently stops detecting.
 */
import { z } from "zod";
import { toSql } from "pgvector/pg";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead, canWrite } from "../auth/permissions.ts";
import {
  canTargetNamespace,
  namespacePredicate,
} from "../auth/namespace-policy.ts";
import {
  isSharedNamespace,
  sharedNamespaceConfig,
} from "../../src/shared-namespace.ts";
import {
  FACT_TYPES,
  canonicalId,
  canonicalizeRepoFactRows,
  containsSecretLikeValue,
  entityName,
  factSubject,
  looksLikeRawCodeDump,
  mergeRepoFactFallbackRows,
  repoFactMetadata,
} from "../../src/tools/repo-facts.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";

const REPO_FACT_COLUMNS = `id, entity_type, name, canonical_id, namespace,
  metadata, created_by, created_at, updated_at`;

/** Input schema for `upsert_repo_fact`, hoisted so the registrar stays small. */
const UPSERT_REPO_FACT_SCHEMA = {
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
};

/** Input schema for `list_repo_facts`, hoisted so the registrar stays small. */
const LIST_REPO_FACTS_SCHEMA = {
  namespace: z.string().trim().min(1).max(500).optional(),
  repo: z.string().trim().min(1).max(300).optional(),
  collection: z.string().trim().min(1).max(300).optional(),
  path: z.string().trim().min(1).max(1000).optional(),
  fact_type: z.enum(FACT_TYPES).optional(),
  subject: z.string().trim().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(250).optional(),
  offset: z.number().int().min(0).optional(),
};

type UpsertRepoFactArgs = {
  namespace?: string;
  metadata: z.infer<typeof repoFactMetadata>;
};

type ListRepoFactsArgs = {
  namespace?: string;
  repo?: string;
  collection?: string;
  path?: string;
  fact_type?: (typeof FACT_TYPES)[number];
  subject?: string;
  limit?: number;
  offset?: number;
};

export function registerRepoFactTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "upsert_repo_fact",
    {
      description:
        "Upsert a curated qmd-derived repository fact into Open Brain graph entity metadata. " +
        "This stores stable operating knowledge plus source pointers, not raw code chunks.",
      inputSchema: UPSERT_REPO_FACT_SCHEMA,
      annotations: {
        title: "Upsert Repo Fact",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) =>
      handleUpsertRepoFact(dependencies, args, authIdentity(extra.authInfo)),
  );

  server.registerTool(
    "list_repo_facts",
    {
      description:
        "List curated qmd-derived repository facts from Open Brain graph entity metadata.",
      inputSchema: LIST_REPO_FACTS_SCHEMA,
      annotations: {
        title: "List Repo Facts",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) =>
      handleListRepoFacts(dependencies, args, authIdentity(extra.authInfo)),
  );
}

/**
 * Embed the fact text, or give up and keep the write.
 *
 * A failed embedding must not fail the write: the fact is the durable value and
 * the vector is derived from it. The failure is logged with the canonical id so
 * a missing vector is traceable, then the caller proceeds without one.
 */
async function embedRepoFact(
  dependencies: MemoryToolDependencies,
  metadata: z.infer<typeof repoFactMetadata>,
  factCanonicalId: string,
): Promise<number[] | null> {
  try {
    return await dependencies.embedFn(
      `${metadata.repo} ${metadata.path} ${factSubject(metadata)} ${metadata.fact}`,
    );
  } catch (error) {
    dependencies.logger.warn(
      {
        canonicalId: factCanonicalId,
        error: error instanceof Error ? error.message : String(error),
      },
      "upsert_repo_fact_embed_failed",
    );
    return null;
  }
}

/**
 * Refuse a fact that is not stable operating knowledge.
 *
 * A repo fact is knowledge ABOUT code, not the code itself, and never a
 * credential. Both checks run before anything is stored or embedded. Returns
 * the ready-to-return refusal envelope, or `null` when the fact is acceptable.
 */
function refuseUnstorableFact(
  metadata: z.infer<typeof repoFactMetadata>,
): ReturnType<typeof errorResult> | null {
  if (looksLikeRawCodeDump(metadata.fact)) {
    return errorResult(
      "Rejected repo fact: fact appears to contain a raw code chunk",
    );
  }
  if (containsSecretLikeValue(metadata.fact)) {
    return errorResult(
      "Rejected repo fact: fact appears to contain credential-like material",
    );
  }
  return null;
}

/** Write one repo fact, upserting on the active (namespace, type, name) key. */
async function handleUpsertRepoFact(
  dependencies: MemoryToolDependencies,
  args: UpsertRepoFactArgs,
  identity: ReturnType<typeof authIdentity>,
): Promise<ReturnType<typeof textResult>> {
  if (!identity || !canWrite(identity.role, "sessions")) {
    return errorResult("Permission denied: cannot write repo facts");
  }
  const namespace = args.namespace ?? identity.clientId;
  if (!canTargetNamespace(identity, "write", namespace)) {
    return errorResult("Permission denied: namespace write denied");
  }

  const metadata = repoFactMetadata.parse(args.metadata);
  const refusal = refuseUnstorableFact(metadata);
  if (refusal) return refusal;

  const factCanonicalId = canonicalId(metadata);
  const storedMetadata = {
    ...metadata,
    fact_id: factCanonicalId,
    promoted_as: "repo_fact",
  };

  const embedding = await embedRepoFact(
    dependencies,
    metadata,
    factCanonicalId,
  );

  const { rows } = await dependencies.pool.query(
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
     RETURNING id, (xmax = 0) AS is_new, entity_type, name, canonical_id,
               namespace, metadata, created_at, updated_at`,
    [
      entityName(metadata),
      factCanonicalId,
      namespace,
      JSON.stringify(storedMetadata),
      embedding ? toSql(embedding) : null,
      identity.clientId,
    ],
  );

  dependencies.logger.info(
    { tool: "upsert_repo_fact", canonicalId: factCanonicalId },
    "tool_result",
  );
  return textResult(rows[0]);
}

/**
 * Build the parameterized filter set for one fact query.
 *
 * Column names come from a closed literal list in this module, never from the
 * caller, so the only interpolated text is our own; every caller-supplied value
 * is bound as a parameter.
 */
function repoFactFilters(
  args: ListRepoFactsArgs,
  scope: string | readonly string[] | undefined,
): { filters: string[]; values: unknown[] } {
  const values: unknown[] = [];
  const filters = ["entity_type = 'repo_fact'", "archived_at IS NULL"];
  if (typeof scope === "string") {
    values.push(scope);
    filters.push(`namespace = $${values.length}`);
  } else if (Array.isArray(scope)) {
    values.push(scope);
    filters.push(`namespace = ANY($${values.length}::text[])`);
  }
  for (const [column, value] of [
    ["repo", args.repo],
    ["collection", args.collection],
    ["path", args.path],
    ["fact_type", args.fact_type],
  ] as const) {
    if (!value) continue;
    values.push(value);
    filters.push(`metadata->>'${column}' = $${values.length}`);
  }
  if (args.subject) {
    values.push(args.subject);
    filters.push(
      `(metadata->>'subject' = $${values.length} OR metadata->>'symbol' = $${values.length})`,
    );
  }
  return { filters, values };
}

/** List repo facts for the authorized read scope, with the legacy top-up. */
async function handleListRepoFacts(
  dependencies: MemoryToolDependencies,
  args: ListRepoFactsArgs,
  identity: ReturnType<typeof authIdentity>,
): Promise<ReturnType<typeof textResult>> {
  if (!identity || !canRead(identity.role, "sessions")) {
    return errorResult("Permission denied: cannot read repo facts");
  }
  if (args.namespace && !canTargetNamespace(identity, "read", args.namespace)) {
    return errorResult("Permission denied: namespace read access denied");
  }

  const rowCap = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const config = sharedNamespaceConfig();

  /** Run the fact query against one explicit namespace scope. */
  const queryRows = async (
    scope: string | readonly string[] | undefined,
    queryOffset: number,
  ): Promise<Array<Record<string, unknown>>> => {
    const { filters, values } = repoFactFilters(args, scope);
    values.push(rowCap, queryOffset);
    const { rows } = await dependencies.pool.query(
      `SELECT ${REPO_FACT_COLUMNS}
         FROM ob_entities
        WHERE ${filters.join(" AND ")}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return rows as Array<Record<string, unknown>>;
  };

  // Scope comes from the request when one was named and authorized, and
  // otherwise from the auth-derived read predicate.
  const predicate = namespacePredicate(identity, "read", 1);
  const scope: string | readonly string[] | undefined = args.namespace
    ? args.namespace
    : ((predicate.values[0] as readonly string[] | undefined) ?? undefined);

  const rows = await readWithLegacyFallback({
    scope,
    offset,
    rowCap,
    config,
    queryRows,
  });
  dependencies.logger.info(
    { tool: "list_repo_facts", returned: rows.length },
    "tool_result",
  );
  return textResult(canonicalizeRepoFactRows(rows));
}

/**
 * Read facts, topping up from the legacy shared namespace when needed.
 *
 * Facts written before the canonical rename still live under the legacy name,
 * so a shared-namespace read that comes back thin is completed from there. The
 * fallback is READ-ONLY and only ever applies to the first page: paging across
 * two merged sources would repeat and skip rows, since the merge reorders them.
 */
async function readWithLegacyFallback(input: {
  scope: string | readonly string[] | undefined;
  offset: number;
  rowCap: number;
  config: ReturnType<typeof sharedNamespaceConfig>;
  queryRows: (
    scope: string | readonly string[] | undefined,
    offset: number,
  ) => Promise<Array<Record<string, unknown>>>;
}): Promise<Array<Record<string, unknown>>> {
  const { scope, offset, rowCap, config, queryRows } = input;
  const fallbackAvailable =
    config.legacyFallbackEnabled &&
    config.legacySharedNamespace !== "" &&
    offset === 0;

  if (!fallbackAvailable) return queryRows(scope, offset);

  const touchesShared =
    typeof scope === "string"
      ? isSharedNamespace(scope)
      : Array.isArray(scope) && scope.includes(config.physicalSharedNamespace);
  if (!touchesShared) return queryRows(scope, offset);

  const primary = await queryRows(scope, 0);
  // Measure how much shared truth actually exists before topping up: a caller
  // whose own lane is busy can still have an empty shared namespace.
  const sharedRows =
    typeof scope === "string"
      ? primary
      : await queryRows(config.physicalSharedNamespace, 0);
  if (
    sharedRows.length >= rowCap ||
    sharedRows.length >= config.fallbackMinResults
  ) {
    return primary;
  }
  const legacyRows = await queryRows(config.legacySharedNamespace, 0);
  return mergeRepoFactFallbackRows(primary, legacyRows, rowCap);
}
