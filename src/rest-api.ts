import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { toSql } from "pgvector/pg";
import type pg from "pg";
import { canWrite, canRead } from "./permissions.ts";
import { canWriteNamespace } from "./namespace-policy.ts";
import { contentHash, EMBEDDING_MODEL } from "./embedding.ts";
import { backgroundExtract } from "./extraction.ts";
import {
  executeSearch,
  executeSearchWithScopedSharedFallback,
  executeSearchWithSharedFallback,
  type SearchMode,
} from "./tools/search-brain.ts";
import { ALL_TABLES } from "./tools/table-constants.ts";
import { TABLE_COLUMNS } from "./table-projections.ts";
import { canReadNamespace, namespaceFilterFor, readableNamespaces } from "./read-policy.ts";
import { isSharedNamespace } from "./shared-namespace.ts";
import type { AuthInfo, Table, Tier } from "./types.ts";
import type { generateEmbedding } from "./embedding.ts";

interface RestDeps {
  pool: pg.Pool;
  embedFn: typeof generateEmbedding;
}

function getAuth(req: Request): AuthInfo | null {
  return (req as any).auth ?? null;
}

function nsError(reason: string | undefined): { error: string } {
  return { error: `Permission denied: ${reason ?? "namespace access denied"}` };
}

const validTableValues = ALL_TABLES as [Table, ...Table[]];
const uuidSchema = z.string().uuid();
const namespaceSchema = z.string().trim().min(1).max(500);
const stringArraySchema = z.array(z.string()).default([]);
const jsonRecordSchema = z.record(z.string(), z.unknown());

const thoughtSchema = z.object({
  content: z.string().trim().min(1),
  tags: stringArraySchema.optional(),
  namespace: namespaceSchema.optional(),
});

const decisionSchema = z.object({
  title: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  alternatives: stringArraySchema.optional(),
  tags: stringArraySchema.optional(),
  context: z.string().optional(),
  namespace: namespaceSchema.optional(),
});

const personSchema = z.object({
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

const sessionSchema = z.object({
  summary: z.string().trim().min(1),
  project: z.string().optional(),
  session_id: z.string().trim().min(1).optional(),
  tags: stringArraySchema.optional(),
  blockers: stringArraySchema.optional(),
  next_steps: stringArraySchema.optional(),
  key_decisions: stringArraySchema.optional(),
  namespace: namespaceSchema.optional(),
});

const searchQuerySchema = z.object({
  q: z.string().trim().min(1),
  namespace: namespaceSchema.optional(),
  limit: z.coerce.number().int().min(1).max(250).default(10),
  offset: z.coerce.number().int().min(0).default(0),
  table: z.enum(validTableValues).optional(),
  mode: z.enum(["hybrid", "vector", "keyword"]).default("hybrid"),
  tier: z.enum(["hot", "warm", "cold"]).optional(),
});

function parseBody<T>(
  schema: z.ZodType<T>,
  body: unknown,
  res: Response,
): T | null {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

function parseQuery<T>(
  schema: z.ZodType<T>,
  query: unknown,
  res: Response,
): T | null {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function isReadableNamespaceDenied(auth: AuthInfo, namespace?: string): boolean {
  return namespace !== undefined && !canReadNamespace(auth, namespace);
}

function readNamespacePredicate(auth: AuthInfo, paramIndex: number): string {
  return readableNamespaces(auth)
    ? ` AND namespace = ANY($${paramIndex}::text[])`
    : "";
}

export function createRestRouter(deps: RestDeps): Router {
  const router = Router();

  // POST /api/v1/thoughts
  router.post("/thoughts", asyncHandler(async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth || !canWrite(auth.role, "thoughts")) {
      res.status(403).json({ error: "Permission denied" });
      return;
    }

    const parsed = parseBody(thoughtSchema, req.body, res);
    if (!parsed) return;
    const { content, tags, namespace } = parsed;

    const ns = namespace ?? auth.clientId;
    const nsCheck = canWriteNamespace(auth, ns);
    if (!nsCheck.allowed) {
      res.status(403).json(nsError(nsCheck.reason));
      return;
    }

    const hash = contentHash(content);
    const textToEmbed = tags?.length
      ? `${content}\n${tags.join(" ")}`
      : content;
    const embedding = await deps.embedFn(textToEmbed);

    const { rows } = await deps.pool.query(
      `INSERT INTO thoughts (content, tags, source, created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
       VALUES ($1, $2, 'rest', $3, $4, $5, $6, $7, $8)
       ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
       DO UPDATE SET
         tags = (
           SELECT COALESCE(array_agg(DISTINCT tag), '{}')
           FROM unnest(thoughts.tags || EXCLUDED.tags) AS tag
           WHERE tag IS NOT NULL
         ),
         updated_at = NOW()
       RETURNING id, (xmax = 0) AS is_new`,
      [
        content,
        tags ?? [],
        auth.clientId,
        ns,
        embedding ? toSql(embedding) : null,
        hash,
        embedding ? new Date().toISOString() : null,
        embedding ? EMBEDDING_MODEL : null,
      ],
    );

    const entryId = rows[0].id as string;
    const isNew = rows[0].is_new as boolean;

    if (isNew) {
      backgroundExtract(deps.pool, "thoughts", entryId, content, tags ?? []);
    }

    res
      .status(isNew ? 201 : 200)
      .json({ id: entryId, namespace: ns, embedded: !!embedding, merged: !isNew });
  }));

  // POST /api/v1/decisions
  router.post("/decisions", asyncHandler(async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth || !canWrite(auth.role, "decisions")) {
      res.status(403).json({ error: "Permission denied" });
      return;
    }

    const parsed = parseBody(decisionSchema, req.body, res);
    if (!parsed) return;
    const { title, rationale, alternatives, tags, context, namespace } = parsed;

    const ns = namespace ?? auth.clientId;
    const nsCheck = canWriteNamespace(auth, ns);
    if (!nsCheck.allowed) {
      res.status(403).json(nsError(nsCheck.reason));
      return;
    }

    const parts = [title, rationale];
    if (context) parts.push(context);
    if (alternatives?.length) parts.push(alternatives.join(", "));
    if (tags?.length) parts.push(tags.join(" "));
    const textToEmbed = parts.join("\n");
    const hash = contentHash(textToEmbed);
    const embedding = await deps.embedFn(textToEmbed);

    const { rows } = await deps.pool.query(
      `INSERT INTO decisions (title, rationale, alternatives, tags, context, created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
       DO UPDATE SET
         tags = (
           SELECT COALESCE(array_agg(DISTINCT tag), '{}')
           FROM unnest(decisions.tags || EXCLUDED.tags) AS tag
           WHERE tag IS NOT NULL
         ),
         updated_at = NOW()
       RETURNING id, (xmax = 0) AS is_new`,
      [
        title,
        rationale,
        JSON.stringify(alternatives ?? []),
        tags ?? [],
        context ?? null,
        auth.clientId,
        ns,
        embedding ? toSql(embedding) : null,
        hash,
        embedding ? new Date().toISOString() : null,
        embedding ? EMBEDDING_MODEL : null,
      ],
    );

    const entryId = rows[0].id as string;
    const isNew = rows[0].is_new as boolean;

    if (isNew) {
      backgroundExtract(
        deps.pool,
        "decisions",
        entryId,
        textToEmbed,
        tags ?? [],
      );
    }

    res
      .status(isNew ? 201 : 200)
      .json({ id: entryId, namespace: ns, embedded: !!embedding, merged: !isNew });
  }));

  // POST /api/v1/persons
  router.post("/persons", asyncHandler(async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth || !canWrite(auth.role, "relationships")) {
      res.status(403).json({ error: "Permission denied" });
      return;
    }

    const {
      name,
      context,
      relationship_type,
      warmth,
      last_contact,
      email,
      phone,
      notes,
      tags,
      metadata,
      namespace,
    } = parseBody(personSchema, req.body, res) ?? {};
    if (!name) return;

    const ns = namespace ?? auth.clientId;
    const nsCheck = canWriteNamespace(auth, ns);
    if (!nsCheck.allowed) {
      res.status(403).json(nsError(nsCheck.reason));
      return;
    }

    const embeddableText = [name, context ?? "", notes ?? ""]
      .filter(Boolean)
      .join("\n");
    const hash = contentHash(embeddableText);
    const embedding = await deps.embedFn(embeddableText);

    const { rows } = await deps.pool.query(
      `INSERT INTO relationships (
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
      RETURNING id, (xmax = 0) AS inserted`,
      [
        name,
        context ?? null,
        relationship_type ?? null,
        warmth ?? null,
        last_contact ?? null,
        email ?? null,
        phone ?? null,
        notes ?? null,
        tags ?? null,
        metadata ? JSON.stringify(metadata) : null,
        auth.clientId,
        ns,
        embedding ? toSql(embedding) : null,
        hash,
        embedding ? new Date().toISOString() : null,
        embedding ? EMBEDDING_MODEL : null,
      ],
    );

    const row = rows[0];
    const action = row.inserted ? "created" : "updated";

    res.status(row.inserted ? 201 : 200).json({
      id: row.id,
      person_name: name,
      namespace: ns,
      action,
      embedded: !!embedding,
    });
  }));

  // POST /api/v1/sessions
  router.post("/sessions", asyncHandler(async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth || !canWrite(auth.role, "sessions")) {
      res.status(403).json({ error: "Permission denied" });
      return;
    }

    const {
      summary,
      project,
      session_id,
      tags,
      blockers,
      next_steps,
      key_decisions,
      namespace,
    } = parseBody(sessionSchema, req.body, res) ?? {};
    if (!summary) return;

    const ns = namespace ?? auth.clientId;
    const nsCheck = canWriteNamespace(auth, ns);
    if (!nsCheck.allowed) {
      res.status(403).json(nsError(nsCheck.reason));
      return;
    }

    const hash = contentHash(summary + "|" + (project ?? ""));
    const embedParts = [summary];
    if (key_decisions?.length) embedParts.push(key_decisions.join(". "));
    if (next_steps?.length) embedParts.push(next_steps.join(". "));
    if (blockers?.length) embedParts.push(blockers.join(". "));
    const embedding = await deps.embedFn(embedParts.join("\n"));

    const embeddingVal = embedding ? toSql(embedding) : null;
    const embeddedAt = embedding ? new Date().toISOString() : null;
    const model = embedding ? EMBEDDING_MODEL : null;

    if (session_id) {
      const { rows } = await deps.pool.query(
        `INSERT INTO sessions (session_id, project, summary, tags, blockers, next_steps, key_decisions, created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
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
         RETURNING id, (xmax = 0) AS is_new`,
        [
          session_id,
          project ?? null,
          summary,
          tags ?? [],
          blockers ?? [],
          next_steps ?? [],
          key_decisions ?? [],
          auth.clientId,
          ns,
          embeddingVal,
          hash,
          embeddedAt,
          model,
        ],
      );

      res.status(rows[0].is_new ? 201 : 200).json({
        id: rows[0].id,
        namespace: ns,
        session_id,
        embedded: !!embedding,
        merged: !rows[0].is_new,
      });
      return;
    }

    const { rows } = await deps.pool.query(
      `INSERT INTO sessions (project, summary, tags, blockers, next_steps, key_decisions, created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        project ?? null,
        summary,
        tags ?? [],
        blockers ?? [],
        next_steps ?? [],
        key_decisions ?? [],
        auth.clientId,
        ns,
        embeddingVal,
        hash,
        embeddedAt,
        model,
      ],
    );

    if (rows.length === 0) {
      res.status(409).json({ error: "Duplicate session content" });
      return;
    }

    res.status(201).json({
      id: rows[0].id,
      namespace: ns,
      embedded: !!embedding,
    });
  }));

  // GET /api/v1/search
  router.get("/search", asyncHandler(async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const parsed = parseQuery(searchQuerySchema, req.query, res);
    if (!parsed) return;
    const { q, namespace, limit, offset, table, mode, tier } = parsed;

    if (isReadableNamespaceDenied(auth, namespace)) {
      res.status(403).json({ error: "Permission denied: namespace read access denied" });
      return;
    }

    const accessibleTables = table
      ? [table as Table].filter((t) => ALL_TABLES.includes(t) && canRead(auth.role, t))
      : ALL_TABLES.filter((t) => canRead(auth.role, t));

    if (accessibleTables.length === 0) {
      res.status(403).json({ error: "No accessible tables" });
      return;
    }

    const namespaceFilter = namespaceFilterFor(auth, namespace);
    const rows =
      typeof namespaceFilter === "string" && isSharedNamespace(namespaceFilter)
        ? await executeSearchWithSharedFallback(
            deps,
            accessibleTables,
            q,
            limit,
            mode as SearchMode,
            tier as Tier | undefined,
            offset,
            namespaceFilter,
          )
        : await executeSearchWithScopedSharedFallback(
            deps,
            accessibleTables,
            q,
            limit,
            mode as SearchMode,
            tier as Tier | undefined,
            offset,
            namespaceFilter,
          );

    res.json({ results: rows, count: rows.length });
  }));

  // GET /api/v1/entries/:table/:id
  router.get("/entries/:table/:id", asyncHandler(async (req: Request, res: Response) => {
    const auth = getAuth(req);
    const table = req.params.table as Table;

    if (!ALL_TABLES.includes(table)) {
      res.status(400).json({ error: `Invalid table: ${table}` });
      return;
    }
    if (!auth || !canRead(auth.role, table)) {
      res.status(403).json({ error: "Permission denied" });
      return;
    }

    const id = uuidSchema.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "Invalid entry id" });
      return;
    }

    const columns = TABLE_COLUMNS[table];
    const readable = readableNamespaces(auth);
    const predicate = readNamespacePredicate(auth, 2);
    const params: unknown[] = readable ? [id.data, readable] : [id.data];
    const { rows } = await deps.pool.query(
      `SELECT ${columns} FROM ${table} WHERE id = $1${predicate} AND archived_at IS NULL`,
      params,
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "Entry not found or archived" });
      return;
    }

    const { source_refs: _sourceRefs, ...entry } = rows[0];
    res.json(entry);
  }));

  // GET /api/v1/namespaces
  router.get("/namespaces", asyncHandler(async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const accessibleTables = ALL_TABLES.filter((t) => canRead(auth.role, t));
    const readable = readableNamespaces(auth);
    const queries = accessibleTables.map((table) => {
      const predicate = readable ? " AND namespace = ANY($1::text[])" : "";
      return deps.pool.query(
        `SELECT '${table}' AS table_name, namespace, COUNT(*) AS count
         FROM ${table} WHERE archived_at IS NULL${predicate}
         GROUP BY namespace ORDER BY count DESC`,
        readable ? [readable] : [],
      );
    });

    const results = await Promise.all(queries);
    const nsMap = new Map<
      string,
      { total: number; per_table: Record<string, number> }
    >();

    for (const result of results) {
      for (const row of result.rows) {
        const ns = row.namespace as string;
        const existing = nsMap.get(ns) ?? { total: 0, per_table: {} };
        const count = Number(row.count);
        existing.total += count;
        existing.per_table[row.table_name] = count;
        nsMap.set(ns, existing);
      }
    }

    const namespaces = Array.from(nsMap.entries())
      .map(([namespace, data]) => ({
        namespace,
        total: data.total,
        per_table: data.per_table,
      }))
      .sort((a, b) => b.total - a.total);

    res.json({ namespace_count: namespaces.length, namespaces });
  }));

  return router;
}
