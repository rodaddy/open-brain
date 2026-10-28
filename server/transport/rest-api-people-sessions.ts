/**
 * REST write routes for persons and sessions (split of the REST router in
 * the L5 move, issue 864). Route paths, status codes, response shapes, error strings
 * and zod schemas are unchanged from the pre-split router.
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { toSql } from "pgvector/pg";
import { createPeopleRepository } from "../db/people-repository.ts";
import { canWrite } from "../auth/permissions.ts";
import { normalizedContentHash, embeddingModel } from "../embedding/provider.ts";
import {
  sessionEmbedText,
  sessionSourceHashInput,
} from "../embedding/embedding-canonical.ts";
import {
  embeddingColumns,
  type EmbeddingColumns,
  getAuth,
  jsonRecordSchema,
  namespaceSchema,
  orNull,
  parseBody,
  resolveWriteNamespace,
  stringArraySchema,
  type RestDeps,
} from "./rest-api-helpers.ts";

export const personSchema = z.object({
  name: z.string().trim().min(1),
  context: z.string().optional(),
  relationship_type: z.string().optional(),
  warmth: z.number().int().min(0).max(10).optional(),
  last_contact: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
  tags: stringArraySchema.optional(),
  metadata: jsonRecordSchema.optional(),
  namespace: namespaceSchema.optional(),
});

export const sessionSchema = z.object({
  summary: z.string().trim().min(1),
  project: z.string().optional(),
  session_id: z.string().trim().min(1).optional(),
  tags: stringArraySchema.optional(),
  blockers: stringArraySchema.optional(),
  next_steps: stringArraySchema.optional(),
  key_decisions: stringArraySchema.optional(),
  namespace: namespaceSchema.optional(),
});

interface PersonUpsertContext {
  deps: RestDeps;
  fields: z.infer<typeof personSchema>;
  ns: string;
  clientId: string;
  hash: string;
  cols: EmbeddingColumns;
}

/** The relationships upsert parameter list, kept out of the handler body. */
async function upsertPerson(ctx: PersonUpsertContext) {
  const { fields, cols } = ctx;
  const rows = await createPeopleRepository(ctx.deps.pool).upsertPersonFromRest({
    values: [
      fields.name,
      orNull(fields.context),
      orNull(fields.relationship_type),
      orNull(fields.warmth),
      orNull(fields.last_contact),
      orNull(fields.email),
      orNull(fields.phone),
      orNull(fields.notes),
      orNull(fields.tags),
      fields.metadata ? JSON.stringify(fields.metadata) : null,
      ctx.clientId,
      ctx.ns,
      cols.vector,
      ctx.hash,
      cols.embeddedAt,
      cols.model,
    ],
  });
  return rows[0];
}

export async function postPerson(
  deps: RestDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const auth = getAuth(req);
  if (!auth || !canWrite(auth.role, "relationships")) {
    res.status(403).json({ error: "Permission denied" });
    return;
  }

  const fields = parseBody(personSchema, req.body, res);
  if (!fields) return;
  const { name, context, notes } = fields;

  const ns = resolveWriteNamespace(auth, fields.namespace, res);
  if (ns === null) return;

  const embeddableText = [name, context ?? "", notes ?? ""].filter(Boolean).join("\n");
  const hash = normalizedContentHash(embeddableText);
  const embedding = await deps.embedFn(embeddableText);
  const cols = embeddingColumns(embedding, toSql, embeddingModel());

  const row = await upsertPerson({
    deps,
    fields,
    ns,
    clientId: auth.clientId,
    hash,
    cols,
  });
  const action = row.inserted ? "created" : "updated";

  res.status(row.inserted ? 201 : 200).json({
    id: row.id,
    person_name: name,
    namespace: ns,
    action,
    embedded: !!embedding,
  });
}

interface SessionEmbeddingValues {
  embedding: number[] | null;
  embeddingVal: string | null;
  embeddedAt: string | null;
  model: string | null;
  hash: string;
}

interface SessionWriteContext {
  deps: RestDeps;
  res: Response;
  fields: z.infer<typeof sessionSchema>;
  ns: string;
  clientId: string;
  values: SessionEmbeddingValues;
}

async function upsertKeyedSession(
  ctx: SessionWriteContext & { sessionId: string },
): Promise<void> {
  const { deps, res, fields, ns, clientId, values } = ctx;
  const rows = await createPeopleRepository(deps.pool).upsertKeyedSession({
    values: [
      ctx.sessionId,
      orNull(fields.project),
      fields.summary,
      fields.tags ?? [],
      fields.blockers ?? [],
      fields.next_steps ?? [],
      fields.key_decisions ?? [],
      clientId,
      ns,
      values.embeddingVal,
      values.hash,
      values.embeddedAt,
      values.model,
    ],
  });

  res.status(rows[0].is_new ? 201 : 200).json({
    id: rows[0].id,
    namespace: ns,
    session_id: ctx.sessionId,
    embedded: !!values.embedding,
    merged: !rows[0].is_new,
  });
}

async function insertUnkeyedSession(ctx: SessionWriteContext): Promise<void> {
  const { deps, res, fields, ns, clientId, values } = ctx;
  const rows = await createPeopleRepository(deps.pool).insertUnkeyedSession({
    values: [
      orNull(fields.project),
      fields.summary,
      fields.tags ?? [],
      fields.blockers ?? [],
      fields.next_steps ?? [],
      fields.key_decisions ?? [],
      clientId,
      ns,
      values.embeddingVal,
      values.hash,
      values.embeddedAt,
      values.model,
    ],
  });

  if (rows.length === 0) {
    res.status(409).json({ error: "Duplicate session content" });
    return;
  }

  res.status(201).json({
    id: rows[0].id,
    namespace: ns,
    embedded: !!values.embedding,
  });
}

export async function postSession(
  deps: RestDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const auth = getAuth(req);
  if (!auth || !canWrite(auth.role, "sessions")) {
    res.status(403).json({ error: "Permission denied" });
    return;
  }

  const fields = parseBody(sessionSchema, req.body, res);
  if (!fields) return;
  const { summary, project, session_id, blockers, next_steps, key_decisions } = fields;
  if (!summary) return;

  const ns = resolveWriteNamespace(auth, fields.namespace, res);
  if (ns === null) return;

  // Canonical session hash input and embed text -- shared with the repair
  // registry via sessionSourceHashInput()/sessionEmbedText() so repair never
  // disagrees with this writer.
  const hash = normalizedContentHash(sessionSourceHashInput({ summary, project }));
  const embedding = await deps.embedFn(
    sessionEmbedText({ summary, key_decisions, next_steps, blockers }),
  );

  const sessionCols = embeddingColumns(embedding, toSql, embeddingModel());
  const values: SessionEmbeddingValues = {
    embedding,
    embeddingVal: sessionCols.vector,
    embeddedAt: sessionCols.embeddedAt,
    model: sessionCols.model,
    hash,
  };

  if (session_id) {
    await upsertKeyedSession({
      deps,
      res,
      fields,
      ns,
      clientId: auth.clientId,
      values,
      sessionId: session_id,
    });
    return;
  }

  await insertUnkeyedSession({
    deps,
    res,
    fields,
    ns,
    clientId: auth.clientId,
    values,
  });
}
