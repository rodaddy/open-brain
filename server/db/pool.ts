/**
 * PostgreSQL pool ownership boundary.
 *
 * Design authority: `docs/code-brain-design.md` section 2 distinguishes code
 * that exists from runtime assertions; health is an explicit observable probe.
 */
import pg from "pg";
import type { Logger } from "pino";
import type { ServerConfig } from "../config.ts";

export interface DatabaseHealth {
  readonly connected: boolean;
  readonly total: number;
  readonly idle: number;
  readonly waiting: number;
  readonly errorCategory?: string;
}

export interface DatabasePool {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface Database {
  readonly pool: DatabasePool;
  close(): Promise<void>;
  health(): Promise<DatabaseHealth>;
}

function errorCategory(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}

/** Own an already-created pool, including health, error, and close behavior. */
export function ownDatabasePool(pool: DatabasePool, logger: Logger): Database {
  pool.on("error", (error) => {
    logger.error({ error_category: errorCategory(error) }, "database_pool_error");
  });
  return {
    pool,
    close: () => pool.end(),
    health: async () => {
      try {
        await pool.query("SELECT 1");
        return {
          connected: true,
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        };
      } catch (error: unknown) {
        logger.error({ error_category: errorCategory(error) }, "database_health_failed");
        return {
          connected: false,
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
          errorCategory: errorCategory(error),
        };
      }
    },
  };
}

/** Create the sole owner of a configured PostgreSQL pool. */
export function createDatabase(
  config: ServerConfig["database"],
  logger: Logger,
): Database {
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    ...(config.password ? { password: config.password } : {}),
    max: config.maxConnections,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
  });
  return ownDatabasePool(pool, logger);
}
