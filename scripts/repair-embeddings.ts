/**
 * Registry-wide stale-embedding backfill CLI (issue #724 item 1).
 *
 * WHY THIS EXISTS — the measured gap, not a guess.
 *
 * `docs/embedding-repair.md` ("Server-owned runtime and enqueue boundary")
 * states the design plainly: `src/maintenance-bootstrap.ts` starts the
 * `embedding.repair` runner, but the bootstrap "invents no namespace and
 * enqueues no job." Enqueue is deliberately an explicit, auth-scoped CALLER
 * boundary. Nothing in the repo occupies that caller position for a bulk
 * historical backlog, so unembedded rows are never drained by anything.
 *
 * Observed on the dogfood database 2026-08-17 (RUNNING, measured not inferred):
 *   - eligible-but-unembedded ob_session_lanes: 549, unchanged across a
 *     4-minute idle observation (549 -> 549);
 *   - `maintenance_jobs` has never held a single `embedding.repair` row
 *     (only `memory.distill` and `system.facts`), and had zero rows updated in
 *     the preceding 30 minutes.
 * The backlog does not self-drain. That is the defect this script closes.
 *
 * WHAT IT RIDES ON — no new pipeline, no new table, no new SQL.
 *
 *   src/embedding-repair.ts:682 `repairStaleBatch(...)` — the EXISTING bulk
 *     primitive, whose own docstring says it "is for scripts/backfill-style
 *     bulk runs." This script is exactly that caller and nothing more: it
 *     loops the documented primitive until a table reports no more candidates.
 *   src/embedding-targets.ts:326 `EMBEDDING_TARGET_NAMES` — the single table
 *     registry, read at runtime. A second hand-maintained copy of that list is
 *     the #433 defect class, so there is none here.
 *   src/embedding-repair.ts:163 `MAX_BATCH` — the primitive's own ceiling; the
 *     batch size is clamped by the primitive, not re-invented here.
 *   src/db/pool.ts `createPool()` and src/embedding.ts
 *     `generateEmbeddingWithMetadata` — the same pool and the same real
 *     provider the server uses. No alternate embedding path.
 *
 * Every safety property (namespace-bound reads AND guarded writes, embeddings
 * generated outside locks, idempotent convergence on replay, retryable vs
 * permanent failure classification, content-free logging) is the primitive's,
 * inherited unchanged. This file adds a loop, a CLI, and a summary.
 *
 * SCOPE IS MANDATORY AND EXPLICIT. `repairStaleBatch` refuses an unscoped run.
 * Pass either `--namespace <ns>` (repeatable) or the separately-named
 * `--global`. There is no default; omitting both is an error, never a silent
 * global run.
 *
 * NOTHING IS ADJUSTED SILENTLY (repo rule): every clamp, skip, and stop
 * condition this script applies is printed with the original and adjusted
 * value and the reason.
 *
 * Usage:
 *   bun run scripts/repair-embeddings.ts --namespace rico
 *   bun run scripts/repair-embeddings.ts --global --dry-run
 *   bun run scripts/repair-embeddings.ts --namespace rico --table ob_session_lanes
 *
 * Exit codes: 0 = ran to completion with no permanent failures;
 *             1 = a fatal error, or permanent per-row failures were recorded.
 */
import {
  repairStaleBatch,
  MAX_BATCH,
  type RepairScope,
  type StalenessReason,
} from "../src/embedding-repair.ts";
import { EMBEDDING_TARGET_NAMES } from "../src/embedding-targets.ts";
import { generateEmbeddingWithMetadata } from "../src/embedding.ts";
import { createPool } from "../src/db/pool.ts";
import { logger } from "../src/logger.ts";
import type pg from "pg";

export interface RepairRunOptions {
  scope: RepairScope;
  /** Tables to sweep. Default: the whole EMBEDDING_TARGETS registry. */
  tables?: string[];
  /** Rows per `repairStaleBatch` call. Clamped by the primitive to MAX_BATCH. */
  batchSize?: number;
  /**
   * Safety bound on total batches per table, so a row that is selected but
   * never repaired (e.g. a permanently empty-text row) cannot spin forever.
   */
  maxBatchesPerTable?: number;
  /** Report what would be selected without writing any embedding. */
  dryRun?: boolean;
  /**
   * Staleness reasons to select. Defaults to `["missing"]` — see the comment
   * at the `repairStaleBatch` call for why an all-reasons bulk drain does not
   * converge. Override with `--reason` only deliberately.
   */
  reasons?: StalenessReason[];
}

export interface RepairRunTableSummary {
  table: string;
  batches: number;
  selected: number;
  repaired: number;
  skipped: number;
  retryableFailures: number;
  permanentFailures: number;
  stoppedAtBatchBound: boolean;
}

export interface RepairRunSummary {
  tables: RepairRunTableSummary[];
  /** Tables whose drain aborted with a thrown error; see the try/catch above. */
  tableErrors: { table: string; error: string }[];
  repaired: number;
  permanentFailures: number;
  retryableFailures: number;
}

const DEFAULT_BATCHES_PER_TABLE = 100;

/**
 * Drain every requested table by looping the existing bulk primitive.
 *
 * The loop's stop condition is the primitive's own report: a batch that
 * SELECTS zero candidates means the table has nothing stale left. A batch that
 * selects rows but repairs none would otherwise re-select the same rows
 * forever, so that case also stops the table and is announced.
 */
export async function repairAll(
  db: Pick<pg.Pool, "query">,
  options: RepairRunOptions,
): Promise<RepairRunSummary> {
  const tables = options.tables ?? EMBEDDING_TARGET_NAMES;
  const requestedBatch = options.batchSize ?? MAX_BATCH;
  const batchSize = Math.min(requestedBatch, MAX_BATCH);
  if (batchSize !== requestedBatch) {
    console.log(
      `ADJUSTED batch size: ${requestedBatch} -> ${batchSize} (MAX_BATCH in src/embedding-repair.ts bounds a single selection)`,
    );
  }
  const maxBatches = options.maxBatchesPerTable ?? DEFAULT_BATCHES_PER_TABLE;

  const summaries: RepairRunTableSummary[] = [];
  const tableErrors: { table: string; error: string }[] = [];

  for (const table of tables) {
    const acc: RepairRunTableSummary = {
      table,
      batches: 0,
      selected: 0,
      repaired: 0,
      skipped: 0,
      retryableFailures: 0,
      permanentFailures: 0,
      stoppedAtBatchBound: false,
    };

    // ONE TABLE MUST NOT ABORT THE DRAIN. Observed 2026-08-17 on the dogfood
    // database: a leaked test fixture left a live BEFORE UPDATE trigger
    // `dream_bulk_release_trigger` on `thoughts` (from
    // src/tools/__tests__/bulk-set-tier.pg.test.ts) that RAISEs on every
    // update, so the first `thoughts` batch threw and killed a whole --global
    // run before the remaining tables were touched. That trigger is a separate
    // defect and this script does not drop it (destructive DDL is out of
    // scope); it only refuses to let it hide the other tables' backlogs. The
    // failing table is reported and the run's exit code reflects it.
    try {
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const result = await repairStaleBatch(
          db,
          table,
          options.dryRun
            ? // Dry run still exercises the REAL selection query, so the counts
              // are the primitive's own. It just never produces a vector:
              // `repairOne` sees a null embedding with an error and records a
              // failure instead of issuing the guarded UPDATE. Nothing is
              // mutated. `input_invalid` is chosen from the existing
              // EmbeddingError codes (src/embedding.ts:38) because it is
              // classified NON-retryable (RETRYABLE_CODES,
              // src/embedding-repair.ts:402) — a dry run must not look like a
              // transient provider outage.
              async () => ({
                embedding: null,
                error: {
                  code: "input_invalid" as const,
                  message: "dry run: no embedding generated",
                  attempts: 0,
                },
              })
            : generateEmbeddingWithMetadata,
          {
            scope: options.scope,
            limit: batchSize,
            // MEASURED, not assumed. `buildSelection` (src/embedding-repair.ts:250)
            // ORs the reasons into ONE unordered `SELECT ... LIMIT n`, and
            // source_drift's SQL arm is `embedding IS NOT NULL AND content_hash
            // IS NOT NULL` — i.e. rows that ALREADY have an embedding — with the
            // real hash comparison done in JS afterward. With every reason
            // enabled, a bounded batch is therefore mostly already-embedded rows
            // and the unembedded backlog is crowded out of the window: observed
            // 2026-08-17, limit=500 on ob_session_lanes returned 100 stale
            // candidates of mixed reason while 549 rows sat unembedded.
            // Because the query has no ORDER BY, repeated batches can return the
            // same rows and the drain would never converge.
            //
            // This CLI's job is the MISSING-embedding backlog specifically, so it
            // asks for that reason alone. Every selected row is then one the loop
            // can actually repair, which is what makes `repaired === 0` a
            // truthful stop condition. Drift repair remains the queue handler's
            // job (`embedding.repair`, src/embedding-repair-handler.ts) and is
            // deliberately NOT taken over here.
            reasons: options.reasons ?? ["missing"],
          },
        );

        acc.batches += 1;
        acc.selected += result.selected;
        acc.repaired += result.repaired;
        acc.skipped += result.skipped;
        acc.retryableFailures += result.retryableFailures;
        acc.permanentFailures += result.permanentFailures;

        if (result.selected === 0) break;

        if (options.dryRun) {
          console.log(
            `DRY RUN ${table}: ${result.selected} stale row(s) would be repaired (stopping after one batch; a dry run writes nothing so looping would re-select the same rows)`,
          );
          break;
        }

        if (result.repaired === 0) {
          console.log(
            `STOPPED ${table}: batch selected ${result.selected} row(s) but repaired 0 (skipped=${result.skipped} retryable=${result.retryableFailures} permanent=${result.permanentFailures}); looping again would re-select the same rows`,
          );
          break;
        }

        if (batch === maxBatches - 1) {
          acc.stoppedAtBatchBound = true;
          console.log(
            `STOPPED ${table}: hit the ${maxBatches}-batch safety bound with rows still selectable; re-run to continue`,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tableErrors.push({ table, error: message });
      console.log(
        `ERROR ${table}: batch aborted after repairing ${acc.repaired} row(s) — ${message}; continuing with the remaining tables`,
      );
    }

    summaries.push(acc);
    if (acc.selected > 0 || acc.repaired > 0) {
      console.log(
        `${table}: selected=${acc.selected} repaired=${acc.repaired} skipped=${acc.skipped} retryable=${acc.retryableFailures} permanent=${acc.permanentFailures} batches=${acc.batches}`,
      );
    }
  }

  return {
    tables: summaries,
    tableErrors,
    repaired: summaries.reduce((n, t) => n + t.repaired, 0),
    permanentFailures: summaries.reduce((n, t) => n + t.permanentFailures, 0),
    retryableFailures: summaries.reduce((n, t) => n + t.retryableFailures, 0),
  };
}

/** Parse argv into run options. Throws on a missing or contradictory scope. */
export function parseArgs(argv: string[]): RepairRunOptions {
  const namespaces: string[] = [];
  const tables: string[] = [];
  const reasons: StalenessReason[] = [];
  let global = false;
  let dryRun = false;
  let batchSize: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--namespace":
        namespaces.push(requireValue(argv, ++i, "--namespace"));
        break;
      case "--table":
        tables.push(requireValue(argv, ++i, "--table"));
        break;
      case "--reason": {
        const value = requireValue(argv, ++i, "--reason");
        if (
          value !== "missing" &&
          value !== "model_drift" &&
          value !== "source_drift"
        ) {
          throw new Error(
            `unknown reason '${value}'; valid: missing, model_drift, source_drift`,
          );
        }
        reasons.push(value);
        break;
      }
      case "--batch-size":
        batchSize = Number.parseInt(
          requireValue(argv, ++i, "--batch-size"),
          10,
        );
        break;
      case "--global":
        global = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (global && namespaces.length > 0) {
    throw new Error(
      "--global and --namespace are mutually exclusive; pick one scope explicitly",
    );
  }
  if (!global && namespaces.length === 0) {
    throw new Error(
      "a scope is REQUIRED: pass --namespace <ns> (repeatable) or --global. There is no unscoped default.",
    );
  }

  for (const table of tables) {
    if (!EMBEDDING_TARGET_NAMES.includes(table)) {
      throw new Error(
        `unknown table '${table}'; EMBEDDING_TARGETS declares: ${EMBEDDING_TARGET_NAMES.join(", ")}`,
      );
    }
  }

  return {
    scope: global ? { global: true } : { namespaces },
    tables: tables.length > 0 ? tables : undefined,
    batchSize:
      batchSize == null || Number.isNaN(batchSize) ? undefined : batchSize,
    reasons: reasons.length > 0 ? reasons : undefined,
    dryRun,
  };
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value == null || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

if (import.meta.main) {
  let options: RepairRunOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(
      `repair-embeddings: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Pool lifecycle belongs to the entrypoint, matching scripts/backfill.ts.
  const pool = createPool();
  try {
    const summary = await repairAll(pool, options);
    for (const { table, error } of summary.tableErrors) {
      console.log(`FAILED TABLE ${table}: ${error}`);
    }
    console.log(
      `repair-embeddings done: repaired=${summary.repaired} retryable=${summary.retryableFailures} permanent=${summary.permanentFailures} failedTables=${summary.tableErrors.length}`,
    );
    await pool.end();
    process.exit(
      summary.permanentFailures > 0 || summary.tableErrors.length > 0 ? 1 : 0,
    );
  } catch (err) {
    logger.error("repair_embeddings_fatal", {
      error: err instanceof Error ? err.message : String(err),
    });
    await pool.end().catch(() => {});
    process.exit(1);
  }
}
