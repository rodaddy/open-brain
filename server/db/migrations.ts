/**
 * Append-only migration runner for the existing `src/db/migrations` ledger.
 *
 * Design authority: `docs/code-brain-design.md` section 7 preserves sequencing;
 * this runner consumes the existing sorted SQL files without rewriting them.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Pool } from "pg";

/** Apply each previously-unrecorded top-level SQL migration transactionally. */
export async function runMigrations(
  pool: Pool,
  migrationsDirectory: string,
  logger: Logger,
): Promise<readonly string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const appliedRows = await pool.query<{ filename: string }>("SELECT filename FROM _migrations");
  const applied = new Set(appliedRows.rows.map((row) => row.filename));
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(await readFile(join(migrationsDirectory, file), "utf8"));
      await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      newlyApplied.push(file);
      logger.info({ file }, "database_migration_applied");
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      logger.error({ file, error_category: error instanceof Error ? error.name : typeof error }, "database_migration_failed");
      throw error;
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}
