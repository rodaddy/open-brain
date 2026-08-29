// L5 adapter (issue 864): legacy call form over server/db/legacy-pool.ts; retired with src/ at L6.
import type pg from "pg";
import {
  createPool as createPoolWithSettings,
  type PoolSettings,
} from "../../server/db/legacy-pool.ts";

export { checkPoolHealth } from "../../server/db/legacy-pool.ts";
export type { PoolSettings } from "../../server/db/legacy-pool.ts";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** The legacy form: connection settings read from the environment at call time. */
export function createPool(overrides?: Partial<pg.PoolConfig>): pg.Pool {
  const host = process.env.DB_HOST;
  if (!host) throw new Error("DB_HOST environment variable is required");
  const user = process.env.DB_USER;
  if (!user) throw new Error("DB_USER environment variable is required");

  const settings: PoolSettings = {
    host,
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "open_brain",
    user,
    password: process.env.DB_PASSWORD,
    max: parsePositiveInt(process.env.DB_POOL_MAX, 10),
  };
  return createPoolWithSettings(settings, overrides);
}
