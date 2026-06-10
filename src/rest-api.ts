import { Router } from "express";
import type { Request, Response } from "express";
import { toSql } from "pgvector/pg";
import type pg from "pg";
import { canWrite, canRead } from "./permissions.ts";
import { canWriteNamespace } from "./namespace-policy.ts";
import { contentHash, EMBEDDING_MODEL } from "./embedding.ts";
import { backgroundExtract } from "./extraction.ts";
import { executeSearch } from "./tools/search-brain.ts";
import { ALL_TABLES } from "./tools/table-constants.ts";
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

export function createRestRouter(deps: RestDeps): Router {
  const router = Router();

  // POST /api/v1/thoughts
  router.post("/thoughts", async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth || !canWrite(auth.role, "thoughts")) {
      res.status(403).json({ error: "Permission denied" });
      return;
    }

    const { content, tags, namespace } = req.body;
    if (!content || typeof content !== "string" || content.trim().length === 0) {
      res.status(400).json({ error: "content is required" });
      return;
    }

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
  });

  // POST /api/v1/decisions
  router.post("/decisions", async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth || !canWrite(auth.role, "decisions")) {
      res.status(403).json({ error: "Permission denied" });
      return;
    }

    const { title, rationale, alternatives, tags, context, namespace } =
      req.body;
    if (!title || !rationale) {
      res.status(400).json({ error: "title and rationale are required" });
      return;
    }

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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
        alternatives ?? [],
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
  });

  // POST /api/v1/persons
  router.post("/persons", async (req: Request, res: Response) => {
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
    } = req.body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }

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
  });

  // POST /api/v1/sessions
  router.post("/sessions", async (req: Request, res: Response) => {
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
    } = req.body;

    if (!summary || typeof summary !== "string") {
      res.status(400).json({ error: "summary is required" });
      return;
    }

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
  });

  // GET /api/v1/search
  router.get("/search", async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const q = req.query.q as string;
    if (!q) {
      res.status(400).json({ error: "q query parameter is required" });
      return;
    }

    const namespace = (req.query.namespace as string) || undefined;
    const limit = Math.min(parseInt((req.query.limit as string) ?? "10", 10) || 10, 250);
    const offset = parseInt((req.query.offset as string) ?? "0", 10) || 0;
    const table = (req.query.table as string) || undefined;
    const mode = (req.query.mode as string) || "hybrid";
    const tier = (req.query.tier as string) || undefined;

    const accessibleTables = table
      ? [table as Table].filter((t) => ALL_TABLES.includes(t) && canRead(auth.role, t))
      : ALL_TABLES.filter((t) => canRead(auth.role, t));

    if (accessibleTables.length === 0) {
      res.status(403).json({ error: "No accessible tables" });
      return;
    }

    const rows = await executeSearch(
      deps,
      accessibleTables,
      q,
      limit,
      mode as "hybrid" | "vector" | "keyword",
      tier as Tier | undefined,
      offset,
      namespace,
    );

    res.json({ results: rows, count: rows.length });
  });

  // GET /api/v1/entries/:table/:id
  router.get("/entries/:table/:id", async (req: Request, res: Response) => {
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

    const TABLE_COLUMNS: Record<Table, string> = {
      thoughts:
        "id, content, tags, source, created_by, created_at, updated_at, tier, usefulness_score, access_count, last_accessed_at, extracted_metadata, namespace",
      decisions:
        "id, title, rationale, alternatives, context, tags, created_by, created_at, updated_at, tier, usefulness_score, access_count, last_accessed_at, extracted_metadata, namespace",
      relationships:
        "id, person_name, context, relationship_type, warmth, email, phone, tags, metadata, created_by, created_at, tier, usefulness_score, access_count, namespace",
      projects:
        "id, name, status, description, metadata, tags, created_by, created_at, tier, usefulness_score, access_count, namespace",
      sessions:
        "id, session_id, project, summary, tags, blockers, next_steps, key_decisions, created_by, created_at, updated_at, tier, namespace",
    };

    const columns = TABLE_COLUMNS[table];
    const { rows } = await deps.pool.query(
      `SELECT ${columns} FROM ${table} WHERE id = $1 AND archived_at IS NULL`,
      [req.params.id],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "Entry not found or archived" });
      return;
    }

    res.json(rows[0]);
  });

  // GET /api/v1/namespaces
  router.get("/namespaces", async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const accessibleTables = ALL_TABLES.filter((t) => canRead(auth.role, t));
    const queries = accessibleTables.map((table) =>
      deps.pool.query(
        `SELECT '${table}' AS table_name, namespace, COUNT(*) AS count
         FROM ${table} WHERE archived_at IS NULL
         GROUP BY namespace ORDER BY count DESC`,
      ),
    );

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
  });

  return router;
}
