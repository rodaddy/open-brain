/**
 * Shared stale-embedding detection and idempotent repair primitives.
 *
 * These are building blocks -- not a queue handler and not a migration. Issue
 * #343's spool/queue handler wires `repairOne` per unit; #345 (this module)
 * only provides the reusable detection + repair logic and its tests.
 *
 * Design invariants:
 *  - Embeddings are generated OUTSIDE any DB transaction/lock. The SELECT that
 *    picks candidates and the UPDATE that writes the vector are separate round
 *    trips; the provider round trip happens between them with no lock held.
 *  - The UPDATE is guarded on a TRUTHFUL source column. For targets with
 *    content_hash, the guard is the stored hash OBSERVED at selection: the
 *    UPDATE writes the FRESH hash of the source we embedded but only lands while
 *    the stored content_hash still equals what we observed (NULL-safe, so a
 *    never-hashed missing row and a genuinely source-drifted row both repair).
 *    If a concurrent edit re-embedded the row (moving its stored hash off the
 *    observed value) between SELECT and UPDATE, the guarded UPDATE matches zero
 *    rows and we skip -- never clobbering a newer embedding. For targets WITHOUT
 *    content_hash (ob_entities), the only detectable staleness is a missing
 *    embedding, so the guard is `embedding IS NULL`: we fill only a still-empty
 *    slot and a concurrent write that already populated it wins. We never
 *    fabricate a content_hash/provenance column that does not exist.
 *  - Namespace scope is EXPLICIT and mandatory on every read/write -- omission
 *    is not a scope. Callers pass either a non-empty auth-derived
 *    { namespaces: [...] } (the safe path, bound on BOTH the SELECT and the
 *    guarded UPDATE) or the separately named { global: true } (an intentional
 *    global-role choice). Tables with a namespace column bind it directly;
 *    tables isolated via a foreign key (ob_session_events -> ob_session_lanes)
 *    bind it through that FK. An id-only read or write can never cross a
 *    namespace boundary, and there is no unscoped default.
 *  - Targets WITHOUT content_hash (ob_entities) additionally snapshot-guard
 *    their real source columns (sourceGuardColumns) with IS NOT DISTINCT FROM,
 *    so a concurrent source edit that leaves the embedding NULL cannot be
 *    clobbered by an embedding built from the stale snapshot.
 *  - Duplicate delivery converges: repairing the same unit twice with unchanged
 *    source yields the same stored vector/hash/model and the second call is a
 *    no-op-equivalent (idempotent). A provider failure leaves the row untouched.
 *  - Provider failures are classified into retryable vs. permanent, content-free
 *    (code + counts only, never source text) so a queue can decide re-delivery.
 *
 * Staleness reasons, in priority order:
 *  - "missing"       embedding IS NULL
 *  - "model_drift"   stored embedding_model <> current model (needs the column)
 *  - "source_drift"  stored content_hash <> hash(current source) (needs column)
 * A target lacking the backing column cannot report the reasons that depend on
 * it (see EmbeddingTarget.provenance); those rows are simply not selected for
 * that reason, and no fabricated column is written.
 */
import type pg from "pg";
import { toSql } from "pgvector/pg";
import {
  EMBEDDING_MODEL,
  generateEmbeddingWithMetadata,
  type EmbeddingError,
  type EmbeddingOptions,
} from "./embedding.ts";
import {
  getEmbeddingTarget,
  type EmbeddingTarget,
  type TargetRow,
} from "./embedding-targets.ts";
import { logger } from "./logger.ts";

/** Minimal queryable surface -- a pg.Pool or pg.PoolClient both satisfy this. */
export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/** Signature of the metadata-returning embed function (injectable for tests). */
export type EmbedWithMetaFn = (
  text: string,
  embeddingUrl?: string,
  options?: EmbeddingOptions,
) => Promise<{ embedding: number[] | null; error?: EmbeddingError }>;

export type StalenessReason = "missing" | "model_drift" | "source_drift";

/**
 * Every read/write must declare its namespace scope EXPLICITLY -- omission is
 * not a scope. Issue #345 and repo isolation law require every id-based read or
 * mutation to carry an auth-derived namespace predicate; a global scope is
 * permitted only when the caller INTENTIONALLY authorizes it, never by leaving
 * a field unset.
 *
 * - `{ namespaces: [...] }` is the safe, mandatory path: a NON-EMPTY,
 *   auth-derived namespace allowlist. Both selection and the guarded UPDATE bind
 *   it (directly or via the target FK), so an id-only read or write can never
 *   cross a namespace boundary. An empty list is a caller error (fail closed).
 * - `{ global: true }` is a separately named, explicit intentionally-global
 *   path for a global-role caller (e.g. an admin backfill). It emits NO
 *   namespace predicate -- and it is a distinct, self-documenting choice at the
 *   call site, not an accidental default.
 *
 * There is no unscoped default: `selectStale` / `repairOne` / `repairStaleBatch`
 * require a scope and reject a missing or empty-namespace scope.
 */
export type RepairScope = { namespaces: readonly string[] } | { global: true };

/**
 * Validate and normalize a caller-supplied scope. Rejects a missing scope and a
 * namespaces list that is empty or contains blank entries -- an empty/blank
 * scope must never silently degrade to "all namespaces". Returns either the
 * explicit global marker or the vetted non-empty namespace list.
 */
function normalizeScope(
  scope: RepairScope | undefined,
): { global: true } | { namespaces: string[] } {
  if (!scope) {
    throw new Error(
      "namespace scope is required: pass { namespaces: [...] } (auth-derived, non-empty) or the explicit { global: true }",
    );
  }
  if ("global" in scope && scope.global === true) {
    return { global: true };
  }
  const namespaces = "namespaces" in scope ? scope.namespaces : undefined;
  if (!Array.isArray(namespaces) || namespaces.length === 0) {
    throw new Error(
      "scope.namespaces must be a non-empty auth-derived list; use { global: true } to intentionally run unscoped",
    );
  }
  const cleaned = namespaces.filter(
    (ns) => typeof ns === "string" && ns.trim().length > 0,
  );
  if (cleaned.length === 0) {
    throw new Error(
      "scope.namespaces contained no usable namespace values; refusing to run unscoped",
    );
  }
  return { namespaces: cleaned };
}

/** A single row selected for repair, with why it was selected. */
export interface RepairCandidate {
  table: string;
  id: string;
  /** Reasons this row is stale (subset of the runtime-detectable reasons). */
  reasons: StalenessReason[];
  /** Full projected source row -- used to build embed text and the guard hash. */
  row: TargetRow;
}

export interface SelectStaleOptions {
  /** Which staleness reasons to select. Default: all detectable for the table. */
  reasons?: StalenessReason[];
  /** Max rows to return. Bounded; see MAX_BATCH. Default DEFAULT_BATCH. */
  limit?: number;
  /** Model string treated as "current" for model-drift. Default EMBEDDING_MODEL. */
  currentModel?: string;
  /**
   * REQUIRED namespace scope. Either a non-empty auth-derived
   * `{ namespaces: [...] }` (the safe path) or the explicit
   * `{ global: true }`. There is no unscoped default; a missing or empty scope
   * throws. See {@link RepairScope}.
   */
  scope: RepairScope;
  /** Restrict to a single id (e.g. queue single-unit repair). */
  id?: string;
}

/** Hard ceiling on a single selection batch -- protects the pool and provider. */
export const MAX_BATCH = 500;
/** Default batch size when the caller does not specify a limit. */
export const DEFAULT_BATCH = 100;

function clampLimit(limit: number | undefined): number {
  if (limit == null || Number.isNaN(limit) || limit < 1) return DEFAULT_BATCH;
  return Math.min(Math.floor(limit), MAX_BATCH);
}

/**
 * Build the auth-derived namespace predicate for a target, appending the
 * namespace VALUE list to `params` and returning the SQL fragment. Shared by
 * selection and the guarded UPDATE so both bind the same isolation boundary.
 *
 * - `namespaceColumn` targets bind `<col> = ANY($n::text[])` directly.
 * - `namespaceVia` targets (no own namespace column) bind through the FK with a
 *   correlated EXISTS against the parent table's namespace column. All table /
 *   column identifiers are registry-static (allowlisted); only the namespace
 *   value list is parameterized.
 * - A target with NEITHER binding cannot be namespace-scoped: supplying a
 *   namespace list is a caller error and we FAIL CLOSED (throw) rather than
 *   silently returning or mutating cross-namespace rows.
 *
 * Takes an already-normalized scope (see normalizeScope). Returns `null` ONLY
 * for the explicit `{ global: true }` scope -- an intentional global-role
 * choice -- never as a silent default. A `{ namespaces: [...] }` scope is
 * guaranteed non-empty by normalization, so a namespace predicate is always
 * emitted for it.
 */
function namespacePredicate(
  target: EmbeddingTarget,
  scope: { global: true } | { namespaces: string[] },
  params: unknown[],
): string | null {
  if ("global" in scope) return null;
  const { namespaces } = scope;

  if (target.namespaceColumn) {
    params.push(namespaces);
    return `${target.namespaceColumn} = ANY($${params.length}::text[])`;
  }

  if (target.namespaceVia) {
    const via = target.namespaceVia;
    params.push(namespaces);
    // Correlated EXISTS: the row's FK must point at a parent row whose
    // namespace is in the auth-derived list. Identifiers are registry-static.
    return `EXISTS (SELECT 1 FROM ${via.table} __ns
      WHERE __ns.${via.remoteKey} = ${target.table}.${via.localKey}
        AND __ns.${via.namespaceColumn} = ANY($${params.length}::text[]))`;
  }

  // No namespace binding exists for this target. A namespace list was supplied,
  // so returning unscoped rows would break isolation -- fail closed instead.
  throw new Error(
    `Cannot namespace-scope target ${target.table}: no namespace column or FK binding`,
  );
}

/**
 * Which staleness reasons a target can actually detect at runtime given the
 * columns that physically exist. `missing` is always available (every target
 * has an `embedding` column). `model_drift` / `source_drift` require their
 * backing column; requesting one for a table that lacks it is silently dropped
 * -- we never fabricate a column or invent provenance.
 */
export function detectableReasons(target: EmbeddingTarget): StalenessReason[] {
  const reasons: StalenessReason[] = ["missing"];
  if (target.provenance.hasEmbeddingModel) reasons.push("model_drift");
  if (target.provenance.hasContentHash) reasons.push("source_drift");
  return reasons;
}

interface SelectionPlan {
  sql: string;
  params: unknown[];
  reasons: StalenessReason[];
}

/**
 * Build the parameterized SELECT that finds stale rows for one target. The
 * `missing` predicate is pure SQL; `model_drift` is pure SQL against the current
 * model. `source_drift` cannot be expressed in SQL alone (the hash formula lives
 * in JS), so the query fetches candidates whose embedding exists and JS filters
 * by recomputed hash afterward. All identifiers come from the static target
 * allowlist; every value is parameterized.
 */
function buildSelection(
  target: EmbeddingTarget,
  options: SelectStaleOptions,
): SelectionPlan {
  const requested = options.reasons ?? detectableReasons(target);
  const detectable = detectableReasons(target);
  const reasons = requested.filter((r) => detectable.includes(r));
  if (reasons.length === 0) {
    // Nothing detectable for this target with the requested reasons.
    return { sql: "", params: [], reasons: [] };
  }

  const currentModel = options.currentModel ?? EMBEDDING_MODEL;
  const params: unknown[] = [];
  const orClauses: string[] = [];

  const wantMissing = reasons.includes("missing");
  const wantModelDrift = reasons.includes("model_drift");
  const wantSourceDrift = reasons.includes("source_drift");

  if (wantMissing) {
    orClauses.push("embedding IS NULL");
  }
  if (wantModelDrift) {
    params.push(currentModel);
    // A row with an embedding whose model no longer matches. NULL model on a
    // present embedding also counts as drifted (unknown provenance).
    orClauses.push(
      `(embedding IS NOT NULL AND (embedding_model IS DISTINCT FROM $${params.length}))`,
    );
  }
  if (wantSourceDrift) {
    // SQL can only narrow to rows that HAVE an embedding and content_hash; the
    // exact hash comparison is done in JS after projection (formula is JS-side).
    orClauses.push("(embedding IS NOT NULL AND content_hash IS NOT NULL)");
  }

  const filters: string[] = [`(${orClauses.join(" OR ")})`];
  if (target.baseFilterSql) filters.push(target.baseFilterSql);

  if (options.id) {
    params.push(options.id);
    filters.push(`${target.idColumn} = $${params.length}`);
  }
  // Scope is mandatory and explicit (non-empty namespaces or { global: true });
  // normalizeScope throws on a missing/empty scope before any query is built.
  const scope = normalizeScope(options.scope);
  const nsPredicate = namespacePredicate(target, scope, params);
  if (nsPredicate) filters.push(nsPredicate);

  const limit = clampLimit(options.limit);
  params.push(limit);
  const limitParam = `$${params.length}`;

  const cols = target.selectColumns.join(", ");
  // Also project content_hash / embedding_model when they exist so JS can
  // finalize source_drift and annotate reasons without re-querying.
  const extra: string[] = [];
  if (target.provenance.hasContentHash) extra.push("content_hash");
  if (target.provenance.hasEmbeddingModel) extra.push("embedding_model");
  extra.push("(embedding IS NULL) AS __embedding_missing");
  const projection = [cols, ...extra].join(", ");

  const sql = `SELECT ${projection}
    FROM ${target.table}
    WHERE ${filters.join(" AND ")}
    LIMIT ${limitParam}`;

  return { sql, params, reasons };
}

/**
 * Select stale-embedding candidates for a single target table.
 * Generates NO embeddings and holds NO lock -- pure detection.
 */
export async function selectStale(
  db: Queryable,
  table: string,
  options: SelectStaleOptions,
): Promise<RepairCandidate[]> {
  const target = getEmbeddingTarget(table);
  const plan = buildSelection(target, options);
  if (!plan.sql) return [];

  const { rows } = await db.query(plan.sql, plan.params);
  const currentModel = options.currentModel ?? EMBEDDING_MODEL;

  const candidates: RepairCandidate[] = [];
  for (const raw of rows as TargetRow[]) {
    const row = raw;
    const reasons: StalenessReason[] = [];
    const missing = row.__embedding_missing === true;

    if (plan.reasons.includes("missing") && missing) {
      reasons.push("missing");
    }
    if (!missing) {
      if (
        plan.reasons.includes("model_drift") &&
        target.provenance.hasEmbeddingModel
      ) {
        const storedModel = (row.embedding_model as string | null) ?? null;
        if (storedModel !== currentModel) reasons.push("model_drift");
      }
      if (
        plan.reasons.includes("source_drift") &&
        target.provenance.hasContentHash
      ) {
        const storedHash = (row.content_hash as string | null) ?? null;
        const freshHash = target.sourceHash(row);
        if (storedHash !== null && storedHash !== freshHash) {
          reasons.push("source_drift");
        }
      }
    }

    if (reasons.length === 0) continue;
    candidates.push({ table, id: String(row[target.idColumn]), reasons, row });
  }

  return candidates;
}

/** Terminal disposition of a single repair attempt. */
export type RepairStatus =
  | "repaired" // vector written (or converged on identical state)
  | "skipped_source_changed" // guard matched zero rows -- concurrent edit won
  | "skipped_empty_text" // nothing to embed (empty canonical text)
  | "retryable_failure" // provider transient -- safe to re-deliver
  | "permanent_failure"; // provider/input permanent -- do not blindly retry

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
  const result = await embedFn(embedText, options.embeddingUrl, {
    signal: options.signal,
  });

  if (!result.embedding) {
    const code = result.error?.code;
    const retryable = code !== undefined && RETRYABLE_CODES.has(code);
    // Content-free: code + ids only, never the embed text.
    logger.warn("embedding_repair_provider_failure", {
      table: candidate.table,
      id,
      code: code ?? "unknown",
      retryable,
    });
    return {
      table: candidate.table,
      id,
      status: retryable ? "retryable_failure" : "permanent_failure",
      errorCode: code,
      updated: false,
    };
  }

  const currentModel = options.currentModel ?? EMBEDDING_MODEL;
  const { sql, params } = buildGuardedUpdate(
    target,
    candidate.row,
    id,
    result.embedding,
    freshHash,
    observedHash,
    currentModel,
    scope,
  );

  const { rowCount } = await db.query(sql, params);
  if ((rowCount ?? 0) === 0) {
    // Row vanished, was archived, or its source changed since selection.
    logger.info("embedding_repair_guard_no_match", {
      table: candidate.table,
      id,
    });
    return {
      table: candidate.table,
      id,
      status: "skipped_source_changed",
      updated: false,
    };
  }

  return { table: candidate.table, id, status: "repaired", updated: true };
}

/**
 * Build the idempotent, guarded UPDATE for one row. Only provenance columns
 * that physically exist on the target are written -- no fabricated provenance.
 *
 * The WHERE clause carries a TRUTHFUL no-overwrite guard so a raced concurrent
 * edit never gets its newer embedding clobbered:
 *  - content_hash targets SET the fresh source hash but GUARD on the hash
 *    OBSERVED at selection (`content_hash IS NOT DISTINCT FROM $observed`,
 *    NULL-safe). A missing row (observed NULL) fills; a source-drifted row
 *    (observed = the stale stored hash) repairs and writes the fresh hash; a row
 *    a concurrent writer re-embedded (stored hash moved off the observed value)
 *    misses and is skipped. Guarding on the fresh hash would break drift repair.
 *  - targets WITHOUT content_hash (ob_entities) guard on `embedding IS NULL`
 *    PLUS a snapshot of the actual source columns (`sourceGuardColumns`, each
 *    bound `<col> IS NOT DISTINCT FROM $captured`). `embedding IS NULL` alone
 *    prevents clobbering a concurrent embedding write, but NOT writing an
 *    embedding built from stale entity_type/name after a concurrent source edit
 *    that left the embedding NULL; the source-column snapshot closes that gap.
 *    These are real, physically present columns -- not an invented provenance
 *    guard.
 *
 * The scope guard binds namespace (directly or via the target FK) for a
 * `{ namespaces: [...] }` scope so an id-only UPDATE cannot escape the
 * auth-derived scope; `{ global: true }` emits none. `row` is the SAME snapshot
 * that was embedded, so the captured source-column values are exactly what the
 * embedding was generated from.
 */
function buildGuardedUpdate(
  target: EmbeddingTarget,
  row: TargetRow,
  id: string,
  embedding: number[],
  freshHash: string,
  observedHash: string | null,
  currentModel: string,
  scope: { global: true } | { namespaces: string[] },
): { sql: string; params: unknown[] } {
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
  const candidates = await selectStale(db, table, options);
  const results: RepairResult[] = [];
  let repaired = 0;
  let skipped = 0;
  let retryableFailures = 0;
  let permanentFailures = 0;

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
    }
  }

  logger.info("embedding_repair_batch_done", {
    table,
    selected: candidates.length,
    repaired,
    skipped,
    retryableFailures,
    permanentFailures,
  });

  return {
    table,
    selected: candidates.length,
    repaired,
    skipped,
    retryableFailures,
    permanentFailures,
    results,
  };
}
