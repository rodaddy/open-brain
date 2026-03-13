/**
 * Backfill embeddings for rows that have NULL embedding columns.
 * Processes all 5 domain tables: thoughts, decisions, relationships, projects, sessions.
 */
import type pg from "pg";
import { toSql } from "pgvector/pg";
import { createPool } from "../src/db/pool.ts";
import { generateEmbedding, contentHash } from "../src/embedding.ts";
import { logger } from "../src/logger.ts";

type EmbedFn = (text: string) => Promise<number[] | null>;

interface TableConfig {
  table: string;
  textFn: (row: Record<string, unknown>) => string;
}

const TABLE_CONFIGS: TableConfig[] = [
  {
    table: "thoughts",
    textFn: (row) => row.content as string,
  },
  {
    table: "decisions",
    textFn: (row) => `${row.title}\n${row.rationale}`,
  },
  {
    table: "relationships",
    textFn: (row) =>
      [row.person_name, row.context, row.notes].filter(Boolean).join("\n"),
  },
  {
    table: "projects",
    textFn: (row) => [row.name, row.description].filter(Boolean).join("\n"),
  },
  {
    table: "sessions",
    textFn: (row) => row.summary as string,
  },
];

const EMBEDDING_MODEL = "embeddings";

interface BackfillResult {
  processed: number;
  failed: number;
}

export async function backfill(
  pool: pg.Pool,
  embedFn: EmbedFn,
): Promise<BackfillResult> {
  let totalProcessed = 0;
  let totalFailed = 0;

  for (const { table, textFn } of TABLE_CONFIGS) {
    const { rows } = await pool.query(
      `SELECT * FROM ${table} WHERE embedding IS NULL`,
    );

    logger.info(`Processing ${table}`, { nullCount: rows.length });

    for (const row of rows) {
      const text = textFn(row);
      const embedding = await embedFn(text);

      if (!embedding) {
        totalFailed++;
        continue;
      }

      const hash = contentHash(text);
      await pool.query(
        `UPDATE ${table}
         SET embedding = $1, content_hash = $2, embedded_at = NOW(), embedding_model = $3
         WHERE id = $4`,
        [toSql(embedding), hash, EMBEDDING_MODEL, row.id],
      );

      totalProcessed++;
    }
  }

  logger.info("Backfill complete", { totalProcessed, totalFailed });

  await pool.end();

  return { processed: totalProcessed, failed: totalFailed };
}
