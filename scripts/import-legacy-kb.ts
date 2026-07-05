#!/usr/bin/env bun
/**
 * Import legacy KB JSON files into Open Brain.
 * Reads decisions-v2.json, learnings-v2.json, patterns-v2.json
 * from ~/.config/pai-private/knowledge/
 * Inserts into decisions and thoughts tables (without embeddings).
 * Run `bun run backfill` afterward to generate embeddings.
 */
import type pg from "pg";
import { createPool } from "../src/db/pool.ts";
import { contentHash } from "../src/embedding.ts";
import { logger } from "../src/logger.ts";
import { sharedNamespaceConfig } from "../src/shared-namespace.ts";

interface LegacyEntry {
  date: string;
  lastSeen: string;
  occurrences: number;
  weight: number;
  title: string;
  summary: string;
  tags: string[];
  context?: string;
  outcome?: string;
  rootCause?: string;
  impact?: string;
}

const KB_DIR = `${process.env.HOME}/.config/pai-private/knowledge`;
const LEGACY_IMPORT_NAMESPACE = sharedNamespaceConfig().sharedNamespace;

function safeDate(dateStr: string): Date {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date() : d;
}

function isNoise(entry: LegacyEntry): boolean {
  const t = entry.title.trim();
  if (!t || t.startsWith("# ")) return true;
  if (t.toLowerCase().includes("no reusable patterns identified")) return true;
  if (t.toLowerCase().startsWith("i need to ")) return true;
  if (entry.weight < 20) return true;
  return false;
}

function buildThoughtContent(entry: LegacyEntry): string {
  const parts = [entry.title];
  if (entry.summary && entry.summary !== entry.title) parts.push(entry.summary);
  if (entry.context) parts.push(`Context: ${entry.context}`);
  if (entry.outcome) parts.push(`Outcome: ${entry.outcome}`);
  if (entry.rootCause && !entry.rootCause.trim().startsWith("N/A"))
    parts.push(`Root Cause: ${entry.rootCause}`);
  return parts.join("\n\n");
}

async function importDecisions(
  pool: pg.Pool,
): Promise<{ imported: number; skipped: number }> {
  const raw = await Bun.file(`${KB_DIR}/decisions-v2.json`).text();
  const entries: LegacyEntry[] = JSON.parse(raw);
  let imported = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (isNoise(entry)) {
      skipped++;
      continue;
    }
    const rationale =
      entry.summary && entry.summary !== entry.title
        ? entry.summary
        : entry.title;
    if (!rationale) {
      skipped++;
      continue;
    }
    const text = `${entry.title}\n${rationale}`;
    const hash = contentHash(text);

    const { rowCount } = await pool.query(
      `INSERT INTO decisions (title, rationale, tags, context, created_by, created_at, namespace, content_hash)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8
       WHERE NOT EXISTS (SELECT 1 FROM decisions WHERE namespace = $7 AND content_hash = $8)`,
      [
        entry.title,
        rationale,
        entry.tags || [],
        `Legacy import. Weight: ${entry.weight}, Occurrences: ${entry.occurrences}`,
        "legacy-import",
        safeDate(entry.date),
        LEGACY_IMPORT_NAMESPACE,
        hash,
      ],
    );
    if (rowCount && rowCount > 0) imported++;
    else skipped++;
  }

  return { imported, skipped };
}

async function importThoughts(
  pool: pg.Pool,
  filePath: string,
  source: string,
): Promise<{ imported: number; skipped: number }> {
  const raw = await Bun.file(filePath).text();
  const entries: LegacyEntry[] = JSON.parse(raw);
  let imported = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (isNoise(entry)) {
      skipped++;
      continue;
    }
    const content = buildThoughtContent(entry);
    const hash = contentHash(content);

    const { rowCount } = await pool.query(
      `INSERT INTO thoughts (content, tags, source, created_by, created_at, namespace, content_hash)
       SELECT $1, $2, $3, $4, $5, $6, $7
       WHERE NOT EXISTS (SELECT 1 FROM thoughts WHERE namespace = $6 AND content_hash = $7)`,
      [
        content,
        entry.tags || [],
        source,
        "legacy-import",
        safeDate(entry.date),
        LEGACY_IMPORT_NAMESPACE,
        hash,
      ],
    );
    if (rowCount && rowCount > 0) imported++;
    else skipped++;
  }

  return { imported, skipped };
}

if (import.meta.main) {
  const pool = createPool();
  try {
    logger.info("Starting legacy KB import");

    const decisions = await importDecisions(pool);
    logger.info("Decisions imported", decisions);

    const learnings = await importThoughts(
      pool,
      `${KB_DIR}/learnings-v2.json`,
      "legacy-learning",
    );
    logger.info("Learnings imported", learnings);

    const patterns = await importThoughts(
      pool,
      `${KB_DIR}/patterns-v2.json`,
      "legacy-pattern",
    );
    logger.info("Patterns imported", patterns);

    const total = {
      imported: decisions.imported + learnings.imported + patterns.imported,
      skipped: decisions.skipped + learnings.skipped + patterns.skipped,
    };
    logger.info(
      "Import complete -- run 'bun run backfill' for embeddings",
      total,
    );
  } catch (err) {
    logger.error("Import failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  } finally {
    await pool.end();
  }
}
