import pg from "pg";
import pgvector from "pgvector/pg";
import { logger } from "../logger.ts";
import type { PoolHealth } from "../types.ts";

export function createPool(overrides?: Partial<pg.PoolConfig>): pg.Pool {
  const pool = new pg.Pool({
    host: process.env.DB_HOST || "10.71.20.49",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "open_brain",
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    maxUses: 7500,
    ...overrides,
  });

  pool.on("connect", async (client) => {
    await pgvector.registerTypes(client);
  });

  pool.on("error", (err) => {
    logger.error("Unexpected pool error", { error: err.message });
  });

  return pool;
}

export async function checkPoolHealth(pool: pg.Pool): Promise<PoolHealth> {
  try {
    await pool.query("SELECT 1");
    return {
      connected: true,
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };
  } catch {
    return { connected: false, total: 0, idle: 0, waiting: 0 };
  }
}
