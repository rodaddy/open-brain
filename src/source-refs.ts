import { z } from "zod";
import type { AuthInfo } from "./types.ts";

const isoDateTime = z.string().datetime();

export const sourceRefSchema = z
  .object({
    source_type: z.enum(["file", "document", "dms", "url"]).default("file"),
    document_id: z.string().trim().min(1).max(500).optional(),
    path: z.string().trim().min(1).max(1000).optional(),
    dms_id: z.string().trim().min(1).max(500).optional(),
    title: z.string().trim().min(1).max(500).optional(),
    client_id: z.string().trim().min(1).max(300).optional(),
    matter_id: z.string().trim().min(1).max(300).optional(),
    tenant_id: z.string().trim().min(1).max(300).optional(),
    access_group: z.string().trim().min(1).max(300).optional(),
    role_policy: z.string().trim().min(1).max(300).optional(),
    ethical_wall: z.boolean().optional(),
    retention_policy: z.string().trim().min(1).max(300).optional(),
    legal_hold: z.boolean().optional(),
    page: z.number().int().min(1).optional(),
    paragraph: z.string().trim().min(1).max(100).optional(),
    section: z.string().trim().min(1).max(300).optional(),
    text_span: z
      .object({
        start: z.number().int().min(0),
        end: z.number().int().min(0),
      })
      .refine((value) => value.end >= value.start, {
        message: "text_span.end must be greater than or equal to start",
      })
      .optional(),
    source_hash: z.string().trim().min(1).max(200).optional(),
    ingested_at: isoDateTime.optional(),
    excerpt_bounds: z
      .object({
        start: z.number().int().min(0),
        end: z.number().int().min(0),
      })
      .refine((value) => value.end >= value.start, {
        message: "excerpt_bounds.end must be greater than or equal to start",
      })
      .optional(),
  })
  .refine((value) => Boolean(value.document_id ?? value.path ?? value.dms_id), {
    message: "source_refs require document_id, path, or dms_id",
    path: ["document_id"],
  });

export const sourceRefsSchema = z.array(sourceRefSchema).max(25);

export type SourceReference = z.infer<typeof sourceRefSchema>;

export const sourceScopeSchema = z
  .object({
    client_id: z.string().trim().min(1).max(300).optional(),
    matter_id: z.string().trim().min(1).max(300).optional(),
    document_id: z.string().trim().min(1).max(500).optional(),
    path: z.string().trim().min(1).max(1000).optional(),
    dms_id: z.string().trim().min(1).max(500).optional(),
  })
  .refine(
    (value) =>
      Boolean(
        value.client_id ??
          value.matter_id ??
          value.document_id ??
          value.path ??
          value.dms_id,
      ),
    {
      message:
        "source_scope requires client_id, matter_id, document_id, path, or dms_id",
      path: ["client_id"],
    },
  );

export type SourceScope = z.infer<typeof sourceScopeSchema>;

export function sourceScopeAuthorizationError(
  auth: AuthInfo,
  sourceScope?: SourceScope,
): string | undefined {
  if (!sourceScope) return undefined;
  if (auth.role !== "admin" && auth.role !== "ob-admin") {
    return "Permission denied: source_scope requires token-sourced admin or ob-admin";
  }
  if (auth.namespaceSource === "header") {
    return "Permission denied: delegated namespace sessions cannot use source_scope";
  }
  return undefined;
}

export function appendSourceScopeParam(
  params: unknown[],
  sourceScope?: SourceScope,
): number | undefined {
  if (!sourceScope) return undefined;
  params.push(JSON.stringify(sourceScope));
  return params.length;
}

export function sourceScopeFilterSql(
  alias: string,
  sourceScopeParamIndex?: number,
): string {
  if (!sourceScopeParamIndex) return "";
  const scopeRef = `$${sourceScopeParamIndex}`;
  return `
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(${alias}.source_refs, '[]'::jsonb)) AS source_ref(ref)
      WHERE (NOT (${scopeRef}::jsonb ? 'client_id') OR source_ref.ref->>'client_id' = ${scopeRef}::jsonb->>'client_id')
        AND (NOT (${scopeRef}::jsonb ? 'matter_id') OR source_ref.ref->>'matter_id' = ${scopeRef}::jsonb->>'matter_id')
        AND (NOT (${scopeRef}::jsonb ? 'document_id') OR source_ref.ref->>'document_id' = ${scopeRef}::jsonb->>'document_id')
        AND (NOT (${scopeRef}::jsonb ? 'path') OR source_ref.ref->>'path' = ${scopeRef}::jsonb->>'path')
        AND (NOT (${scopeRef}::jsonb ? 'dms_id') OR source_ref.ref->>'dms_id' = ${scopeRef}::jsonb->>'dms_id')
    )`;
}

export function sourceRefMatchesScope(
  ref: SourceReference,
  sourceScope: SourceScope,
): boolean {
  return (
    (sourceScope.client_id === undefined ||
      ref.client_id === sourceScope.client_id) &&
    (sourceScope.matter_id === undefined ||
      ref.matter_id === sourceScope.matter_id) &&
    (sourceScope.document_id === undefined ||
      ref.document_id === sourceScope.document_id) &&
    (sourceScope.path === undefined || ref.path === sourceScope.path) &&
    (sourceScope.dms_id === undefined || ref.dms_id === sourceScope.dms_id)
  );
}

export function filterSourceRefsForScope(
  sourceRefs: unknown,
  sourceScope: SourceScope,
): SourceReference[] {
  const parsed = sourceRefsSchema.safeParse(sourceRefs);
  if (!parsed.success) return [];
  return parsed.data.filter((ref) => sourceRefMatchesScope(ref, sourceScope));
}

export const SOURCE_REFS_CONTRACT = {
  type: "array",
  required: false,
  maxItems: 25,
  description:
    "Structured file/document provenance for closed-brain deployments. " +
    "Each ref must identify a document via document_id, path, or dms_id, " +
    "and may include client_id, matter_id, page/section/span locators, " +
    "source_hash, ingestion timestamp, and privilege/isolation metadata.",
} as const;

export const SOURCE_SCOPE_CONTRACT = {
  type: "object",
  required: false,
  fields: {
    client_id: { type: "string", required: false, minLength: 1, maxLength: 300 },
    matter_id: { type: "string", required: false, minLength: 1, maxLength: 300 },
    document_id: { type: "string", required: false, minLength: 1, maxLength: 500 },
    path: { type: "string", required: false, minLength: 1, maxLength: 1000 },
    dms_id: { type: "string", required: false, minLength: 1, maxLength: 500 },
  },
  description:
    "Optional source-reference scope for closed-brain deployments. When set, " +
    "all supplied keys must match the same source_refs array element before " +
    "source-scoped evidence or source_refs are returned. Until auth-bound " +
    "source claims exist, source_scope is restricted to token-sourced admin " +
    "or ob-admin callers.",
} as const;
