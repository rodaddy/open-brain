import { createPool } from "./settings.ts";
import { runMigrations } from "../server/db/migrate.ts";
import { logger } from "./settings.ts";

async function main(): Promise<void> {
  // No pgvector registration here: DDL never reads vector values, and on a
  // fresh database the extension does not exist until a migration creates it
  // (issue 1515).
  const pool = createPool(undefined, { registerVectorTypes: false });

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

void main();
