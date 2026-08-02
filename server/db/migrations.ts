/**
 * Append-only migration runner for the existing `src/db/migrations` ledger.
 *
 * Design authority: `docs/code-brain-design.md` section 7 preserves sequencing;
 * `docs/sme/correctness.md` requires exact-prefix history validation and
 * cross-worker serialization before applying the existing sorted SQL files.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Pool } from "pg";

const LEGACY_MIGRATION_REPLACEMENTS = new Map([
  ["005_fts_hybrid", "005_fts_hybrid.sql"],
  ["010_chunking.sql", "011_chunking.sql"],
]);

function normalizedHistory(
  appliedFiles: readonly string[],
  repositoryFiles: readonly string[],
): readonly string[] | undefined {
  if (new Set(appliedFiles).size !== appliedFiles.length) return undefined;
  const repositorySet = new Set(repositoryFiles);
  const appliedSet = new Set(appliedFiles);
  const normalized = new Set<string>();
  for (const file of appliedFiles) {
    const replacement = LEGACY_MIGRATION_REPLACEMENTS.get(file);
    if (!replacement) {
      normalized.add(file);
      continue;
    }
    if (!repositorySet.has(replacement) || !appliedSet.has(replacement)) return undefined;
  }
  return [...normalized].sort();
}

/** Return the unapplied suffix, rejecting unknown or interleaved history. */
export function pendingMigrationFiles(
  appliedFiles: readonly string[],
  repositoryFiles: readonly string[],
): readonly string[] {
  const repository = [...repositoryFiles].sort();
  const applied = normalizedHistory(appliedFiles, repository);
  if (!applied) throw new Error("database_migration_history_unknown");
  const repositorySet = new Set(repository);
  if (applied.some((file) => !repositorySet.has(file))) {
    throw new Error("database_migration_history_unknown");
  }
  if (applied.some((file, index) => file !== repository[index])) {
    throw new Error("database_migration_history_interleaved");
  }
  return repository.slice(applied.length);
}

/** Apply the valid unapplied suffix once across all workers. */
export async function runMigrations(
  pool: Pool,
  migrationsDirectory: string,
  logger: Logger,
): Promise<readonly string[]> {
  const client = await pool.connect();
  let lockHeld = false;
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext(current_database() || ':' || current_schema() || ':openbrain-migrations'))",
    );
    lockHeld = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql"));
    const appliedRows = await client.query<{ filename: string }>("SELECT filename FROM _migrations");
    const pending = pendingMigrationFiles(appliedRows.rows.map((row) => row.filename), files);
    const newlyApplied: string[] = [];
    for (const file of pending) {
      try {
        await client.query("BEGIN");
        await client.query(await readFile(join(migrationsDirectory, file), "utf8"));
        await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        newlyApplied.push(file);
        logger.info({ file }, "database_migration_applied");
      } catch (error: unknown) {
        await client.query("ROLLBACK");
        logger.error(
          { file, error_category: error instanceof Error ? error.name : typeof error },
          "database_migration_failed",
        );
        throw error;
      }
    }
    return newlyApplied;
  } finally {
    try {
      if (lockHeld) await client.query("SELECT pg_advisory_unlock(hashtext(current_database() || ':' || current_schema() || ':openbrain-migrations'))");
    } finally {
      client.release();
    }
  }
}
