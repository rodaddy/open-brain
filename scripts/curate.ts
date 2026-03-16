/**
 * Automated brain curation script.
 * Detects and handles: duplicates (HNSW nearest-neighbor), stale entries,
 * and vague/low-quality content via LLM-as-judge.
 *
 * Usage: bun run curate [--dry-run]
 *
 * Safe for cron -- idempotent (archived_at IS NULL prevents re-archiving).
 * Future: contradiction detection (semantic pair comparison) not yet implemented.
 */
import type pg from "pg";
import { toSql } from "pgvector/pg";
import { createPool } from "../src/db/pool.ts";
import { logger } from "../src/logger.ts";

type TableName =
  | "thoughts"
  | "decisions"
  | "relationships"
  | "projects"
  | "sessions";

const LITELLM_URL = process.env.LITELLM_URL ?? "http://10.71.1.33:4000";
const LLM_MODEL = process.env.CURATE_MODEL ?? "gpt-4o-mini";
const DUPLICATE_THRESHOLD = 0.08;
const STALE_DAYS = 90;
const BATCH_DELAY_MS = 200;
const DRY_RUN = process.argv.includes("--dry-run");
const TABLES: readonly TableName[] = [
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
] as const;

/** Content preview SQL per table (matches search-brain.ts CONTENT_PREVIEW) */
const CONTENT_PREVIEW: Record<TableName, string> = {
  thoughts: "content",
  decisions: "title || ': ' || rationale",
  relationships: "person_name || ': ' || COALESCE(context, '')",
  projects: "name || ': ' || COALESCE(description, '')",
  sessions: "COALESCE(project || ': ', '') || LEFT(summary, 200)",
};

// ---------------------------------------------------------------------------
// LLM Judge
// ---------------------------------------------------------------------------

async function llmJudge(prompt: string): Promise<string> {
  try {
    const response = await fetch(`${LITELLM_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      logger.warn("llm_judge_http_error", { status: response.status });
      return "SKIP";
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return json.choices?.[0]?.message?.content?.trim() ?? "SKIP";
  } catch (err) {
    logger.warn("llm_judge_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "SKIP";
  }
}

// ---------------------------------------------------------------------------
// Duplicate Detection (HNSW nearest-neighbor, O(n log n))
// ---------------------------------------------------------------------------

async function findDuplicates(
  pool: pg.Pool,
  table: TableName,
): Promise<number> {
  const preview = CONTENT_PREVIEW[table];
  let archived = 0;

  const { rows: entries } = await pool.query(
    `SELECT id, ${preview} AS content_preview, embedding
     FROM ${table}
     WHERE archived_at IS NULL AND embedding IS NOT NULL
     ORDER BY created_at ASC`,
  );

  if (entries.length < 2) return 0;

  const seen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.id)) continue;

    const { rows: neighbors } = await pool.query(
      `SELECT id AS neighbor_id, embedding <=> $1 AS distance
       FROM ${table}
       WHERE id != $2 AND archived_at IS NULL AND embedding IS NOT NULL
       ORDER BY embedding <=> $1 LIMIT 1`,
      [toSql(entry.embedding), entry.id],
    );

    if (neighbors.length === 0) continue;

    const neighbor = neighbors[0];
    if (Number(neighbor.distance) >= DUPLICATE_THRESHOLD) continue;

    // Sort IDs to avoid processing both (A,B) and (B,A)
    const pairKey = [entry.id, neighbor.neighbor_id].sort().join(":");
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    // Archive the older entry (current entry is older due to ORDER BY created_at ASC)
    const archiveId = entry.id;
    logger.info("duplicate_found", {
      table,
      archive_id: archiveId,
      keep_id: neighbor.neighbor_id,
      distance: neighbor.distance,
      dry_run: DRY_RUN,
    });

    if (!DRY_RUN) {
      await pool.query(
        `UPDATE ${table} SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL`,
        [archiveId],
      );
    }

    archived++;
    // Mark both as seen so we don't re-process the neighbor
    seen.add(entry.id);
    seen.add(neighbor.neighbor_id as string);
  }

  return archived;
}

// ---------------------------------------------------------------------------
// Stale Detection
// ---------------------------------------------------------------------------

interface StaleResult {
  archived: number;
  rated: number;
}

async function findStale(
  pool: pg.Pool,
  table: TableName,
): Promise<StaleResult> {
  const preview = CONTENT_PREVIEW[table];
  let archived = 0;
  let rated = 0;

  const { rows: staleEntries } = await pool.query(
    `SELECT id, ${preview} AS content_preview
     FROM ${table}
     WHERE archived_at IS NULL
       AND created_at < NOW() - INTERVAL '1 day' * $1
       AND access_count = 0
     LIMIT 50`,
    [STALE_DAYS],
  );

  for (const entry of staleEntries) {
    const verdict = await llmJudge(
      `Is this knowledge entry still potentially valuable? Entry: "${entry.content_preview}". Respond with KEEP, ARCHIVE, or DOWNGRADE.`,
    );

    const action = verdict.toUpperCase().trim();
    logger.info("stale_verdict", {
      table,
      id: entry.id,
      verdict: action,
      dry_run: DRY_RUN,
    });

    if (action.includes("ARCHIVE")) {
      if (!DRY_RUN) {
        await pool.query(
          `UPDATE ${table} SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL`,
          [entry.id],
        );
      }
      archived++;
    } else if (action.includes("DOWNGRADE")) {
      if (!DRY_RUN) {
        await pool.query(
          `UPDATE ${table} SET usefulness_score = 0.2 WHERE id = $1`,
          [entry.id],
        );
      }
      rated++;
    }
    // KEEP or SKIP: leave as-is

    await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
  }

  return { archived, rated };
}

// ---------------------------------------------------------------------------
// Vague Content Detection
// ---------------------------------------------------------------------------

async function findVague(pool: pg.Pool, table: TableName): Promise<number> {
  const preview = CONTENT_PREVIEW[table];
  let rated = 0;

  const { rows: vagueEntries } = await pool.query(
    `SELECT id, ${preview} AS content_preview
     FROM ${table}
     WHERE archived_at IS NULL
       AND (usefulness_score IS NULL OR usefulness_score < 0.3)
       AND array_length(tags, 1) IS NULL
     LIMIT 30`,
  );

  for (const entry of vagueEntries) {
    const scoreStr = await llmJudge(
      `Rate the quality and specificity of this knowledge entry on a scale of 0-1. Entry: "${entry.content_preview}". Respond with a number between 0.0 and 1.0 only.`,
    );

    const score = parseFloat(scoreStr);
    if (isNaN(score) || score < 0 || score > 1) {
      logger.warn("vague_score_parse_error", {
        table,
        id: entry.id,
        raw: scoreStr,
      });
      continue;
    }

    logger.info("vague_rated", {
      table,
      id: entry.id,
      score,
      dry_run: DRY_RUN,
    });

    if (!DRY_RUN) {
      await pool.query(
        `UPDATE ${table} SET usefulness_score = $1 WHERE id = $2`,
        [score, entry.id],
      );
    }

    rated++;
    await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
  }

  return rated;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function curate(poolOverride?: pg.Pool): Promise<void> {
  const pool = poolOverride ?? createPool();
  try {
    logger.info("curate_start", { dry_run: DRY_RUN });
    let totalArchived = 0;
    let totalRated = 0;

    for (const table of TABLES) {
      logger.info("curate_table_start", { table });

      const dupsArchived = await findDuplicates(pool, table);
      totalArchived += dupsArchived;

      const staleActions = await findStale(pool, table);
      totalArchived += staleActions.archived;
      totalRated += staleActions.rated;

      const vagueRated = await findVague(pool, table);
      totalRated += vagueRated;

      logger.info("curate_table_complete", {
        table,
        dupsArchived,
        staleArchived: staleActions.archived,
        staleDowngraded: staleActions.rated,
        vagueRated,
      });
    }

    logger.info("curate_complete", {
      totalArchived,
      totalRated,
      dry_run: DRY_RUN,
    });
  } finally {
    if (!poolOverride) {
      await pool.end();
    }
  }
}

if (import.meta.main) {
  curate().catch((err) => {
    logger.error("curate_error", { error: String(err) });
    process.exit(1);
  });
}
