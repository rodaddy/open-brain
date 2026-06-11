import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import type pg from "pg";
import type { AuthInfo, Table } from "./types.ts";
import { ALL_TABLES } from "./tools/search-brain.ts";
import type { generateEmbedding } from "./embedding.ts";
import { promoteEntry } from "./promotion-service.ts";
import { appendReadNamespacePredicate, canReadNamespace } from "./read-policy.ts";
import { appendWriteNamespacePredicate } from "./namespace-policy.ts";

interface RestDeps {
  pool: pg.Pool;
  embedFn: typeof generateEmbedding;
}

function getAuth(req: Request): AuthInfo | null {
  return (req as any).auth ?? null;
}

const tableSchema = z.enum(ALL_TABLES as [Table, ...Table[]]);
const namespaceSchema = z.string().trim().min(1).max(500);

const promoteSchema = z.object({
  table: tableSchema,
  id: z.string().uuid(),
  reason: z.string().max(1000).optional(),
  target_namespace: namespaceSchema.optional(),
});

const demoteSchema = z.object({
  table: tableSchema,
  id: z.string().uuid(),
});

const scanQuerySchema = z.object({
  table: tableSchema.optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  target_namespace: namespaceSchema.default("collab"),
});

function badRequest(res: Response, issues: z.ZodIssue[]): void {
  res.status(400).json({ error: "Invalid request", issues });
}

export function createPromotionRouter(deps: RestDeps): Router {
  const router = Router();

  router.post("/promote", async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth || (auth.role !== "admin" && auth.role !== "n8n")) {
      res.status(403).json({ error: "Permission denied: admin or n8n role required" });
      return;
    }

    const parsed = promoteSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error.issues);
      return;
    }

    const { table, id, reason, target_namespace } = parsed.data;
    let result;
    try {
      result = await promoteEntry(
        deps.pool,
        table,
        id,
        target_namespace ?? "collab",
        reason,
        auth,
      );
    } catch (err) {
      const statusCode = typeof (err as any)?.statusCode === "number"
        ? (err as any).statusCode
        : 500;
      res.status(statusCode).json({ error: (err as Error).message });
      return;
    }

    res.status(result.status === "duplicate" ? 409 : 201).json(result);
  });

  router.post("/demote", async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth || auth.role !== "admin") {
      res.status(403).json({ error: "Permission denied: admin role required" });
      return;
    }

    const parsed = demoteSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error.issues);
      return;
    }

    const { table, id } = parsed.data;
    const selectParams: unknown[] = [id];
    const readPredicate = appendReadNamespacePredicate(auth, selectParams);
    const { rows } = await deps.pool.query(
      `SELECT id, namespace, promoted_from FROM ${table} WHERE id = $1 AND archived_at IS NULL${readPredicate}`,
      selectParams,
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "Entry not found or already archived" });
      return;
    }
    if (!rows[0].promoted_from) {
      res.status(400).json({ error: "Entry was not promoted -- cannot demote" });
      return;
    }

    const provenance = rows[0].promoted_from;
    const updateParams: unknown[] = [id];
    const writePredicate = appendWriteNamespacePredicate(auth, updateParams);
    const { rowCount } = await deps.pool.query(
      `UPDATE ${table} SET archived_at = NOW() WHERE id = $1${writePredicate}`,
      updateParams,
    );
    if ((rowCount ?? 0) === 0) {
      res.status(404).json({ error: "Entry not found or already archived" });
      return;
    }

    res.json({
      status: "demoted",
      archived_id: id,
      source_id: provenance.source_id,
      source_namespace: provenance.source_namespace,
    });
  });

  router.get("/scan/:namespace", async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth || (auth.role !== "admin" && auth.role !== "n8n")) {
      res.status(403).json({ error: "Permission denied: admin or n8n role required" });
      return;
    }

    const namespace = namespaceSchema.safeParse(req.params.namespace);
    if (!namespace.success) {
      badRequest(res, namespace.error.issues);
      return;
    }

    const parsed = scanQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      badRequest(res, parsed.error.issues);
      return;
    }

    const { table, since, limit, target_namespace } = parsed.data;
    if (!canReadNamespace(auth, namespace.data)) {
      res.status(403).json({ error: "Permission denied: namespace read access denied" });
      return;
    }
    if (!canReadNamespace(auth, target_namespace)) {
      res.status(403).json({ error: "Permission denied: target namespace read access denied" });
      return;
    }

    const tables = table ? [table] : ALL_TABLES;
    const candidates: any[] = [];
    const duplicateEntries: any[] = [];
    const alreadyPromoted: any[] = [];

    for (const t of tables) {
      const sinceFilter = since ? ` AND t.created_at >= $3` : "";
      const params: unknown[] = [namespace.data, limit];
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
          const { rows: targetDupes } = await deps.pool.query(
            `SELECT id FROM ${t} WHERE content_hash = $1 AND namespace = $2 LIMIT 1`,
            [row.content_hash, target_namespace],
          );
          if (targetDupes.length > 0) {
            const duplicate: Record<string, unknown> = {
              table: t,
              id: row.id,
              target_namespace,
              existing_target_id: targetDupes[0].id,
              created_at: row.created_at,
            };
            if (target_namespace === "collab") {
              duplicate.existing_collab_id = targetDupes[0].id;
            }
            duplicateEntries.push(duplicate);
            continue;
          }
        }
        candidates.push({ table: t, id: row.id, created_at: row.created_at });
      }
    }

    res.json({
      namespace: namespace.data,
      target_namespace,
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
