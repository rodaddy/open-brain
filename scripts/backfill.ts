/**
 * Backfill embeddings for rows that have NULL embedding columns.
 * Processes all 5 domain tables: thoughts, decisions, relationships, projects, sessions.
 */
import type pg from "pg";
import { toSql } from "pgvector/pg";
import { createPool } from "../src/db/pool.ts";
import {
  generateEmbedding,
  contentHash,
  EMBEDDING_MODEL,
} from "../src/embedding.ts";
import { logger } from "../src/logger.ts";

type EmbedFn = (text: string) => Promise<number[] | null>;

interface TableConfig {
  table: string;
  /** Columns to fetch -- projecting instead of SELECT * keeps the existing
   * 768-dim vectors (and other wide columns) out of JS memory on --all runs. */
  columns: string[];
  textFn: (row: Record<string, unknown>) => string;
}

const TABLE_CONFIGS: TableConfig[] = [
  {
    table: "thoughts",
    columns: ["id", "content"],
    textFn: (row) => row.content as string,
  },
  {
    table: "decisions",
    columns: ["id", "title", "rationale"],
    textFn: (row) => `${row.title}\n${row.rationale}`,
  },
  {
    table: "relationships",
    columns: ["id", "person_name", "context", "notes"],
    textFn: (row) =>
      [row.person_name, row.context, row.notes].filter(Boolean).join("\n"),
  },
  {
    table: "projects",
    columns: ["id", "name", "description"],
    textFn: (row) => [row.name, row.description].filter(Boolean).join("\n"),
  },
  {
    table: "sessions",
    columns: ["id", "summary"],
    textFn: (row) => row.summary as string,
  },
];

// Per-row delay -- default 150ms is politeness for shared/cloud embedding
// providers. Set BACKFILL_DELAY_MS=0 for a dedicated local provider.
const rawDelay = parseInt(process.env.BACKFILL_DELAY_MS ?? "150", 10);
const DELAY_MS = Number.isNaN(rawDelay) || rawDelay < 0 ? 150 : rawDelay;

// Concurrent embed workers -- default 1 preserves sequential behavior.
// Capped at 8 to stay under the pg pool max (10).
const rawConcurrency = parseInt(process.env.BACKFILL_CONCURRENCY ?? "1", 10);
const CONCURRENCY =
  Number.isNaN(rawConcurrency) || rawConcurrency < 1
    ? 1
    : Math.min(rawConcurrency, 8);

interface BackfillResult {
  processed: number;
  failed: number;
}

interface BackfillOptions {
  all?: boolean;
}

export async function backfill(
  pool: pg.Pool,
  embedFn: EmbedFn,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  let totalProcessed = 0;
  let totalFailed = 0;
  const whereClause = options.all ? "" : " WHERE embedding IS NULL";

  for (const { table, columns, textFn } of TABLE_CONFIGS) {
    // table/columns come from the static TABLE_CONFIGS allowlist above, never
    // from user input -- interpolation is safe here.
    const { rows } = await pool.query(
      `SELECT ${columns.join(", ")} FROM ${table}${whereClause}`,
    );

    logger.info(`Backfill: ${table}`, {
      nullCount: rows.length,
      mode: options.all ? "all" : "missing",
    });

    // Worker pool over a shared cursor -- single-threaded JS makes the
    // `next++` claim race-free; workers overlap embed round-trips.
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const row = rows[next++];
        const text = textFn(row);
        const embedding = await embedFn(text);

        if (!embedding) {
          totalFailed++;
          continue;
        }

        const hash = contentHash(text);
        try {
          await pool.query(
            `UPDATE ${table}
             SET embedding = $1, content_hash = $2, embedded_at = NOW(), embedding_model = $3
             WHERE id = $4`,
            [toSql(embedding), hash, EMBEDDING_MODEL, row.id],
          );
        } catch (err) {
          // One bad row (e.g. content_hash unique-constraint collision on
          // duplicate content) must not kill the whole backfill.
          totalFailed++;
          logger.warn("Backfill row update failed", {
            table,
            id: row.id,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        totalProcessed++;

        if (DELAY_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        }
      }
    };

    const workerCount = Math.max(1, Math.min(CONCURRENCY, rows.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  logger.info("Backfill complete", { totalProcessed, totalFailed });

  return { processed: totalProcessed, failed: totalFailed };
}

if (import.meta.main) {
  // Pool lifecycle belongs to the entrypoint, not backfill() -- callers that
  // pass a shared pool keep it alive.
  const pool = createPool();
  try {
    const result = await backfill(pool, generateEmbedding, {
      all: process.argv.includes("--all") || process.argv.includes("--force"),
    });
    logger.info("Backfill finished", {
      processed: result.processed,
      failed: result.failed,
    });
    await pool.end();
    process.exit(0);
  } catch (err) {
    logger.error("Backfill fatal error", {
      error: err instanceof Error ? err.message : String(err),
    });
    await pool.end().catch(() => {});
    process.exit(1);
  }
}
