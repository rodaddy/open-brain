import { createPool } from "../src/db/pool.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { logger } from "../src/logger.ts";

async function main(): Promise<void> {
  const pool = createPool();

  try {
    const applied = await runMigrations(pool);
    if (applied.length === 0) {
      logger.info("No new migrations to apply");
    } else {
      logger.info("Migrations complete", {
        count: applied.length,
        files: applied,
      });
    }
  } catch (err) {
    logger.error("Migration failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
