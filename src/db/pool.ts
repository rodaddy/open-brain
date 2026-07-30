import pg from "pg";
import pgvector from "pgvector/pg";
import { logger } from "../logger.ts";
import { describeError } from "../observability/index.ts";
import type { PoolHealth } from "../types.ts";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createPool(overrides?: Partial<pg.PoolConfig>): pg.Pool {
  const host = process.env.DB_HOST;
  if (!host) throw new Error("DB_HOST environment variable is required");
  const user = process.env.DB_USER;
  if (!user) throw new Error("DB_USER environment variable is required");

  const pool = new pg.Pool({
    host,
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "open_brain",
    user,
    password: process.env.DB_PASSWORD,
    max: parsePositiveInt(process.env.DB_POOL_MAX, 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    maxUses: 7500,
    statement_timeout: 30000,
    ...overrides,
  });

  pool.on("connect", async (client) => {
    try {
      await pgvector.registerTypes(client);
    } catch (err) {
      // Stable event name, not a sentence: Loki filters on `message`, so the
      // remediation text moves into a field where it does not fragment the
      // query surface. The pg fields come along now -- an extension that is
      // absent and one the role may not use report different SQLSTATEs.
      logger.error("pgvector_registration_failed", {
        impact: "vector operations will not work",
        remediation: "install the pgvector extension (CREATE EXTENSION vector)",
        ...describeError(err),
      });
    }
  });

  pool.on("error", (err) => {
    logger.error("pool_error", describeError(err));
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
  } catch (error) {
    // The most-consulted health signal in the system, and it threw away the one
    // fact anybody wants: WHY. "connected: false" was returned identically for a
    // refused connection, a password failure, an exhausted pool, and a database
    // in recovery. The pg fields distinguish all four.
    //
    // The returned shape stays as it was -- callers and the doctor contract
    // depend on it -- except that the counts are reported as observed rather
    // than as zeros. A pool with 10 connections and a failing probe has 10
    // connections; claiming 0 invented a fact.
    logger.error("pool_health_check_failed", {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      ...describeError(error),
    });
    return {
      connected: false,
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };
  }
}
