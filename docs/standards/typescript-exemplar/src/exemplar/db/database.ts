/**
 * Engine, schema, and the four queries this application actually makes.
 *
 * One `Database` instance is built at startup and passed down, exactly like
 * settings. Nothing here is module-level state: a shared global connection is
 * the classic defect, because two concurrent units of work interleave on one
 * transaction and produce failures nobody can reproduce.
 *
 * @see ./index.ts for why `node:sqlite` and why no ORM
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Logger } from "pino";

import { iso, utcNow } from "../utils/datetime.ts";

/** One recorded observation. Append-only: a check never UPDATEs a prior row. */
export interface CheckRecord {
  targetName: string;
  /** Null when the request never completed -- timeout, DNS, refused. */
  statusCode: number | null;
  durationMs: number | null;
  error: string | null;
  /** ISO-8601 with offset. */
  recordedAt: string;
}

/** Aggregate view of one target over a window. */
export interface TargetSummary {
  targetName: string;
  total: number;
  failures: number;
  /** Null when no attempt in the window recorded a duration. */
  avgDurationMs: number | null;
}

/**
 * The schema.
 *
 * `IF NOT EXISTS` so startup is idempotent. This is NOT a migration system: it
 * creates what is declared and does nothing to an existing table whose columns
 * have changed. A real deployment adds a migration tool; saying so here beats
 * discovering it during an incident.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS check_records (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    target_name  TEXT    NOT NULL,
    status_code  INTEGER,
    duration_ms  INTEGER,
    error        TEXT,
    recorded_at  TEXT    NOT NULL
  );

  -- The query this table exists to serve is "recent results for target X",
  -- which is target_name plus a time range. A composite index in that order
  -- serves it; two single-column indexes do not.
  CREATE INDEX IF NOT EXISTS ix_check_records_target_time
    ON check_records (target_name, recorded_at);
`;

/** Owns the connection and the prepared statements. */
export class Database {
  readonly #db: DatabaseSync;
  readonly #logger: Logger | undefined;

  /**
   * Open (or create) the database and ensure the schema exists.
   *
   * @param path - File path, or `":memory:"` for tests.
   * @param logger - Optional bound logger.
   */
  constructor(path: string, logger?: Logger) {
    if (path !== ":memory:") {
      // sqlite does not create the parent directory and the resulting error
      // names the file rather than the missing folder.
      mkdirSync(dirname(path), { recursive: true });
    }

    this.#db = new DatabaseSync(path);
    this.#logger = logger;

    // WAL: readers do not block the writer. For a monitor that appends on a
    // timer while a stats query scans, that is the difference between a clean
    // read and SQLITE_BUSY.
    this.#db.exec("PRAGMA journal_mode = WAL");

    // FULL, not NORMAL. NORMAL can lose the most recent commits on power loss;
    // for an append-only audit trail the whole value is that a written record
    // is actually written.
    this.#db.exec("PRAGMA synchronous = FULL");

    this.#db.exec(SCHEMA);
    this.#logger?.debug({ path }, "DB: schema ensured");
  }

  /**
   * Append one observation.
   *
   * @param record - The observation. `recordedAt` defaults to now.
   *
   * @example
   * ```ts
   * db.record({ targetName: "api", statusCode: 200, durationMs: 42, error: null });
   * ```
   */
  record(record: Omit<CheckRecord, "recordedAt"> & { recordedAt?: string }): void {
    // Bound parameters, never interpolation. This is the injection boundary.
    const statement = this.#db.prepare(
      `INSERT INTO check_records (target_name, status_code, duration_ms, error, recorded_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    statement.run(
      record.targetName,
      record.statusCode,
      record.durationMs,
      record.error,
      record.recordedAt ?? iso(utcNow()),
    );
  }

  /**
   * Most recent observations for one target, newest first.
   *
   * @param targetName - Which target.
   * @param limit - Maximum rows. Bounded so a caller cannot ask for everything.
   * @returns The rows, newest first.
   */
  recentFor(targetName: string, limit = 50): CheckRecord[] {
    const statement = this.#db.prepare(
      `SELECT target_name, status_code, duration_ms, error, recorded_at
         FROM check_records
        WHERE target_name = ?
        ORDER BY recorded_at DESC
        LIMIT ?`,
    );
    const rows = statement.all(targetName, Math.min(limit, 1_000));
    return rows.map((row) => ({
      targetName: row["target_name"] as string,
      statusCode: row["status_code"] as number | null,
      durationMs: row["duration_ms"] as number | null,
      error: row["error"] as string | null,
      recordedAt: row["recorded_at"] as string,
    }));
  }

  /**
   * Aggregate every target since a cutoff.
   *
   * The query a JSON file cannot answer without loading everything -- the
   * reason this layer exists at all.
   *
   * @param since - ISO-8601 lower bound, inclusive.
   * @returns One summary per target that has any record in the window.
   */
  summarize(since: string): TargetSummary[] {
    const statement = this.#db.prepare(
      `SELECT target_name,
              COUNT(*)                                             AS total,
              SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END)   AS failures,
              AVG(duration_ms)                                     AS avg_duration_ms
         FROM check_records
        WHERE recorded_at >= ?
        GROUP BY target_name
        ORDER BY target_name`,
    );
    const rows = statement.all(since);
    return rows.map((row) => ({
      targetName: row["target_name"] as string,
      total: row["total"] as number,
      failures: row["failures"] as number,
      avgDurationMs:
        row["avg_duration_ms"] === null
          ? null
          : Math.round(row["avg_duration_ms"] as number),
    }));
  }

  /** Total rows. Cheap; used by tests and the stats app's header line. */
  count(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM check_records").get();
    return (row?.["n"] as number | undefined) ?? 0;
  }

  /** Close the connection. Call once at shutdown. */
  close(): void {
    this.#db.close();
    this.#logger?.debug("DB: closed");
  }
}
