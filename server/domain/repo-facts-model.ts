// Repo-fact vocabulary, the caller-facing metadata schema and its published
// contract, and the pure helpers that derive identity and screen fact text.
// Split out of repo-facts.ts so each part stays under the server/ file rule
// (issue 864).

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  isTrustedSourceUrl,
  sourceUrlMatchesSource,
} from "./repo-facts-source-urls.ts";
import { canonicalNamespace } from "../../src/shared-namespace.ts";

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

export type RepoFactMetadata = z.infer<typeof repoFactMetadata>;

export const REPO_FACT_METADATA_CONTRACT = {
  source_system: {
    type: "literal",
    value: "qmd",
    required: true,
    description:
      'Provenance marker; must be the literal "qmd". Repo facts are only ' +
      "accepted from the qmd derivation pipeline.",
  },
  repo: {
    type: "string",
    required: true,
    maxLength: 300,
    description:
      "Repository slug this fact is about (e.g. owner/repo). Must match the " +
      "repo segment of source_url.",
  },
  collection: {
    type: "string",
    required: true,
    maxLength: 300,
    description:
      "qmd collection the fact was derived from. Groups facts by their " +
      "source index.",
  },
  path: {
    type: "string",
    required: true,
    maxLength: 1000,
    description:
      "Repo-relative file path the fact concerns. Must exactly match the " +
      "path encoded in source_url (suffix matches are rejected).",
  },
  symbol: {
    type: "string",
    required: "symbol_or_subject",
    maxLength: 300,
    description:
      "The code symbol (function/class/const) the fact is about. Provide " +
      "either symbol OR subject — use symbol when the fact targets a specific " +
      "named identifier.",
  },
  subject: {
    type: "string",
    required: "symbol_or_subject",
    maxLength: 500,
    description:
      "Human-readable subject when the fact is not about one named symbol. " +
      "Provide either subject OR symbol — use subject for file- or " +
      "concept-level facts.",
  },
  fact_type: {
    type: "enum",
    required: true,
    values: FACT_TYPES,
    description:
      "Category of fact, used for filtering on read. Pick the value that best " +
      "classifies what this fact asserts.",
  },
  fact: {
    type: "string",
    required: true,
    maxLength: 2000,
    description:
      "The fact itself, as prose (max ~6 lines). State the durable truth " +
      "plainly. Do NOT paste raw code chunks or any credential-like material — " +
      "those are rejected.",
  },
  source_commit: {
    type: "git_sha",
    required: true,
    description:
      "Git SHA the fact was verified against. Must appear as a path segment " +
      "in source_url so the citation is pinned to an exact commit.",
  },
  source_url: {
    type: "https_github_url",
    required: true,
    description:
      "HTTPS GitHub URL (github.com or raw.githubusercontent.com) proving the " +
      "fact, pinned to source_commit and the exact path. No credentials or " +
      "private hosts; the repo/commit/path must match the other fields.",
  },
  verified_at: {
    type: "datetime_not_future",
    required: true,
    description:
      "ISO timestamp when the fact was verified against source_commit. Must " +
      "not be in the future; drives staleness evaluation.",
  },
  confidence: {
    type: "number",
    min: 0,
    max: 1,
    default: 1,
    description:
      "How confident you are in the fact, 0-1 (default 1). Lower it for " +
      "inferred or uncertain facts so consumers can weight accordingly.",
  },
  staleness_policy: {
    type: "enum",
    required: true,
    values: STALENESS_POLICIES,
    description:
      "How this fact should be treated as the repo evolves — controls when it " +
      "is considered out of date and in need of re-verification.",
  },
  refresh_hint: {
    type: "string",
    required: false,
    maxLength: 1000,
    description:
      "Optional note on how/when to re-verify this fact (e.g. what to re-run " +
      "or watch). Helps a future agent refresh it efficiently.",
  },
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

export function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 180);
}

export function factSubject(metadata: RepoFactMetadata): string {
  return metadata.symbol ?? metadata.subject ?? metadata.path;
}

export function canonicalId(metadata: RepoFactMetadata): string {
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

export function entityName(metadata: RepoFactMetadata): string {
  return `${metadata.repo}:${metadata.path}:${factSubject(metadata)}:${metadata.fact_type}`;
}

export function looksLikeRawCodeDump(fact: string): boolean {
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

export function containsSecretLikeValue(fact: string): boolean {
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

export function namespaceClause(
  namespace: string | string[] | undefined,
  params: unknown[],
): string {
  if (namespace === undefined) return "";
  params.push(namespace);
  return Array.isArray(namespace)
    ? ` AND namespace = ANY($${params.length}::text[])`
    : ` AND namespace = $${params.length}`;
}

export function canonicalizeRepoFactRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    ...row,
    namespace:
      typeof row.namespace === "string"
        ? canonicalNamespace(row.namespace)
        : row.namespace,
  }));
}

// The identity a row carries in its own metadata: repo, path, subject (or the
// symbol standing in for it), and fact type. Undefined when the row carries
// none of the four, so the caller falls through to the row id rather than
// treating an all-empty key as a match.
function metadataDedupeKey(row: Record<string, unknown>): string | undefined {
  const metadata =
    row.metadata && typeof row.metadata === "object"
      ? (row.metadata as Record<string, unknown>)
      : {};
  const subject = metadata.subject ?? metadata.symbol ?? "";
  const key = `${metadata.repo ?? ""}:${metadata.path ?? ""}:${subject}:${metadata.fact_type ?? ""}`;
  return key === ":::" ? undefined : key;
}

export function repoFactDedupeKey(row: Record<string, unknown>) {
  return (
    row.canonical_id ??
    (row.name ? `${row.entity_type}:${row.name}` : undefined) ??
    metadataDedupeKey(row) ??
    row.id
  );
}

export function dedupeRepoFactRows(rows: Record<string, unknown>[]) {
  const seen = new Set<unknown>();
  const deduped: Record<string, unknown>[] = [];
  for (const row of rows) {
    const key = repoFactDedupeKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

export function mergeRepoFactFallbackRows(
  primaryRows: Record<string, unknown>[],
  legacyRows: Record<string, unknown>[],
  limit: number,
) {
  const primary = dedupeRepoFactRows(primaryRows);
  const primaryKeys = new Set(primary.map(repoFactDedupeKey));
  const legacy = dedupeRepoFactRows(
    legacyRows.filter((row) => !primaryKeys.has(repoFactDedupeKey(row))),
  );
  if (legacy.length === 0) return primary.slice(0, limit);
  if (primary.length >= limit) {
    const fallbackRow = legacy[0];
    if (!fallbackRow) return primary.slice(0, limit);
    return [...primary.slice(0, Math.max(0, limit - 1)), fallbackRow];
  }
  return [...primary, ...legacy.slice(0, limit - primary.length)];
}
