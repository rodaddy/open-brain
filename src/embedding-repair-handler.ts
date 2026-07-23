/**
 * Server-owned maintenance-queue handler that drives stale-embedding repair.
 *
 * Issue #345. This is the piece that plugs the reusable detection/repair
 * primitives in `src/embedding-repair.ts` into the real, server-owned
 * `MaintenanceQueueRunner` from #343 (`src/maintenance-queue.ts`). The runner
 * dispatches a claimed job to the handler registered under its `kind`; this
 * module builds exactly one such handler, for kind `embedding.repair`.
 *
 * Contract with the runner (see MaintenanceQueueRunner.execute):
 *  - The handler receives the leased `MaintenanceJob`. If it RESOLVES, the runner
 *    marks the job succeeded. If it THROWS, the runner records a failure and the
 *    durable retry policy re-queues with backoff (or dead-letters at the bound).
 *  - Therefore a transient/retryable provider outage must surface as a THROW so
 *    the queue re-delivers; a permanent per-unit failure must NOT throw (it would
 *    never succeed on retry and would burn the whole batch job to dead_letter),
 *    it is recorded content-free and the job resolves.
 *
 * Idempotency / no-op-on-replay:
 *  - The repair primitives are convergent: repairing an already-repaired unit
 *    with unchanged source issues a guarded UPDATE that lands the identical
 *    vector/hash/model. After a batch fully repairs a table, a later replay of
 *    the same job re-runs `selectStale`, which now finds nothing stale, and the
 *    handler resolves with an all-zero summary — a true no-op. At-least-once
 *    delivery from the queue is safe.
 *
 * Namespace scope:
 *  - Every job payload MUST carry an explicit scope: a non-empty auth-derived
 *    `{ namespaces: [...] }` or the separately named `{ global: true }`. There is
 *    no unscoped default; a payload without a valid scope fails validation and
 *    the job dead-letters as a permanent (non-retryable) input error. Scope flows
 *    unchanged into `selectStale`/`repairOne`, which bind it on BOTH the read and
 *    the guarded write.
 *
 * Provider/model:
 *  - Repair uses the current configured embedding provider/model (embedding.ts).
 *    It never selects a new model. Model-drift detection compares against the
 *    current `EMBEDDING_MODEL`; the payload cannot request a different model.
 *
 * Telemetry:
 *  - Content-free. Every log line carries counts and the target table only —
 *    never source text, embed input, or namespace values.
 */
import { z } from "zod";
import type pg from "pg";
import { generateEmbeddingWithMetadata, EMBEDDING_MODEL } from "./embedding.ts";
import {
  repairStaleBatch,
  MAX_BATCH,
  DEFAULT_BATCH,
  type EmbedWithMetaFn,
  type RepairBatchSummary,
  type StalenessReason,
} from "./embedding-repair.ts";
import { EMBEDDING_TARGET_NAMES } from "./embedding-targets.ts";
import type {
  MaintenanceJob,
  MaintenanceJobHandler,
  MaintenanceQueueLogger,
} from "./maintenance-queue.ts";

/** Registered job kind for stale-embedding repair. Immutable identity. */
export const EMBEDDING_REPAIR_JOB_KIND = "embedding.repair";
/** Payload contract version. Bump only on a breaking payload-shape change. */
export const EMBEDDING_REPAIR_JOB_VERSION = 1;

const STALENESS_REASONS = [
  "missing",
  "model_drift",
  "source_drift",
] as const satisfies readonly StalenessReason[];

/**
 * Namespace scope on the job payload. Mirrors `RepairScope` in
 * embedding-repair.ts but validated here at the queue boundary: a non-empty
 * auth-derived allowlist, or the explicit intentionally-global marker. There is
 * no unscoped default — a payload lacking one of these two shapes is rejected.
 */
const scopeSchema = z.union([
  z.object({
    namespaces: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    global: z.literal(true),
  }),
]);

/**
 * The `embedding.repair` job payload. `table` is allowlisted to the embedding
 * target registry (never interpolated raw). `limit` is bounded to the same
 * ceiling the primitive clamps to, so an oversized payload cannot drain the
 * pool/provider. `reasons` is optional; omitted means "all detectable reasons
 * for the table". `scope` is mandatory and explicit.
 */
export const embeddingRepairPayloadSchema = z.object({
  table: z.enum(EMBEDDING_TARGET_NAMES as [string, ...string[]]),
  scope: scopeSchema,
  reasons: z.array(z.enum(STALENESS_REASONS)).min(1).optional(),
  limit: z.number().int().min(1).max(MAX_BATCH).optional(),
});

export type EmbeddingRepairPayload = z.infer<
  typeof embeddingRepairPayloadSchema
>;

export interface EmbeddingRepairHandlerDeps {
  /** Pool or client the repair reads/writes through. */
  db: Pick<pg.Pool | pg.PoolClient, "query">;
  /** Content-free logger (the runner's logger is the natural argument). */
  logger: MaintenanceQueueLogger;
  /** Injectable embed fn for tests; defaults to the configured provider. */
  embedFn?: EmbedWithMetaFn;
  /** Current model treated as canonical; defaults to the configured model. */
  currentModel?: string;
  /** Provider URL override (defaults to the configured endpoint). */
  embeddingUrl?: string;
}

/**
 * A payload that fails schema validation is a permanent input error: retrying it
 * unchanged can never succeed, so it must dead-letter rather than loop. We tag
 * such errors so the handler can decide (it currently just rethrows — the runner
 * dead-letters after the bound; the tag documents intent and lets callers/tests
 * distinguish an invalid payload from a transient provider outage).
 */
export class EmbeddingRepairPayloadError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingRepairPayloadError";
  }
}

/** Version guard: an unknown payload version is a permanent input error. */
function assertSupportedVersion(job: MaintenanceJob): void {
  if (job.version !== EMBEDDING_REPAIR_JOB_VERSION) {
    throw new EmbeddingRepairPayloadError(
      `unsupported embedding.repair payload version ${job.version}`,
    );
  }
}

function parsePayload(job: MaintenanceJob): EmbeddingRepairPayload {
  const parsed = embeddingRepairPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    // Content-free: never echo the payload values, only that it was invalid.
    throw new EmbeddingRepairPayloadError(
      "invalid embedding.repair payload (see schema)",
    );
  }
  return parsed.data;
}

/**
 * Build the single `embedding.repair` handler for the maintenance runner.
 *
 * The returned handler:
 *  1. Validates payload version + shape (permanent error → dead-letter).
 *  2. Runs one bounded, namespace-scoped `repairStaleBatch` for the target table.
 *  3. Emits a content-free summary (counts + table only).
 *  4. THROWS iff at least one unit hit a *retryable* provider failure, so the
 *     queue re-delivers and those units are retried (already-repaired units
 *     no-op on the replay). Permanent per-unit failures do not throw.
 *
 * A fully-repaired table replays to `selected: 0` and resolves — a true no-op.
 */
export function createEmbeddingRepairHandler(
  deps: EmbeddingRepairHandlerDeps,
): MaintenanceJobHandler {
  const embedFn = deps.embedFn ?? generateEmbeddingWithMetadata;
  const currentModel = deps.currentModel ?? EMBEDDING_MODEL;

  return async function embeddingRepairHandler(
    job: MaintenanceJob,
  ): Promise<void> {
    assertSupportedVersion(job);
    const payload = parsePayload(job);

    let summary: RepairBatchSummary;
    try {
      summary = await repairStaleBatch(deps.db, payload.table, embedFn, {
        scope: payload.scope,
        reasons: payload.reasons,
        limit: payload.limit ?? DEFAULT_BATCH,
        currentModel,
        embeddingUrl: deps.embeddingUrl,
      });
    } catch (error) {
      // A thrown scope/registry error here is a permanent input problem (an
      // unscoped or unknown-target payload that slipped a shape check). Surface
      // it content-free; the runner dead-letters after the retry bound.
      deps.logger.error("embedding_repair_job_input_error", {
        job_kind: job.kind,
        table: payload.table,
      });
      throw error;
    }

    // Content-free: counts and the target table name only.
    deps.logger.info("embedding_repair_job_done", {
      job_kind: job.kind,
      table: summary.table,
      selected: summary.selected,
      repaired: summary.repaired,
      skipped: summary.skipped,
      retryable_failures: summary.retryableFailures,
      permanent_failures: summary.permanentFailures,
    });

    // Retryable provider failures mean some units could not be repaired due to a
    // transient outage. Throw so the queue re-delivers with backoff; the replay
    // re-selects only the still-stale units (repaired ones no-op) until the
    // provider recovers or the job hits its retry bound and dead-letters.
    if (summary.retryableFailures > 0) {
      throw new Error(
        `embedding repair deferred: ${summary.retryableFailures} unit(s) hit a retryable provider failure`,
      );
    }
    // Resolving here marks the job succeeded. Permanent per-unit failures were
    // already recorded content-free by the primitive and do not re-queue.
  };
}

/**
 * Convenience: build the runner's `handlers` map with the embedding-repair
 * handler registered under its kind. The `MaintenanceQueueRunner` takes a
 * `ReadonlyMap<string, MaintenanceJobHandler>`; this returns exactly that with
 * the single #345 handler wired in. Additional server-owned handlers can be
 * merged by the bootstrap before constructing the runner.
 */
export function buildEmbeddingRepairHandlers(
  deps: EmbeddingRepairHandlerDeps,
): ReadonlyMap<string, MaintenanceJobHandler> {
  return new Map<string, MaintenanceJobHandler>([
    [EMBEDDING_REPAIR_JOB_KIND, createEmbeddingRepairHandler(deps)],
  ]);
}
