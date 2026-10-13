/**
 * Shared stale-embedding detection and idempotent repair primitives -- building
 * blocks (issue #345), not a queue handler and not a migration.
 *
 * See docs/decisions/embedding-repair-guards-on-observed-truth.md
 * See docs/decisions/embedding-repair-staleness-reasons.md
 */
import { toSql } from "pgvector/pg";
import {
  embeddingModel,
  generateEmbeddingWithMetadata,
  type EmbeddingError,
  type EmbeddingResult,
} from "../embedding/provider.ts";
import {
  getEmbeddingTarget,
  type EmbeddingTarget,
  type TargetRow,
} from "./embedding-targets.ts";
import { logger } from "../logging/legacy-logger.ts";
import {
  namespacePredicate,
  normalizeScope,
  selectStaleWithCursor,
} from "./embedding-repair-selection.ts";
import type {
  RepairCandidate,
  RepairScope,
  SelectStaleOptions,
} from "./embedding-repair-selection.ts";
import type { EmbedWithMetaFn, Queryable } from "./embedding-repair-model.ts";

export * from "./embedding-repair-selection.ts";
export type { EmbedWithMetaFn, Queryable } from "./embedding-repair-model.ts";

/** Terminal disposition of a single repair attempt. */
export type RepairStatus =
  | "repaired" // vector written (or converged on identical state)
  | "skipped_source_changed" // guard matched zero rows -- concurrent edit won
  | "skipped_empty_text" // nothing to embed (empty canonical text)
  | "retryable_failure" // provider transient -- safe to re-deliver
  | "permanent_failure" // provider/input permanent -- do not blindly retry
  | "content_hash_collision"; // fresh hash already held by another row (23505)

/** Provider-failure categories mapped to re-delivery semantics, content-free. */
const RETRYABLE_CODES = new Set<EmbeddingError["code"]>([
  "timeout",
  "network",
  "server_error",
]);

export interface RepairResult {
  table: string;
  id: string;
  status: RepairStatus;
  /** Provider failure code when status is *_failure; never contains source text. */
  errorCode?: EmbeddingError["code"];
  /** True when a guarded UPDATE matched exactly one row and wrote the vector. */
  updated: boolean;
}

export interface RepairOptions {
  currentModel?: string;
  embeddingUrl?: string;
  signal?: AbortSignal;
  observeEmbedding?: (
    identity: { row_id: string; char_count: number; content_hash: string },
    work: () => Promise<EmbeddingResult>,
  ) => Promise<EmbeddingResult>;
  /**
   * REQUIRED namespace scope for the guarded UPDATE. A non-empty auth-derived
   * `{ namespaces: [...] }` binds namespace (directly or via the target FK) IN
   * ADDITION to the id guard, so an id-only repair can never mutate a row
   * outside those namespaces -- an out-of-scope row matches zero rows and
   * returns `skipped_source_changed`. `{ global: true }` is the explicit,
   * separately named intentionally-global path. There is no unscoped default;
   * a missing or empty scope throws. See {@link RepairScope}.
   */
  scope: RepairScope;
}

/**
 * Classify a provider failure into a content-free, re-delivery-aware result.
 * Only the error code and ids are logged -- never the embed text.
 */
function providerFailureResult(
  table: string,
  id: string,
  code: EmbeddingError["code"] | undefined,
): RepairResult {
  const retryable = code !== undefined && RETRYABLE_CODES.has(code);
  logger.warn("embedding_repair_provider_failure", {
    table,
    id,
    code: code ?? "unknown",
    retryable,
  });
  return {
    table,
    id,
    status: retryable ? "retryable_failure" : "permanent_failure",
    errorCode: code,
    updated: false,
  };
}

/**
 * True for a unique violation (SQLSTATE 23505) on a content_hash unique index,
 * e.g. `idx_sessions_content_hash`. Any other error is not ours to absorb.
 */
function isContentHashCollision(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  return (
    code === "23505" &&
    typeof constraint === "string" &&
    constraint.includes("content_hash")
  );
}

/**
 * Repair a single row: (re)generate its embedding OUTSIDE any DB lock and write
 * it back with a guarded, idempotent UPDATE.
 *
 * The write only lands when the row's source is UNCHANGED since selection --
 * for targets with content_hash, the UPDATE carries `content_hash =
 * $capturedHash` in its WHERE, so a concurrent source edit (which changed the
 * hash) causes zero rows to match and we return `skipped_source_changed`
 * instead of overwriting the newer embedding. For targets WITHOUT content_hash
 * (ob_entities), the only detectable staleness is a missing embedding, so the
 * guard is the truthful `embedding IS NULL`: a concurrent write that already
 * populated the embedding wins and we skip -- we never fabricate a content_hash.
 *
 * The scope is mandatory and explicit. A non-empty `{ namespaces: [...] }`
 * additionally binds namespace (directly or via the target's FK) so an id-only
 * repair cannot mutate a row outside the auth-derived scope; `{ global: true }`
 * is the separately named intentionally-global path. A missing or empty scope
 * throws before any provider call.
 */
export async function repairOne(
  db: Queryable,
  candidate: RepairCandidate,
  embedFn: EmbedWithMetaFn,
  options: RepairOptions,
): Promise<RepairResult> {
  const target = getEmbeddingTarget(candidate.table);
  // Validate scope up front -- fail closed before spending a provider call.
  const scope = normalizeScope(options.scope);
  const { id } = candidate;
  const embedText = target.embedText(candidate.row);
  // Two distinct hashes, one per role -- they are NOT interchangeable:
  //  - `freshHash` is hash(current source). It is what we WRITE back into
  //    content_hash so the row's stored hash tracks the source we just embedded.
  //  - `observedHash` is the STORED content_hash we saw at selection time (from
  //    the projected row). It is the no-overwrite GUARD: the UPDATE lands only
  //    while the stored hash is still the one we observed. Guarding on freshHash
  //    would be wrong for a source-drifted row -- its stored hash is the OLD
  //    value, so `content_hash = freshHash` never matches and the repair could
  //    never write. Guarding on observedHash lets a genuine drift repair land
  //    while still skipping a row a concurrent re-embed changed underneath us.
  const freshHash = target.sourceHash(candidate.row);
  const observedHash =
    (candidate.row.content_hash as string | null | undefined) ?? null;

  if (!embedText || embedText.trim().length === 0) {
    return {
      table: candidate.table,
      id,
      status: "skipped_empty_text",
      updated: false,
    };
  }

  // --- Provider round trip: OUTSIDE any transaction/lock. ---
  const embed = () =>
    embedFn(embedText, options.embeddingUrl, {
      signal: options.signal,
    });
  const result = options.observeEmbedding
    ? await options.observeEmbedding(
        { row_id: id, char_count: embedText.length, content_hash: freshHash },
        embed,
      )
    : await embed();

  if (!result.embedding) {
    return providerFailureResult(candidate.table, id, result.error?.code);
  }

  const currentModel = options.currentModel ?? embeddingModel();
  const update = buildGuardedUpdate(
    target,
    candidate.row,
    {
      id,
      embedding: result.embedding,
      freshHash,
      observedHash,
      currentModel,
    },
    scope,
  );

  return applyGuardedUpdate(db, { table: candidate.table, id }, update);
}

/**
 * Run one guarded UPDATE and map its outcome to a RepairResult. A unique
 * violation on a content_hash index (issue 1462) is that row's outcome, not
 * the batch's: both callers (the repair CLI and the queue handler) pass a pool,
 * so each UPDATE is its own autocommit statement and nothing else rolls back.
 * Any other error propagates unchanged.
 */
async function applyGuardedUpdate(
  db: Queryable,
  unit: { table: string; id: string },
  update: { sql: string; params: unknown[] },
): Promise<RepairResult> {
  const { table, id } = unit;
  let rowCount: number | null;
  try {
    ({ rowCount } = await db.query(update.sql, update.params));
  } catch (err) {
    if (!isContentHashCollision(err)) throw err;
    // Content-free: ids only, never the source text or the hash.
    logger.warn("embedding_repair_content_hash_collision", {
      table,
      id,
    });
    return {
      table,
      id,
      status: "content_hash_collision",
      updated: false,
    };
  }
  if ((rowCount ?? 0) === 0) {
    // Row vanished, was archived, or its source changed since selection.
    logger.info("embedding_repair_guard_no_match", {
      table,
      id,
    });
    return {
      table,
      id,
      status: "skipped_source_changed",
      updated: false,
    };
  }

  return { table, id, status: "repaired", updated: true };
}

/**
 * Build the idempotent, guarded UPDATE for one row. Only provenance columns
 * that physically exist on the target are written -- no fabricated provenance,
 * and the WHERE clause guards on observed truth plus the namespace scope.
 *
 * See docs/decisions/embedding-repair-guards-on-observed-truth.md
 */
function buildGuardedUpdate(
  target: EmbeddingTarget,
  row: TargetRow,
  write: {
    id: string;
    embedding: number[];
    freshHash: string;
    observedHash: string | null;
    currentModel: string;
  },
  scope: { global: true } | { namespaces: string[] },
): { sql: string; params: unknown[] } {
  const { id, embedding, freshHash, observedHash, currentModel } = write;
  const sets: string[] = [];
  const params: unknown[] = [];

  params.push(toSql(embedding));
  sets.push(`embedding = $${params.length}`);

  if (target.provenance.hasContentHash) {
    // Write the FRESH hash of the source we just embedded.
    params.push(freshHash);
    sets.push(`content_hash = $${params.length}`);
  }
  if (target.provenance.hasEmbeddedAt) {
    sets.push("embedded_at = NOW()");
  }
  if (target.provenance.hasEmbeddingModel) {
    params.push(currentModel);
    sets.push(`embedding_model = $${params.length}`);
  }

  params.push(id);
  const idParam = `$${params.length}`;

  const whereParts = [`${target.idColumn} = ${idParam}`];
  if (target.baseFilterSql) whereParts.push(target.baseFilterSql);

  if (target.provenance.hasContentHash) {
    // Idempotency + no-overwrite guard: only write while the stored content_hash
    // is still the value we OBSERVED at selection time. IS NOT DISTINCT FROM is
    // NULL-safe, so:
    //  - a `missing` row (stored hash NULL, observedHash NULL) matches its NULL
    //    and the first fill lands;
    //  - a `source_drift` row (stored hash = the OLD value, observedHash = that
    //    same old value) matches and the drift repair lands, writing the fresh
    //    hash via the SET above;
    //  - a row a concurrent writer re-embedded between selection and now (its
    //    stored hash changed away from observedHash) does NOT match, so the
    //    guarded UPDATE affects zero rows and repair skips instead of clobbering
    //    the newer embedding.
    // Guarding on the FRESH hash here would be wrong: a drifted row's stored
    // hash is the old value, so it would never match and the repair could never
    // land.
    params.push(observedHash);
    whereParts.push(`content_hash IS NOT DISTINCT FROM $${params.length}`);
  } else {
    // No content_hash column exists. Two things could invalidate the embedding
    // we just built, and both must be guarded truthfully:
    //  (1) a concurrent write populated the embedding -> embedding IS NULL.
    //  (2) a concurrent source edit changed entity_type/name but left the
    //      embedding NULL -> snapshot each source column with IS NOT DISTINCT
    //      FROM its captured value (NULL-safe). If any changed, this UPDATE
    //      matches zero rows and we skip instead of writing a stale embedding.
    whereParts.push("embedding IS NULL");
    for (const col of target.sourceGuardColumns ?? []) {
      // Identifier is registry-static (allowlisted); the captured value is
      // parameterized. IS NOT DISTINCT FROM is NULL-safe so a genuinely-NULL
      // source column still matches its captured NULL.
      params.push(row[col] ?? null);
      whereParts.push(`${col} IS NOT DISTINCT FROM $${params.length}`);
    }
  }

  // Namespace guard on the UPDATE: an id-only mutation must not cross scope.
  // Bound via the FK column reference (namespaceVia) or the namespace column;
  // the namespace value list is parameterized. { global: true } emits none.
  const nsPredicate = namespacePredicate(target, scope, params);
  if (nsPredicate) whereParts.push(nsPredicate);

  const sql = `UPDATE ${target.table}
    SET ${sets.join(", ")}
    WHERE ${whereParts.join(" AND ")}`;

  return { sql, params };
}

export interface RepairBatchOptions extends SelectStaleOptions, RepairOptions {}

export interface RepairBatchSummary {
  table: string;
  selected: number;
  repaired: number;
  skipped: number;
  retryableFailures: number;
  permanentFailures: number;
  /** Rows whose fresh content_hash another row already holds (issue 1462). */
  contentHashCollisions: number;
  /**
   * Id of the last row the selection returned, or null when it returned none.
   * Pass it back as `afterId` to advance a keyset drain (issue 1612).
   */
  lastSelectedId: string | null;
  results: RepairResult[];
}

/**
 * Convenience: select a bounded batch of stale rows for one table and repair
 * each. Embeddings are still generated one row at a time OUTSIDE locks; there
 * is no long-held transaction spanning the batch. A queue (#343) may prefer to
 * drive `selectStale` + `repairOne` itself for per-unit receipts; this wrapper
 * is for scripts/backfill-style bulk runs.
 */
export async function repairStaleBatch(
  db: Queryable,
  table: string,
  embedFn: EmbedWithMetaFn = generateEmbeddingWithMetadata,
  options: RepairBatchOptions,
): Promise<RepairBatchSummary> {
  // Scope is validated up front so an entire batch cannot run unscoped; the
  // same options.scope flows to both selectStale and repairOne below.
  normalizeScope(options.scope);
  const { candidates, lastSelectedId } = await selectStaleWithCursor(
    db,
    table,
    options,
  );
  const results: RepairResult[] = [];
  let repaired = 0;
  let skipped = 0;
  let retryableFailures = 0;
  let permanentFailures = 0;
  let contentHashCollisions = 0;

  for (const candidate of candidates) {
    const result = await repairOne(db, candidate, embedFn, options);
    results.push(result);
    switch (result.status) {
      case "repaired":
        repaired += 1;
        break;
      case "skipped_source_changed":
      case "skipped_empty_text":
        skipped += 1;
        break;
      case "retryable_failure":
        retryableFailures += 1;
        break;
      case "permanent_failure":
        permanentFailures += 1;
        break;
      case "content_hash_collision":
        contentHashCollisions += 1;
        break;
    }
  }

  logger.info("embedding_repair_batch_done", {
    table,
    selected: candidates.length,
    repaired,
    skipped,
    retryableFailures,
    permanentFailures,
    contentHashCollisions,
  });

  return {
    table,
    selected: candidates.length,
    repaired,
    skipped,
    retryableFailures,
    permanentFailures,
    contentHashCollisions,
    lastSelectedId,
    results,
  };
}
