import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import type { AuthInfo, Table } from "./types.ts";
import { ALL_TABLES } from "./tools/table-constants.ts";
import type { generateEmbedding } from "./embedding.ts";

interface RestDeps {
  pool: pg.Pool;
  embedFn: typeof generateEmbedding;
}

function getAuth(req: Request): AuthInfo | null {
  return (req as any).auth ?? null;
}

const CONTENT_COLUMNS: Record<Table, string> = {
  thoughts:
    "content, tags, source, created_by, embedding, content_hash, embedded_at, embedding_model, tier, usefulness_score, extracted_metadata",
  decisions:
    "title, rationale, alternatives, context, tags, created_by, embedding, content_hash, embedded_at, embedding_model, tier, usefulness_score, extracted_metadata",
  relationships:
    "person_name, context, relationship_type, warmth, last_contact, email, phone, notes, tags, metadata, created_by, embedding, content_hash, embedded_at, embedding_model, tier, usefulness_score",
  projects:
    "name, status, description, metadata, tags, created_by, embedding, content_hash, embedded_at, embedding_model, tier, usefulness_score",
  sessions:
    "session_id, project, summary, tags, blockers, next_steps, key_decisions, created_by, embedding, content_hash, embedded_at, embedding_model, tier",
};

export function createPromotionRouter(deps: RestDeps): Router {
  const router = Router();

  // POST /api/v1/promote
  router.post("/promote", async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth || (auth.role !== "admin" && auth.role !== "n8n")) {
      res.status(403).json({ error: "Permission denied: admin or n8n role required" });
      return;
    }

    const { table, id, reason, target_namespace } = req.body;
    if (!table || !id) {
      res.status(400).json({ error: "table and id are required" });
      return;
    }
    if (!ALL_TABLES.includes(table)) {
      res.status(400).json({ error: `Invalid table: ${table}` });
      return;
    }

    const targetNs = target_namespace ?? "collab";

    const { rows: sourceRows } = await deps.pool.query(
      `SELECT *, namespace AS source_namespace FROM ${table} WHERE id = $1 AND archived_at IS NULL`,
      [id],
    );

    if (sourceRows.length === 0) {
      res.status(404).json({ error: "Source entry not found or archived" });
      return;
    }

    const source = sourceRows[0];
    if (source.namespace === targetNs) {
      res.status(409).json({ error: `Entry is already in namespace '${targetNs}'` });
      return;
    }

    if (source.content_hash) {
      const { rows: dupes } = await deps.pool.query(
        `SELECT id FROM ${table} WHERE content_hash = $1 AND namespace = $2 AND archived_at IS NULL`,
        [source.content_hash, targetNs],
      );
      if (dupes.length > 0) {
        res.status(409).json({
          status: "duplicate",
          existing_id: dupes[0].id,
          source_id: id,
          target_namespace: targetNs,
        });
        return;
      }
    }

    const provenance = {
      source_namespace: source.namespace,
      source_id: id,
      source_agent: source.created_by,
      promotion_reason: reason ?? null,
      promoted_at: new Date().toISOString(),
      promoted_by: auth.clientId,
    };

    const columns = CONTENT_COLUMNS[table as Table];
    const { rows: inserted } = await deps.pool.query(
      `INSERT INTO ${table} (${columns}, namespace, promoted_from)
       SELECT ${columns}, $2, $3::jsonb
       FROM ${table} WHERE id = $1
       RETURNING id`,
      [id, targetNs, JSON.stringify(provenance)],
    );

    res.status(201).json({
      status: "promoted",
      new_id: inserted[0].id,
      source_id: id,
      source_namespace: source.namespace,
      target_namespace: targetNs,
      provenance,
    });
  });

  // POST /api/v1/demote
  router.post("/demote", async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth || auth.role !== "admin") {
      res.status(403).json({ error: "Permission denied: admin role required" });
      return;
    }

    const { table, id } = req.body;
    if (!table || !id) {
      res.status(400).json({ error: "table and id are required" });
      return;
    }
    if (!ALL_TABLES.includes(table)) {
      res.status(400).json({ error: `Invalid table: ${table}` });
      return;
    }

    const { rows } = await deps.pool.query(
      `SELECT id, namespace, promoted_from FROM ${table} WHERE id = $1 AND archived_at IS NULL`,
      [id],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "Entry not found or already archived" });
      return;
    }
    if (!rows[0].promoted_from) {
      res.status(400).json({ error: "Entry was not promoted — cannot demote" });
      return;
    }

    const provenance = rows[0].promoted_from;
    await deps.pool.query(`UPDATE ${table} SET archived_at = NOW() WHERE id = $1`, [id]);

    res.json({
      status: "demoted",
      archived_id: id,
      source_id: provenance.source_id,
      source_namespace: provenance.source_namespace,
    });
  });

  // GET /api/v1/scan/:namespace
  router.get("/scan/:namespace", async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth || (auth.role !== "admin" && auth.role !== "n8n")) {
      res.status(403).json({ error: "Permission denied: admin or n8n role required" });
      return;
    }

    const namespace = req.params.namespace;
    const table = (req.query.table as string) || undefined;
    const since = (req.query.since as string) || undefined;
    const limit = Math.min(parseInt((req.query.limit as string) ?? "20", 10) || 20, 100);

    const tables = table ? [table as Table].filter((t) => ALL_TABLES.includes(t)) : ALL_TABLES;
    const candidates: any[] = [];
    const duplicateEntries: any[] = [];
    const alreadyPromoted: any[] = [];

    for (const t of tables) {
      const sinceFilter = since ? ` AND t.created_at >= $3` : "";
      const params: unknown[] = [namespace, limit];
      if (since) params.push(since);

      const { rows } = await deps.pool.query(
        `SELECT t.id, t.content_hash, t.namespace, t.created_at, t.promoted_from,
                '${t}' AS table_name
         FROM ${t} t
         WHERE t.namespace = $1 AND t.archived_at IS NULL${sinceFilter}
         ORDER BY t.created_at DESC
         LIMIT $2`,
        params,
      );

      for (const row of rows) {
        if (row.promoted_from) {
          alreadyPromoted.push({ table: t, id: row.id, created_at: row.created_at });
          continue;
        }
        if (row.content_hash) {
          const { rows: collabDupes } = await deps.pool.query(
            `SELECT id FROM ${t} WHERE content_hash = $1 AND namespace = 'collab' AND archived_at IS NULL LIMIT 1`,
            [row.content_hash],
          );
          if (collabDupes.length > 0) {
            duplicateEntries.push({
              table: t,
              id: row.id,
              existing_collab_id: collabDupes[0].id,
              created_at: row.created_at,
            });
            continue;
          }
        }
        candidates.push({ table: t, id: row.id, created_at: row.created_at });
      }
    }

    res.json({
      namespace,
      candidates,
      duplicates: duplicateEntries,
      already_promoted: alreadyPromoted,
      summary: {
        candidates: candidates.length,
        duplicates: duplicateEntries.length,
        already_promoted: alreadyPromoted.length,
      },
    });
  });

  return router;
}
