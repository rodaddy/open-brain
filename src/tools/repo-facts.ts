import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canRead, canWrite } from "../permissions.ts";
import { canWriteNamespace } from "../namespace-policy.ts";
import { canReadNamespace, namespaceFilterFor } from "../read-policy.ts";
import {
  canonicalNamespace,
  isSharedNamespace,
  sharedNamespaceConfig,
} from "../shared-namespace.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

export const FACT_TYPES = [
  "ownership",
  "gotcha",
  "api_contract",
  "workflow",
  "dependency",
  "migration",
  "validation",
  "source_pointer",
] as const;

export const STALENESS_POLICIES = [
  "stable_fact_verify_source",
  "commit_pinned",
  "refresh_required",
  "volatile_pointer_only",
] as const;

const sourceCommit = z
  .string()
  .regex(/^[0-9a-fA-F]{7,64}$/, "source_commit must be a git SHA");

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.startsWith("127.") || host === "::1") return true;
  if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    const first = parts[0] ?? -1;
    const second = parts[1] ?? -1;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 169 && second === 254) return true;
  }
  return false;
}

function isTrustedSourceUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    if (isPrivateOrLocalHost(parsed.hostname)) return false;
    return ["github.com", "raw.githubusercontent.com"].includes(
      parsed.hostname.toLowerCase(),
    );
  } catch {
    return false;
  }
}

function sourceUrlMatchesSource(
  rawUrl: string,
  repo: string,
  path: string,
  commit: string,
): boolean {
  try {
    const parsed = new URL(rawUrl);
    const decodedPath = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    const normalizedPath = path.replace(/^\/+/, "");
    const repoSlug = repo.replace(/^\/+|\/+$/g, "").split("/").at(-1) ?? repo;
    const pathParts = normalizedPath.split("/");
    const repoRelativePath =
      pathParts[0] === repoSlug && pathParts.length > 1
        ? pathParts.slice(1).join("/")
        : normalizedPath;

    if (parsed.hostname.toLowerCase() === "github.com") {
      const [owner, urlRepo, blob, urlCommit, ...sourceParts] =
        decodedPath.split("/");
      void owner;
      return (
        urlRepo === repoSlug &&
        blob === "blob" &&
        urlCommit === commit &&
        sourceParts.join("/") === repoRelativePath
      );
    }

    if (parsed.hostname.toLowerCase() === "raw.githubusercontent.com") {
      const [owner, urlRepo, urlCommit, ...sourceParts] = decodedPath.split("/");
      void owner;
      return (
        urlRepo === repoSlug &&
        urlCommit === commit &&
        sourceParts.join("/") === repoRelativePath
      );
    }

    return false;
  } catch {
    return false;
  }
}

const sourceUrl = z
  .string()
  .url()
  .refine(isTrustedSourceUrl, {
    message: "source_url must be an HTTPS GitHub source URL without credentials",
  })
  .describe("HTTPS GitHub source URL for the verified source pointer.");

export const repoFactMetadata = z
  .object({
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
    verified_at: z
      .string()
      .datetime()
      .refine((value) => Date.parse(value) <= Date.now(), {
        message: "verified_at cannot be in the future",
      }),
    confidence: z.number().min(0).max(1).default(1),
    staleness_policy: z.enum(STALENESS_POLICIES),
    refresh_hint: z.string().trim().min(1).max(1000).optional(),
  })
  .refine((value) => Boolean(value.symbol ?? value.subject), {
    message: "repo facts require symbol or subject",
    path: ["subject"],
  })
  .refine(
    (value) =>
      sourceUrlMatchesSource(
        value.source_url,
        value.repo,
        value.path,
        value.source_commit,
      ),
    {
      message: "source_url must include source_commit and source path",
      path: ["source_url"],
    },
  );

type RepoFactMetadata = z.infer<typeof repoFactMetadata>;

export const REPO_FACT_METADATA_CONTRACT = {
  source_system: { type: "literal", value: "qmd", required: true },
  repo: { type: "string", required: true, maxLength: 300 },
  collection: { type: "string", required: true, maxLength: 300 },
  path: { type: "string", required: true, maxLength: 1000 },
  symbol: { type: "string", required: "symbol_or_subject", maxLength: 300 },
  subject: { type: "string", required: "symbol_or_subject", maxLength: 500 },
  fact_type: { type: "enum", required: true, values: FACT_TYPES },
  fact: { type: "string", required: true, maxLength: 2000 },
  source_commit: { type: "git_sha", required: true },
  source_url: { type: "https_github_url", required: true },
  verified_at: { type: "datetime_not_future", required: true },
  confidence: { type: "number", min: 0, max: 1, default: 1 },
  staleness_policy: {
    type: "enum",
    required: true,
    values: STALENESS_POLICIES,
  },
  refresh_hint: { type: "string", required: false, maxLength: 1000 },
} as const;

export const REPO_FACT_VALIDATION_CONTRACT = {
  source_url: {
    allowed_hosts: ["github.com", "raw.githubusercontent.com"],
    protocol: "https",
    credentials_allowed: false,
    local_private_hosts_allowed: false,
    github_url_shapes: [
      "/<owner>/<repo>/blob/<source_commit>/<repo_relative_path>",
      "/<owner>/<repo>/<source_commit>/<repo_relative_path>",
    ],
    repo_match: "url repo segment must match metadata.repo slug",
    commit_match: "source_commit must be a path segment, not query or fragment",
    path_match: "exact repo-relative path match; suffix matches are rejected",
  },
  fact_body: {
    raw_code_chunks_allowed: false,
    credential_like_material_allowed: false,
    max_lines: 6,
    rejected_secret_shapes: [
      "labelled token/password/secret/api_key/authorization values",
      "AWS access key IDs",
      "AWS secret-access-key-like 40 character base64 values",
      "Slack xox tokens",
      "Google API keys",
      "JWT-like strings",
    ],
  },
} as const;

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
  const tuple = [
    metadata.source_system,
    metadata.repo,
    metadata.collection,
    metadata.path,
    factSubject(metadata),
    metadata.fact_type,
  ].join("\0");
  const digest = createHash("sha256").update(tuple).digest("hex").slice(0, 16);
  return [
    "repo_fact",
    metadata.source_system,
    slugPart(metadata.repo),
    slugPart(metadata.collection),
    slugPart(metadata.path),
    slugPart(factSubject(metadata)),
    metadata.fact_type,
    digest,
  ].join(":");
}

function entityName(metadata: RepoFactMetadata): string {
  return `${metadata.repo}:${metadata.path}:${factSubject(metadata)}:${metadata.fact_type}`;
}

function looksLikeRawCodeDump(fact: string): boolean {
  const lines = fact.split(/\r?\n/);
  if (lines.length > 6) return true;

  const codeSignals = [
    /^\s*(export\s+)?(async\s+)?function\s+\w+/m,
    /^\s*(export\s+)?(interface|type|class|enum)\s+\w+/m,
    /^\s*(const|let|var)\s+\w+\s*=/m,
    /^\s*(from\s+\S+\s+)?import\s+/m,
    /^\s*def\s+\w+\s*\(/m,
    /^\s*class\s+\w+[:(]/m,
    /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER)\s+/im,
    /^\s*#!\/(?:usr\/bin\/env\s+)?(?:ba|z|fi)?sh/m,
    /^\s*[a-zA-Z_][\w-]*:\s*[{["]/m,
    /```/,
    /=>\s*[{(]/,
    /\b(return|await|try|catch|finally)\b/,
    /;\s*$/m,
    /\{\s*$/m,
  ];

  return codeSignals.filter((re) => re.test(fact)).length >= 1;
}

function containsSecretLikeValue(fact: string): boolean {
  const secretSignals = [
    /\b(?:token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]\s*\S{8,}/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /(^|[^A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}($|[^A-Za-z0-9/+=])/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\bAIza[0-9A-Za-z_-]{20,}\b/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  ];
  return secretSignals.some((re) => re.test(fact));
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

function canonicalizeRepoFactRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    ...row,
    namespace:
      typeof row.namespace === "string"
        ? canonicalNamespace(row.namespace)
        : row.namespace,
  }));
}

function dedupeRepoFactRows(rows: Record<string, unknown>[]) {
  const seen = new Set<unknown>();
  const deduped: Record<string, unknown>[] = [];
  for (const row of rows) {
    const metadata =
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {};
    const metadataKey = `${metadata.repo ?? ""}:${metadata.path ?? ""}:${metadata.subject ?? metadata.symbol ?? ""}:${metadata.fact_type ?? ""}`;
    const key =
      row.canonical_id ??
      (row.name ? `${row.entity_type}:${row.name}` : undefined) ??
      (metadataKey === ":::" ? undefined : metadataKey) ??
      row.id;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
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
      if (containsSecretLikeValue(metadata.fact)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Rejected repo fact: fact appears to contain credential-like material",
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

      const namespace = namespaceFilterFor(auth, requestedNamespace);
      const limit = args.limit ?? 50;
      const offset = args.offset ?? 0;
      const queryRows = async (
        queryNamespace: string | string[] | undefined,
        queryLimit: number,
        queryOffset: number,
      ) => {
        const params: unknown[] = [];
        const filters = ["entity_type = 'repo_fact'", "archived_at IS NULL"];
        const ns = namespaceClause(queryNamespace, params);
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

      let rows: Record<string, unknown>[];
      const config = sharedNamespaceConfig();
      if (
        typeof namespace === "string" &&
        isSharedNamespace(namespace) &&
        config.legacyFallbackEnabled &&
        offset === 0
      ) {
        const sharedRows = await queryRows(config.sharedNamespace, limit, 0);
        if (
          sharedRows.length >= limit ||
          sharedRows.length >= config.fallbackMinResults
        ) {
          rows = sharedRows;
        } else {
          const legacyRows = await queryRows(
            config.legacySharedNamespace,
            limit - sharedRows.length,
            0,
          );
          rows = dedupeRepoFactRows([...sharedRows, ...legacyRows]);
        }
      } else if (
        Array.isArray(namespace) &&
        namespace.includes(config.physicalSharedNamespace) &&
        config.legacyFallbackEnabled &&
        offset === 0
      ) {
        const [primaryRows, sharedRows] = await Promise.all([
          queryRows(namespace, limit, 0),
          queryRows(config.physicalSharedNamespace, limit, 0),
        ]);
        if (
          sharedRows.length >= limit ||
          sharedRows.length >= config.fallbackMinResults
        ) {
          rows = primaryRows;
        } else {
          const legacyRows = await queryRows(
            config.legacySharedNamespace,
            limit,
            0,
          );
          rows = dedupeRepoFactRows([...primaryRows, ...legacyRows]);
        }
      } else {
        rows = await queryRows(namespace, limit, offset);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(canonicalizeRepoFactRows(rows)),
          },
        ],
      };
    },
  );
}
