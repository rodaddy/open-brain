import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import type pg from "pg";
import type { AuthInfo, Table } from "../../src/types.ts";
import { ALL_TABLES } from "../../src/tools/search-brain.ts";
import type { generateEmbedding } from "../../src/embedding.ts";
// The legacy adapter, not `server/domain/promotion-service.ts` directly: the
// server-side service takes the promotion kill switch as a value, and the
// adapter is what reads `OPENBRAIN_PROMOTION_KILL_SWITCH` at call time. This
// route's caller (`server/transport/rest.ts`) does not carry config, so calling
// the service directly here would silently drop the kill switch. Repointing at
// the service is L6 work, once config reaches the REST surface.
import { promoteEntry } from "../../src/promotion-service.ts";
import { describeError, logger } from "../observability/log-surface.ts";
import {
  appendReadNamespacePredicate,
  canReadNamespace,
} from "../domain/read-policy.ts";
import { appendWriteNamespacePredicate } from "../security/namespace-policy.ts";
// The src/ module, not `server/tools/shared-namespace.ts`: the server-side one
// requires the composition root to inject `sharedNamespaceNames` from the
// validated ServerConfig, and this route's caller
// (`server/transport/rest.ts`) does not carry config. Calling it here throws
// "shared-namespace names are missing" on every scan and promote. Repointing
// is L6 work, once config reaches the REST surface.
import {
  canonicalNamespace,
  physicalNamespace,
  sharedNamespaceConfig,
} from "../../src/shared-namespace.ts";
import {
  explicitSharedNominationSqlPredicate,
  isExplicitSharedNomination,
  promotionMetadataSelect,
} from "../domain/promotion-nomination.ts";

interface RestDeps {
  pool: pg.Pool;
  embedFn: typeof generateEmbedding;
}

function getAuth(req: Request): AuthInfo | null {
  return (req as Request & { auth?: AuthInfo }).auth ?? null;
}

const tableSchema = z.enum(ALL_TABLES as [Table, ...Table[]]);
const namespaceSchema = z.string().trim().min(1).max(500);

const promoteSchema = z.object({
  table: tableSchema,
  id: z.string().uuid(),
  reason: z.string().max(1000).optional(),
  target_namespace: namespaceSchema.optional(),
  dry_run: z.boolean().optional(),
});

const demoteSchema = z.object({
  table: tableSchema,
  id: z.string().uuid(),
});

const scanQuerySchema = z.object({
  table: tableSchema.optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  target_namespace: namespaceSchema.optional(),
});

function badRequest(res: Response, issues: z.ZodIssue[]): void {
  res.status(400).json({ error: "Invalid request", issues });
}

/**
 * Answers the caller and reports false when the request lacks a promoting
 * role. Hoisted from the three handlers, which repeated this check verbatim;
 * the accepted roles and the refusal wording are unchanged.
 */
function requirePromoterRole(req: Request, res: Response): AuthInfo | null {
  const auth = getAuth(req);
  if (
    !auth ||
    (auth.role !== "admin" && auth.role !== "ob-admin" && auth.role !== "promoter")
  ) {
    res.status(403).json({
      error: "Permission denied: admin, ob-admin, or promoter role required",
    });
    return null;
  }
  return auth;
}

/**
 * Reports the promotion failure and answers the caller.
 *
 * Hoisted out of the `/promote` handler so that handler stays under the
 * function rule; the branching and the wording it produces are unchanged.
 */
function respondPromoteFailure(
  res: Response,
  err: unknown,
  resolvedTargetNamespace: string,
): void {
  // `promotion-service.ts` marks every DELIBERATE rejection with a
  // statusCode and a curated message ("Source entry not found or archived",
  // "Target namespace read access denied", ...). Those are the contract and
  // are echoed unchanged -- callers parse them.
  //
  // An error WITHOUT a statusCode is an unexpected throw: a pg error, a bug.
  // Echoing its message published raw driver text -- relation names,
  // connection detail, and the parameter values pg quotes back -- to any
  // caller who could reach this route, which is the leak the doctor route in
  // index.ts already refuses to allow. The status stays 500 either way, so
  // no caller loses a distinction it previously had.
  const declared = (err as { statusCode?: unknown }).statusCode;
  const statusCode = typeof declared === "number" ? declared : 500;
  const deliberate = typeof declared === "number";
  // A promotion that fails wrote nothing, and this route recorded nothing
  // either: the only trace was a status code in an access log. The driver
  // fields say which relation refused it, and why.
  logger.error("rest_promote_failed", {
    status_code: statusCode,
    namespace: resolvedTargetNamespace,
    deliberate,
    ...describeError(err),
  });
  res.status(statusCode).json({
    error: deliberate
      ? (err as Error).message
      : "Promotion failed due to an internal error",
  });
}

/** Handles `POST /promote`. Hoisted to module scope; behavior unchanged. */
async function handlePromote(
  deps: RestDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const auth = requirePromoterRole(req, res);
  if (!auth) return;

  const parsed = promoteSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues);
    return;
  }

  const { table, id, reason, target_namespace, dry_run } = parsed.data;
  const resolvedTargetNamespace =
    target_namespace ?? sharedNamespaceConfig().sharedNamespace;
  let result;
  try {
    result = await promoteEntry(
      deps.pool,
      table,
      id,
      resolvedTargetNamespace,
      reason,
      auth,
      {
        dryRun: dry_run ?? false,
      },
    );
  } catch (err) {
    respondPromoteFailure(res, err, resolvedTargetNamespace);
    return;
  }

  res
    .status(
      result.status === "duplicate" ? 409 : result.status === "dry_run" ? 200 : 201,
    )
    .json(result);
}

/** Handles `POST /demote`. Hoisted to module scope; behavior unchanged. */
async function handleDemote(
  deps: RestDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const auth = getAuth(req);
  if (!auth || (auth.role !== "admin" && auth.role !== "ob-admin")) {
    res
      .status(403)
      .json({ error: "Permission denied: admin or ob-admin role required" });
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

  const found = rows[0];
  if (rows.length === 0 || !found) {
    res.status(404).json({ error: "Entry not found or already archived" });
    return;
  }
  if (!found.promoted_from) {
    res.status(400).json({ error: "Entry was not promoted -- cannot demote" });
    return;
  }

  const provenance = found.promoted_from;
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
}

/** One scan row, as the scan query projects it. */
interface ScanRow {
  id: string;
  content_hash: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

/** A scanned entry that already exists in the target namespace. */
type DuplicateEntry = Record<string, unknown>;

/** A scanned entry nominated for promotion. */
interface CandidateEntry {
  table: Table;
  id: string;
  created_at: string;
}

/** What one table's scan pass produced. */
interface ScanBuckets {
  candidates: CandidateEntry[];
  duplicates: DuplicateEntry[];
}

/** The namespace a scan promotes into, in both spellings. */
interface ScanTarget {
  physicalNamespace: string;
  canonicalNamespace: string;
}

/** The source side of a scan, as the request's query fields describe it. */
interface ScanWindow {
  namespace: string;
  since: string | undefined;
  rowLimit: number;
}

/**
 * Looks up the existing target-namespace entry for one scanned row.
 *
 * Hoisted out of the scan loop so the loop stays within the nesting rule; the
 * query and the duplicate shape are unchanged.
 */
async function findTargetDuplicate(
  deps: RestDeps,
  table: Table,
  row: ScanRow,
  target: ScanTarget,
): Promise<DuplicateEntry | null> {
  if (!row.content_hash) return null;
  const { rows: targetDupes } = await deps.pool.query(
    `SELECT id FROM ${table}
             WHERE content_hash = $1 AND namespace = $2 AND archived_at IS NULL
             LIMIT 1`,
    [row.content_hash, target.physicalNamespace],
  );
  const existing = targetDupes[0];
  if (!existing) return null;
  return {
    table,
    id: row.id,
    target_namespace: target.canonicalNamespace,
    existing_target_id: existing.id,
    created_at: row.created_at,
  };
}

/**
 * Scans one table for promotion candidates and target-namespace duplicates.
 *
 * Hoisted out of the `/scan` handler; the SQL, the ordering, and the
 * candidate/duplicate split are unchanged.
 */
async function scanTable(
  deps: RestDeps,
  table: Table,
  window: ScanWindow,
  target: ScanTarget,
): Promise<ScanBuckets> {
  const { since } = window;
  const sinceFilter = since ? ` AND t.created_at >= $3` : "";
  const params: unknown[] = [window.namespace, window.rowLimit];
  if (since) params.push(since);
  const metadataSelect = promotionMetadataSelect(table);
  const nominationFilter = explicitSharedNominationSqlPredicate(table);

  const { rows } = await deps.pool.query(
    `SELECT t.id, t.content_hash, t.namespace, t.created_at,
                ${metadataSelect} AS metadata,
                '${table}' AS table_name
         FROM ${table} t
         WHERE t.namespace = $1 AND t.archived_at IS NULL${nominationFilter}${sinceFilter}
         ORDER BY t.created_at DESC
         LIMIT $2`,
    params,
  );

  const buckets: ScanBuckets = { candidates: [], duplicates: [] };
  for (const row of rows as ScanRow[]) {
    const duplicate = await findTargetDuplicate(deps, table, row, target);
    if (duplicate) {
      buckets.duplicates.push(duplicate);
      continue;
    }
    if (isExplicitSharedNomination(row.metadata)) {
      buckets.candidates.push({
        table,
        id: row.id,
        created_at: row.created_at,
      });
    }
  }
  return buckets;
}

/** Handles `GET /scan/:namespace`. Hoisted to module scope; behavior unchanged. */
async function handleScan(deps: RestDeps, req: Request, res: Response): Promise<void> {
  const auth = requirePromoterRole(req, res);
  if (!auth) return;

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
  const resolvedTargetNamespace =
    target_namespace ?? sharedNamespaceConfig().sharedNamespace;
  const targetPhysicalNamespace = physicalNamespace(resolvedTargetNamespace);
  const targetCanonicalNamespace = canonicalNamespace(targetPhysicalNamespace);
  const target: ScanTarget = {
    physicalNamespace: targetPhysicalNamespace,
    canonicalNamespace: targetCanonicalNamespace,
  };
  if (!canReadNamespace(auth, namespace.data)) {
    res.status(403).json({ error: "Permission denied: namespace read access denied" });
    return;
  }
  if (!canReadNamespace(auth, resolvedTargetNamespace)) {
    res.status(403).json({
      error: "Permission denied: target namespace read access denied",
    });
    return;
  }

  const tables = table ? [table] : ALL_TABLES;
  const candidates: CandidateEntry[] = [];
  const duplicateEntries: DuplicateEntry[] = [];

  const window: ScanWindow = {
    namespace: namespace.data,
    since,
    rowLimit: limit,
  };
  for (const t of tables) {
    const buckets = await scanTable(deps, t, window, target);
    candidates.push(...buckets.candidates);
    duplicateEntries.push(...buckets.duplicates);
  }

  res.json({
    namespace: namespace.data,
    target_namespace: targetCanonicalNamespace,
    candidates,
    duplicates: duplicateEntries,
    summary: {
      candidates: candidates.length,
      duplicates: duplicateEntries.length,
    },
  });
}

export function createPromotionRouter(deps: RestDeps): Router {
  const router = Router();

  router.post("/promote", (req: Request, res: Response) =>
    handlePromote(deps, req, res),
  );
  router.post("/demote", (req: Request, res: Response) => handleDemote(deps, req, res));
  router.get("/scan/:namespace", (req: Request, res: Response) =>
    handleScan(deps, req, res),
  );

  return router;
}
