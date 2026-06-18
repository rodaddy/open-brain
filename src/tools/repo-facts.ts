import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canRead, canWrite } from "../permissions.ts";
import { canWriteNamespace } from "../namespace-policy.ts";
import { canReadNamespace, namespaceFilterFor } from "../read-policy.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

const FACT_TYPES = [
  "ownership",
  "gotcha",
  "api_contract",
  "workflow",
  "dependency",
  "migration",
  "validation",
  "source_pointer",
] as const;

const STALENESS_POLICIES = [
  "stable_fact_verify_source",
  "commit_pinned",
  "refresh_required",
  "volatile_pointer_only",
] as const;

const sourceCommit = z
  .string()
  .regex(/^[0-9a-fA-F]{7,64}$/, "source_commit must be a git SHA");

const sourceUrl = z
  .string()
  .url()
  .optional()
  .describe("Optional source URL, usually a GitHub file URL.");

const repoFactMetadata = z.object({
  source_system: z.literal("qmd").describe("Fact source system."),
  repo: z.string().trim().min(1).max(300),
  collection: z.string().trim().min(1).max(300),
  path: z.string().trim().min(1).max(1000),
  symbol: z.string().trim().min(1).max(300).optional(),
  subject: z.string().trim().min(1).max(500).optional(),
  fact_type: z.enum(FACT_TYPES),
  fact: z.string().trim().min(1).max(2000),
  source_commit: sourceCommit,
  source_url: sourceUrl,
  verified_at: z.string().datetime(),
  confidence: z.number().min(0).max(1).default(1),
  staleness_policy: z.enum(STALENESS_POLICIES),
  refresh_hint: z.string().trim().min(1).max(1000).optional(),
});

type RepoFactMetadata = z.infer<typeof repoFactMetadata>;

function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 180);
}

function factSubject(metadata: RepoFactMetadata): string {
  return metadata.symbol ?? metadata.subject ?? metadata.path;
}

function canonicalId(metadata: RepoFactMetadata): string {
  return [
    "repo_fact",
    metadata.source_system,
    slugPart(metadata.repo),
    slugPart(metadata.collection),
    slugPart(metadata.path),
    slugPart(factSubject(metadata)),
    metadata.fact_type,
  ].join(":");
}

function entityName(metadata: RepoFactMetadata): string {
  return `${metadata.repo}:${metadata.path}:${factSubject(metadata)}:${metadata.fact_type}`;
}

function looksLikeRawCodeDump(fact: string): boolean {
  const lines = fact.split(/\r?\n/);
  if (lines.length > 8) return true;

  const codeSignals = [
    /^\s*(export\s+)?(async\s+)?function\s+\w+/m,
    /^\s*(export\s+)?(interface|type|class|enum)\s+\w+/m,
    /^\s*(const|let|var)\s+\w+\s*=/m,
    /```/,
    /;\s*$/m,
    /\{\s*$/m,
  ];

  return codeSignals.filter((re) => re.test(fact)).length >= 2;
}

function namespaceClause(
  namespace: string | string[] | undefined,
  params: unknown[],
): string {
  if (namespace === undefined) return "";
  params.push(namespace);
  return Array.isArray(namespace)
    ? ` AND namespace = ANY($${params.length}::text[])`
    : ` AND namespace = $${params.length}`;
}

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
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canWrite(auth.role, "sessions")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot write repo facts",
            },
          ],
          isError: true,
        };
      }

      const ns = args.namespace ?? auth.clientId;
      const nsCheck = canWriteNamespace(auth, ns);
      if (!nsCheck.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Permission denied: ${nsCheck.reason}`,
            },
          ],
          isError: true,
        };
      }

      const metadata = repoFactMetadata.parse(args.metadata);
      if (looksLikeRawCodeDump(metadata.fact)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Rejected repo fact: fact appears to contain a raw code chunk",
            },
          ],
          isError: true,
        };
      }

      const factCanonicalId = canonicalId(metadata);
      const name = entityName(metadata);
      const storedMetadata = {
        ...metadata,
        fact_id: factCanonicalId,
        promoted_as: "repo_fact",
      };

      let embedding: number[] | null = null;
      try {
        embedding = await deps.embedFn(
          `${metadata.repo} ${metadata.path} ${factSubject(metadata)} ${metadata.fact}`,
        );
      } catch (err) {
        logger.warn("upsert_repo_fact_embed_error", {
          canonical_id: factCanonicalId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

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
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(rows[0]),
          },
        ],
      };
    },
  );
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
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canRead(auth.role, "sessions")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot read repo facts",
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

      const params: unknown[] = [];
      const filters = ["entity_type = 'repo_fact'", "archived_at IS NULL"];
      const namespace = namespaceFilterFor(auth, requestedNamespace);
      const ns = namespaceClause(namespace, params);
      if (ns) filters.push(ns.slice(" AND ".length));
      if (args.repo) {
        params.push(args.repo);
        filters.push(`metadata->>'repo' = $${params.length}`);
      }
      if (args.collection) {
        params.push(args.collection);
        filters.push(`metadata->>'collection' = $${params.length}`);
      }
      if (args.path) {
        params.push(args.path);
        filters.push(`metadata->>'path' = $${params.length}`);
      }
      if (args.fact_type) {
        params.push(args.fact_type);
        filters.push(`metadata->>'fact_type' = $${params.length}`);
      }
      if (args.subject) {
        params.push(args.subject);
        filters.push(
          `(metadata->>'subject' = $${params.length} OR metadata->>'symbol' = $${params.length})`,
        );
      }

      const limit = args.limit ?? 50;
      const offset = args.offset ?? 0;
      params.push(limit, offset);

      const { rows } = await deps.pool.query(
        `SELECT id, entity_type, name, canonical_id, namespace, metadata, created_by, created_at, updated_at
         FROM ob_entities
         WHERE ${filters.join(" AND ")}
         ORDER BY updated_at DESC, created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows) }],
      };
    },
  );
}
