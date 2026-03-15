import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { logger } from "../logger.ts";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

export async function runMigrations(
  pool: pg.Pool,
  migrationsDir?: string,
): Promise<string[]> {
  const dir = migrationsDir ?? MIGRATIONS_DIR;

  // Ensure _migrations table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         SERIAL PRIMARY KEY,
      filename   TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Read and sort migration files
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  // Get already-applied migrations
  const { rows: applied } = await pool.query(
    "SELECT filename FROM _migrations",
  );
  const appliedSet = new Set(applied.map((r) => r.filename as string));

  const newlyApplied: string[] = [];

  for (const file of files) {
    if (appliedSet.has(file)) {
      logger.info("Migration already applied, skipping", { file });
      continue;
    }

    const sql = await readFile(join(dir, file), "utf-8");
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [
        file,
      ]);
      await client.query("COMMIT");
      newlyApplied.push(file);
      logger.info("Migration applied", { file });
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error("Migration failed", {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      client.release();
    }
  }

  return newlyApplied;
}
