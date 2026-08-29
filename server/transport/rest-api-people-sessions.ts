/**
 * REST write routes for persons and sessions (issue 864 split of
 * `src/rest-api.ts`). Route paths, status codes, response shapes, error strings
 * and zod schemas are unchanged from the pre-split router.
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { toSql } from "pgvector/pg";
import { canWrite } from "../security/permissions.ts";
import { contentHash, EMBEDDING_MODEL } from "../../src/embedding.ts";
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

const PERSON_UPSERT_SQL = `INSERT INTO relationships (
        person_name, context, relationship_type, warmth, last_contact,
        email, phone, notes, tags, metadata,
        created_by, namespace, embedding, content_hash, embedded_at, embedding_model
      ) VALUES (
        $1, $2, $3, $4, $5::date,
        $6, $7, $8, COALESCE($9::text[], '{}'), COALESCE($10::jsonb, '{}'),
        $11, $12, $13, $14, $15, $16
      )
      ON CONFLICT (namespace, person_name) DO UPDATE SET
        context = COALESCE(EXCLUDED.context, relationships.context),
        relationship_type = COALESCE(EXCLUDED.relationship_type, relationships.relationship_type),
        warmth = COALESCE(EXCLUDED.warmth, relationships.warmth),
        last_contact = COALESCE(EXCLUDED.last_contact, relationships.last_contact),
        email = COALESCE(EXCLUDED.email, relationships.email),
        phone = COALESCE(EXCLUDED.phone, relationships.phone),
        notes = COALESCE(EXCLUDED.notes, relationships.notes),
        tags = CASE WHEN $9 IS NOT NULL THEN EXCLUDED.tags ELSE relationships.tags END,
        metadata = CASE WHEN $10 IS NOT NULL THEN EXCLUDED.metadata ELSE relationships.metadata END,
        embedding = EXCLUDED.embedding,
        content_hash = EXCLUDED.content_hash,
        embedded_at = EXCLUDED.embedded_at,
        embedding_model = EXCLUDED.embedding_model
      RETURNING id, (xmax = 0) AS inserted`;

const SESSION_UPSERT_SQL = `INSERT INTO sessions (session_id, project, summary, tags, blockers, next_steps, key_decisions, created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (namespace, session_id) WHERE session_id IS NOT NULL
         DO UPDATE SET
           summary = EXCLUDED.summary,
           tags = EXCLUDED.tags,
           blockers = EXCLUDED.blockers,
           next_steps = EXCLUDED.next_steps,
           key_decisions = EXCLUDED.key_decisions,
           embedding = EXCLUDED.embedding,
           content_hash = EXCLUDED.content_hash,
           embedded_at = EXCLUDED.embedded_at,
           updated_at = NOW()
         RETURNING id, (xmax = 0) AS is_new`;

const SESSION_INSERT_SQL = `INSERT INTO sessions (project, summary, tags, blockers, next_steps, key_decisions, created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL DO NOTHING
       RETURNING id`;

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
  const { rows } = await ctx.deps.pool.query(PERSON_UPSERT_SQL, [
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
  ]);
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
  const hash = contentHash(embeddableText);
  const embedding = await deps.embedFn(embeddableText);
  const cols = embeddingColumns(embedding, toSql, EMBEDDING_MODEL);

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
  const { rows } = await deps.pool.query(SESSION_UPSERT_SQL, [
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
  ]);

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
  const { rows } = await deps.pool.query(SESSION_INSERT_SQL, [
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
  ]);

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
  const hash = contentHash(sessionSourceHashInput({ summary, project }));
  const embedding = await deps.embedFn(
    sessionEmbedText({ summary, key_decisions, next_steps, blockers }),
  );

  const sessionCols = embeddingColumns(embedding, toSql, EMBEDDING_MODEL);
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
