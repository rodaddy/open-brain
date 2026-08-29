/**
 * REST write routes for thoughts and decisions (issue 864 split of
 * `src/rest-api.ts`). Route paths, status codes, response shapes, error strings
 * and zod schemas are unchanged from the pre-split router.
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { toSql } from "pgvector/pg";
import { canWrite } from "../security/permissions.ts";
import { contentHash, EMBEDDING_MODEL } from "../../src/embedding.ts";
import { decisionCanonicalText } from "../embedding/embedding-canonical.ts";
import { backgroundExtract } from "../../src/extraction.ts";
import { writeThoughtChunks, chunkReceiptFields } from "../capture/chunk-write.ts";
import {
  embeddingColumns,
  getAuth,
  namespaceSchema,
  parseBody,
  orNull,
  resolveWriteNamespace,
  stringArraySchema,
  type RestDeps,
} from "./rest-api-helpers.ts";

export const thoughtSchema = z.object({
  content: z.string().trim().min(1),
  tags: stringArraySchema.optional(),
  namespace: namespaceSchema.optional(),
});

export const decisionSchema = z.object({
  title: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  alternatives: stringArraySchema.optional(),
  tags: stringArraySchema.optional(),
  context: z.string().optional(),
  namespace: namespaceSchema.optional(),
});

const THOUGHT_INSERT_SQL = `INSERT INTO thoughts (content, tags, source, created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
       VALUES ($1, $2, 'rest', $3, $4, $5, $6, $7, $8)
       ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
       DO UPDATE SET
         tags = (
           SELECT COALESCE(array_agg(DISTINCT tag), '{}')
           FROM unnest(thoughts.tags || EXCLUDED.tags) AS tag
           WHERE tag IS NOT NULL
         ),
         updated_at = NOW()
       RETURNING id, (xmax = 0) AS is_new`;

const DECISION_INSERT_SQL = `INSERT INTO decisions (title, rationale, alternatives, tags, context, created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
       DO UPDATE SET
         tags = (
           SELECT COALESCE(array_agg(DISTINCT tag), '{}')
           FROM unnest(decisions.tags || EXCLUDED.tags) AS tag
           WHERE tag IS NOT NULL
         ),
         updated_at = NOW()
       RETURNING id, (xmax = 0) AS is_new`;

interface ThoughtRowContext {
  deps: RestDeps;
  entryId: string;
  isNew: boolean;
  ns: string;
  clientId: string;
  content: string;
  tags: string[];
}

/**
 * CHUNK ROWS FOR A LONG ENTRY (#605). A thought created over REST is the same
 * object as one created over MCP and must be stored the same way: complete
 * parent plus per-section rows. Extraction follows for a genuinely new row.
 */
async function writeThoughtBody(ctx: ThoughtRowContext) {
  const chunks = await writeThoughtChunks(ctx.deps.pool, {
    parentId: ctx.entryId,
    namespace: ctx.ns,
    createdBy: ctx.clientId,
    content: ctx.content,
    tags: ctx.tags,
    embedFn: ctx.deps.embedFn,
    source: "rest-chunk",
    isNew: ctx.isNew,
    caller: "rest/POST /thoughts",
  });

  if (ctx.isNew) {
    backgroundExtract(
      ctx.deps.pool,
      "thoughts",
      ctx.entryId,
      ctx.ns,
      ctx.content,
      ctx.tags,
    );
  }

  return chunks;
}

export async function postThought(
  deps: RestDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const auth = getAuth(req);
  if (!auth || !canWrite(auth.role, "thoughts")) {
    res.status(403).json({ error: "Permission denied" });
    return;
  }

  const parsed = parseBody(thoughtSchema, req.body, res);
  if (!parsed) return;
  const { content, tags, namespace } = parsed;

  const ns = resolveWriteNamespace(auth, namespace, res);
  if (ns === null) return;

  const hash = contentHash(content);
  const textToEmbed = tags?.length ? `${content}\n${tags.join(" ")}` : content;
  const embedding = await deps.embedFn(textToEmbed);

  const cols = embeddingColumns(embedding, toSql, EMBEDDING_MODEL);
  const { rows } = await deps.pool.query(THOUGHT_INSERT_SQL, [
    content,
    tags ?? [],
    auth.clientId,
    ns,
    cols.vector,
    hash,
    cols.embeddedAt,
    cols.model,
  ]);

  const entryId = rows[0].id as string;
  const isNew = rows[0].is_new as boolean;

  const chunks = await writeThoughtBody({
    deps,
    entryId,
    isNew,
    ns,
    clientId: auth.clientId,
    content,
    tags: tags ?? [],
  });

  res.status(isNew ? 201 : 200).json({
    id: entryId,
    namespace: ns,
    embedded: !!embedding,
    merged: !isNew,
    ...chunkReceiptFields(chunks),
  });
}

export async function postDecision(
  deps: RestDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const auth = getAuth(req);
  if (!auth || !canWrite(auth.role, "decisions")) {
    res.status(403).json({ error: "Permission denied" });
    return;
  }

  const parsed = parseBody(decisionSchema, req.body, res);
  if (!parsed) return;
  const { title, rationale, alternatives, tags, context, namespace } = parsed;

  const ns = resolveWriteNamespace(auth, namespace, res);
  if (ns === null) return;

  // Canonical decision text -- shared with the repair registry via
  // decisionCanonicalText() so repair never disagrees with this writer.
  const textToEmbed = decisionCanonicalText({
    title,
    rationale,
    context,
    alternatives,
    tags,
  });
  const hash = contentHash(textToEmbed);
  const embedding = await deps.embedFn(textToEmbed);

  const cols = embeddingColumns(embedding, toSql, EMBEDDING_MODEL);
  const { rows } = await deps.pool.query(DECISION_INSERT_SQL, [
    title,
    rationale,
    JSON.stringify(alternatives ?? []),
    tags ?? [],
    orNull(context),
    auth.clientId,
    ns,
    cols.vector,
    hash,
    cols.embeddedAt,
    cols.model,
  ]);

  const entryId = rows[0].id as string;
  const isNew = rows[0].is_new as boolean;

  if (isNew) {
    backgroundExtract(deps.pool, "decisions", entryId, ns, textToEmbed, tags ?? []);
  }

  res.status(isNew ? 201 : 200).json({
    id: entryId,
    namespace: ns,
    embedded: !!embedding,
    merged: !isNew,
  });
}
