/**
 * Direct `pg.Pool` construction and health probing for callers that own a raw
 * pool rather than the `Database` boundary in `./pool.ts`.
 *
 * The connection settings arrive as one `PoolSettings` parameter instead of
 * being read from the environment here: `.oxlintrc.json` permits `process.env`
 * only at the composition root, and the doctor already receives its values
 * through `OperatorDoctorOptions`. The legacy zero-argument call form lives on
 * in the legacy pool adapter carried across in the L5 move (issue 864).
 */
import pg from "pg";
import pgvector from "pgvector/pg";
import { logger } from "../logging/legacy-logger.ts";
import { describeError } from "../observability/log-surface.ts";
import type { PoolHealth } from "../types.ts";

/** The connection settings `createPool` used to read from the environment. */
export interface PoolSettings {
  /** `DB_HOST`; the caller rejects a blank value before calling. */
  readonly host: string;
  /** `DB_PORT`, already parsed. */
  readonly port: number;
  /** `DB_NAME`. */
  readonly database: string;
  /** `DB_USER`; the caller rejects a blank value before calling. */
  readonly user: string;
  /** `DB_PASSWORD`, absent when the role authenticates without one. */
  readonly password?: string;
  /** `DB_POOL_MAX`, already parsed to a positive integer. */
  readonly max: number;
}

async function registerVectorTypes(client: pg.ClientBase): Promise<void> {
  await pgvector.registerTypes(client).catch((err: unknown) => {
    // Stable event name, not a sentence: Loki filters on `message`, so the
    // remediation text moves into a field where it does not fragment the
    // query surface. The pg fields come along now -- an extension that is
    // absent and one the role may not use report different SQLSTATEs.
    logger.error("pgvector_registration_failed", {
      impact: "vector operations will not work",
      remediation: "install the pgvector extension (CREATE EXTENSION vector)",
      ...describeError(err),
    });
  });
}

/** Behaviour switches for `createPool` that are not pg connection config. */
export interface CreatePoolOptions {
  /**
   * Register pgvector types on every new client (default true). The migration
   * runner passes false: DDL never reads vector values, and on a fresh
   * database the extension does not exist until a migration creates it, so
   * registration there could only fail and log noise (issue 1515).
   */
  readonly registerVectorTypes?: boolean;
}

export function createPool(
  settings: PoolSettings,
  overrides?: Partial<pg.PoolConfig>,
  options: CreatePoolOptions = {},
): pg.Pool {
  // Registration runs from pg-pool's `onConnect` hook (pg-pool 3.13), which the
  // pool awaits before it hands a new client to its first caller. The old
  // `connect` event was not awaited, so registration overlapped the caller's
  // first query on the same client and pg warned "already executing a query"
  // (issue 1502). The hook is chosen over a pool-scoped type parser because it
  // keeps pgvector's own registration unchanged. It never rejects: a failure
  // is logged and the client is still handed out, as before, since a rejected
  // hook would end the client and fail the checkout. @types/pg does not declare
  // the option yet, hence the widened config type.
  const config: pg.PoolConfig & {
    onConnect?: (client: pg.ClientBase) => Promise<void>;
  } = {
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.user,
    password: settings.password,
    max: settings.max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    maxUses: 7500,
    statement_timeout: 30000,
    ...overrides,
  };
  if (options.registerVectorTypes !== false) config.onConnect = registerVectorTypes;
  const pool = new pg.Pool(config);

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
