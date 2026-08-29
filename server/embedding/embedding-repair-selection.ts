/**
 * Stale-embedding DETECTION for one target table: scope validation, the
 * namespace predicate shared with the guarded UPDATE, the selection query
 * builder, and the JS-side finalization of source_drift.
 *
 * Generates NO embeddings and holds NO lock. The repair half of the primitive
 * (repairOne / repairStaleBatch and the guarded UPDATE) lives in
 * ./embedding-repair.ts and consumes what this module selects.
 */
import { EMBEDDING_MODEL } from "../../src/embedding.ts";
import {
  getEmbeddingTarget,
  type EmbeddingTarget,
  type TargetRow,
} from "./embedding-targets.ts";
import { logger } from "../../src/logger.ts";
import { undecidableCanonicalFields } from "./embedding-canonical.ts";
import type { Queryable } from "./embedding-repair-model.ts";

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
export function normalizeScope(
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
export function namespacePredicate(
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
 * The per-reason SQL disjuncts a selection narrows on, appending any bound
 * values to `params`. `missing` and `model_drift` are pure SQL; `source_drift`
 * can only be narrowed here (rows that HAVE an embedding and a content_hash) —
 * the exact hash comparison is JS-side and happens after projection.
 */
function stalenessOrClauses(
  reasons: StalenessReason[],
  currentModel: string,
  params: unknown[],
): string[] {
  const orClauses: string[] = [];
  if (reasons.includes("missing")) {
    orClauses.push("embedding IS NULL");
  }
  if (reasons.includes("model_drift")) {
    params.push(currentModel);
    // A row with an embedding whose model no longer matches. NULL model on a
    // present embedding also counts as drifted (unknown provenance).
    orClauses.push(
      `(embedding IS NOT NULL AND (embedding_model IS DISTINCT FROM $${params.length}))`,
    );
  }
  if (reasons.includes("source_drift")) {
    orClauses.push("(embedding IS NOT NULL AND content_hash IS NOT NULL)");
  }
  return orClauses;
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
  const orClauses = stalenessOrClauses(reasons, currentModel, params);

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
 * Decide whether a row with an existing embedding has drifted from its source.
 * A hash mismatch is only drift when the canonical text can be trusted: when a
 * text[]/jsonb field arrives as damaged JSON text, coerceStringArray collapses
 * it to [] and the recomputed hash is missing content the writer hashed -- so
 * the mismatch is an artifact of the damage, not evidence the source changed.
 * Treating it as drift re-embedded and re-keyed the row on every pass, forever,
 * and never said why.
 */
function hasSourceDrift(
  target: EmbeddingTarget,
  table: string,
  row: TargetRow,
): boolean {
  const storedHash = (row.content_hash as string | null) ?? null;
  if (storedHash === null || storedHash === target.sourceHash(row)) {
    return false;
  }
  const undecidable = undecidableCanonicalFields(row as Record<string, unknown>);
  if (undecidable.length === 0) return true;
  logger.warn("embedding_repair_row_undecodable", {
    table,
    id: String(row[target.idColumn]),
    // Field NAMES only -- the values are the row's own content.
    undecidable_fields: undecidable,
    detail: "hash mismatch not treated as source_drift; canonical text is incomplete",
  });
  return false;
}

/** Classify one projected row into the staleness reasons it actually exhibits. */
function rowReasons(
  target: EmbeddingTarget,
  table: string,
  row: TargetRow,
  plan: { reasons: StalenessReason[]; currentModel: string },
): StalenessReason[] {
  const reasons: StalenessReason[] = [];
  if (row.__embedding_missing === true) {
    if (plan.reasons.includes("missing")) reasons.push("missing");
    return reasons;
  }
  const modelDrifted =
    plan.reasons.includes("model_drift") &&
    target.provenance.hasEmbeddingModel &&
    ((row.embedding_model as string | null) ?? null) !== plan.currentModel;
  if (modelDrifted) reasons.push("model_drift");
  const sourceDrifted =
    plan.reasons.includes("source_drift") &&
    target.provenance.hasContentHash &&
    hasSourceDrift(target, table, row);
  if (sourceDrifted) reasons.push("source_drift");
  return reasons;
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
  for (const row of rows as TargetRow[]) {
    const reasons = rowReasons(target, table, row, {
      reasons: plan.reasons,
      currentModel,
    });
    if (reasons.length === 0) continue;
    candidates.push({ table, id: String(row[target.idColumn]), reasons, row });
  }

  return candidates;
}
