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
 *   bun run scripts/repair-embeddings.ts --namespace dana
 *   bun run scripts/repair-embeddings.ts --global --dry-run
 *   bun run scripts/repair-embeddings.ts --namespace dana --table ob_session_lanes
 *
 * Exit codes: 0 = ran to completion with no permanent failures;
 *             1 = a fatal error, or permanent per-row failures were recorded.
 */
import {
  repairStaleBatch,
  MAX_BATCH,
  EMBEDDING_TARGET_NAMES,
  generateEmbeddingWithMetadata,
  createPool,
  logger,
  type RepairScope,
  type StalenessReason,
} from "./settings.ts";
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
  /** Embedder for a real run. Default: the server's provider. Tests inject a fake. */
  embedFn?: typeof generateEmbeddingWithMetadata;
}

export interface RepairRunTableSummary {
  table: string;
  batches: number;
  selected: number;
  repaired: number;
  skipped: number;
  retryableFailures: number;
  permanentFailures: number;
  /** Rows skipped because another row already holds their fresh content_hash. */
  contentHashCollisions: number;
  stoppedAtBatchBound: boolean;
}

export interface RepairRunSummary {
  tables: RepairRunTableSummary[];
  /** Tables whose drain aborted with a thrown error; see the try/catch above. */
  tableErrors: { table: string; error: string }[];
  repaired: number;
  permanentFailures: number;
  retryableFailures: number;
  contentHashCollisions: number;
}

const DEFAULT_BATCHES_PER_TABLE = 100;

/**
 * Dry run still exercises the REAL selection query, so the counts are the
 * primitive's own. It just never produces a vector: `repairOne` sees a null
 * embedding with an error and records a failure instead of issuing the guarded
 * UPDATE. Nothing is mutated. `input_invalid` is chosen from the existing
 * EmbeddingError codes (server/embedding/provider.ts) because it is classified
 * NON-retryable (RETRYABLE_CODES, server/embedding/embedding-repair.ts) — a dry
 * run must not look like a transient provider outage.
 */
async function dryRunEmbedder() {
  return {
    embedding: null,
    error: {
      code: "input_invalid" as const,
      message: "dry run: no embedding generated",
      attempts: 0,
    },
  };
}

/**
 * Drain one table, accumulating into `acc`, advancing a keyset cursor by id.
 * Returns once a batch selects no row after the cursor (the end of the
 * keyset), after one dry-run batch, or at the batch-count safety bound.
 */
async function drainTable(
  db: Pick<pg.Pool, "query">,
  acc: RepairRunTableSummary,
  options: RepairRunOptions,
  loop: { batchSize: number; maxBatches: number },
): Promise<void> {
  const { table } = acc;
  const { batchSize, maxBatches } = loop;
  let cursor: string | null = null;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await repairStaleBatch(
      db,
      table,
      options.dryRun
        ? dryRunEmbedder
        : (options.embedFn ?? generateEmbeddingWithMetadata),
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
        // KEYSET CURSOR (issue 1612). The unordered selection described above
        // re-selected the same rows, so a batch that repaired none (all
        // content_hash collisions, issue 1462) ended the table while
        // repairable rows waited behind it: measured 2026-09-28, 1,396
        // repairable sessions rows never got a turn behind 9,752 collisions.
        // Each batch now selects `id > <previous batch's last id>` in id
        // order, starting from null (the start of the keyset), so the drain
        // advances past rows it cannot repair and ends only when the keyset
        // is exhausted.
        afterId: cursor,
      },
    );
    cursor = result.lastSelectedId;

    acc.batches += 1;
    acc.selected += result.selected;
    acc.repaired += result.repaired;
    acc.skipped += result.skipped;
    acc.retryableFailures += result.retryableFailures;
    acc.permanentFailures += result.permanentFailures;
    acc.contentHashCollisions += result.contentHashCollisions;

    // End of the keyset: the SELECT returned no row after the cursor.
    if (cursor === null) break;

    if (options.dryRun) {
      console.log(
        `DRY RUN ${table}: ${result.selected} stale row(s) would be repaired (stopping after one batch; a dry run writes nothing so looping would re-select the same rows)`,
      );
      break;
    }

    // No `repaired === 0` stop: with the cursor, a batch that repaired none
    // (all collisions, skips, or failures) is not re-selected; the next batch
    // starts after it (issue 1612).

    if (batch === maxBatches - 1) {
      acc.stoppedAtBatchBound = true;
      console.log(
        `STOPPED ${table}: hit the ${maxBatches}-batch safety bound with rows still selectable; re-run to continue`,
      );
    }
  }
}

function emptySummary(table: string): RepairRunTableSummary {
  return {
    table,
    batches: 0,
    selected: 0,
    repaired: 0,
    skipped: 0,
    retryableFailures: 0,
    permanentFailures: 0,
    contentHashCollisions: 0,
    stoppedAtBatchBound: false,
  };
}

/**
 * Drain every requested table by looping the existing bulk primitive.
 *
 * The loop walks each table by a keyset cursor on id and stops when a batch
 * selects no row after the cursor: every stale row has had one turn. A batch
 * that repairs none does not stop the table, because the cursor has already
 * moved past its rows (issue 1612).
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
      `ADJUSTED batch size: ${requestedBatch} -> ${batchSize} (MAX_BATCH in server/embedding/embedding-repair.ts bounds a single selection)`,
    );
  }
  const maxBatches = options.maxBatchesPerTable ?? DEFAULT_BATCHES_PER_TABLE;

  const summaries: RepairRunTableSummary[] = [];
  const tableErrors: { table: string; error: string }[] = [];

  for (const table of tables) {
    const acc = emptySummary(table);

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
      await drainTable(db, acc, options, { batchSize, maxBatches });
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
        `${table}: selected=${acc.selected} repaired=${acc.repaired} skipped=${acc.skipped} retryable=${acc.retryableFailures} permanent=${acc.permanentFailures} collisions=${acc.contentHashCollisions} batches=${acc.batches}`,
      );
    }
  }

  return {
    tables: summaries,
    tableErrors,
    repaired: summaries.reduce((n, t) => n + t.repaired, 0),
    permanentFailures: summaries.reduce((n, t) => n + t.permanentFailures, 0),
    retryableFailures: summaries.reduce((n, t) => n + t.retryableFailures, 0),
    contentHashCollisions: summaries.reduce((n, t) => n + t.contentHashCollisions, 0),
  };
}

interface ParsedFlags {
  namespaces: string[];
  tables: string[];
  reasons: StalenessReason[];
  global: boolean;
  dryRun: boolean;
  batchSize?: number;
}

function asReason(value: string): StalenessReason {
  if (value !== "missing" && value !== "model_drift" && value !== "source_drift") {
    throw new Error(
      `unknown reason '${value}'; valid: missing, model_drift, source_drift`,
    );
  }
  return value;
}

/**
 * Apply one flag at `index`, returning the index of the last argv element it
 * consumed so the caller advances past a flag's value.
 */
function applyFlag(argv: string[], index: number, acc: ParsedFlags): number {
  // `argv[index]` is `string | undefined` to the type checker. An out-of-range
  // index reached the `default` arm below and threw `unknown argument:
  // undefined`; narrowing here throws the identical message from one arm the
  // exhaustiveness check can see, leaving the switch over a plain `string`.
  const arg = argv[index];
  if (arg === undefined) throw new Error("unknown argument: undefined");
  switch (arg) {
    case "--namespace":
      acc.namespaces.push(requireValue(argv, index + 1, "--namespace"));
      return index + 1;
    case "--table":
      acc.tables.push(requireValue(argv, index + 1, "--table"));
      return index + 1;
    case "--reason":
      acc.reasons.push(asReason(requireValue(argv, index + 1, "--reason")));
      return index + 1;
    case "--batch-size":
      acc.batchSize = Number.parseInt(
        requireValue(argv, index + 1, "--batch-size"),
        10,
      );
      return index + 1;
    case "--global":
      acc.global = true;
      return index;
    case "--dry-run":
      acc.dryRun = true;
      return index;
    default:
      throw new Error(`unknown argument: ${arg}`);
  }
}

/** The scope and table checks, which are errors rather than silent defaults. */
function validateFlags(acc: ParsedFlags): void {
  if (acc.global && acc.namespaces.length > 0) {
    throw new Error(
      "--global and --namespace are mutually exclusive; pick one scope explicitly",
    );
  }
  if (!acc.global && acc.namespaces.length === 0) {
    throw new Error(
      "a scope is REQUIRED: pass --namespace <ns> (repeatable) or --global. There is no unscoped default.",
    );
  }
  for (const table of acc.tables) {
    if (!EMBEDDING_TARGET_NAMES.includes(table)) {
      throw new Error(
        `unknown table '${table}'; EMBEDDING_TARGETS declares: ${EMBEDDING_TARGET_NAMES.join(", ")}`,
      );
    }
  }
}

/** Parse argv into run options. Throws on a missing or contradictory scope. */
export function parseArgs(argv: string[]): RepairRunOptions {
  const acc: ParsedFlags = {
    namespaces: [],
    tables: [],
    reasons: [],
    global: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    i = applyFlag(argv, i, acc);
  }

  validateFlags(acc);

  const { batchSize } = acc;
  return {
    scope: acc.global ? { global: true } : { namespaces: acc.namespaces },
    tables: acc.tables.length > 0 ? acc.tables : undefined,
    batchSize: batchSize == null || Number.isNaN(batchSize) ? undefined : batchSize,
    reasons: acc.reasons.length > 0 ? acc.reasons : undefined,
    dryRun: acc.dryRun,
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
      `repair-embeddings done: repaired=${summary.repaired} retryable=${summary.retryableFailures} permanent=${summary.permanentFailures} collisions=${summary.contentHashCollisions} failedTables=${summary.tableErrors.length}`,
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
