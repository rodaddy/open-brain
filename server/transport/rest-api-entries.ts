/**
 * REST write routes for thoughts and decisions (split of the REST router in
 * the L5 move, issue 864). Route paths, status codes, response shapes, error strings
 * and zod schemas are unchanged from the pre-split router.
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { toSql } from "pgvector/pg";
import { canWrite } from "../auth/permissions.ts";
import { normalizedContentHash, embeddingModel } from "../embedding/provider.ts";
import { decisionCanonicalText } from "../embedding/embedding-canonical.ts";
import { backgroundExtract } from "../domain/extraction.ts";
import { writeThoughtChunks, chunkReceiptFields } from "../capture/chunk-write.ts";
import { createChunkRepository } from "../db/chunk-repository.ts";
import { createEntryReadRepository } from "../db/entry-read-repository.ts";
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
  const chunks = await writeThoughtChunks(createChunkRepository(ctx.deps.pool), {
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
    backgroundExtract(ctx.deps.pool, "thoughts", {
      entryId: ctx.entryId,
      namespace: ctx.ns,
      text: ctx.content,
      existingTags: ctx.tags,
    });
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

  const hash = normalizedContentHash(content);
  const textToEmbed = tags?.length ? `${content}\n${tags.join(" ")}` : content;
  const embedding = await deps.embedFn(textToEmbed);

  const cols = embeddingColumns(embedding, toSql, embeddingModel());
  const repository = createEntryReadRepository(deps.pool);
  const rows = await repository.insertThought({
    params: [
      content,
      tags ?? [],
      auth.clientId,
      ns,
      cols.vector,
      hash,
      cols.embeddedAt,
      cols.model,
    ],
  });

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
  const hash = normalizedContentHash(textToEmbed);
  const embedding = await deps.embedFn(textToEmbed);

  const cols = embeddingColumns(embedding, toSql, embeddingModel());
  const repository = createEntryReadRepository(deps.pool);
  const rows = await repository.insertDecision({
    params: [
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
    ],
  });

  const entryId = rows[0].id as string;
  const isNew = rows[0].is_new as boolean;

  if (isNew) {
    backgroundExtract(deps.pool, "decisions", {
      entryId,
      namespace: ns,
      text: textToEmbed,
      existingTags: tags ?? [],
    });
  }

  res.status(isNew ? 201 : 200).json({
    id: entryId,
    namespace: ns,
    embedded: !!embedding,
    merged: !isNew,
  });
}
