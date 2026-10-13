/**
 * The LIVE embed-watermark observer the deployed NATS worker composes (#724
 * item 3, second half). Reads the `EMBEDDING_TARGETS` registry, serves a cached
 * reading so `/health` never waits on Postgres, and composes a reason rather
 * than alarming when the read itself fails.
 *
 * See docs/decisions/embed-watermark-observer-is-cached-and-never-blocks-health.md
 */
import type pg from "pg";
import {
  EMBEDDING_TARGETS,
  EMBEDDING_TARGET_NAMES,
} from "../embedding/embedding-targets.ts";

/**
 * The embed lane's liveness, as the worker's `/health` on 3110 reports it —
 * a named block with a boolean `stale` verdict, the raw counters, an explicit
 * threshold, and a content-free `reason`.
 *
 * See docs/decisions/embed-watermark-is-a-health-input-on-3110.md
 */
export interface EmbedWatermarkHealth {
  /**
   * True once the embed lane is behind past its threshold WITH fresh raw rows
   * present. Both halves are required — see `raw_rows_recent`.
   */
  readonly stale: boolean;
  /** Age of the newest raw row. */
  readonly newest_raw_age_seconds: number;
  /** Age of the newest embedded row. */
  readonly newest_embedded_age_seconds: number;
  /** How far the embedded watermark trails the raw one. */
  readonly lag_seconds: number;
  /** The bound the `stale` verdict was taken against. */
  readonly lag_threshold_seconds: number;
  /**
   * Raw rows seen recently. `stale` REQUIRES this to be positive: a quiet week
   * produces an old embedded row too, and alarming on an idle corpus is how a
   * check stops being read (`server/capture/liveness-observer.ts`
   * MIN_SESSIONS_FOR_SILENCE carries the same argument for capture).
   */
  readonly raw_rows_recent: number;
  /** Content-free sentence naming which condition produced the verdict. */
  readonly reason: string;
}

type LoggerLike = {
  error: (msg: string, fields?: Record<string, unknown>) => void;
};

/**
 * How long a watermark reading is served before a background refresh is
 * scheduled, in milliseconds.
 *
 * Thirty seconds. The bound the verdict is taken against is an HOUR by default
 * (`DEFAULT_EMBED_WATERMARK_LAG_THRESHOLD_SECONDS`), so a reading up to 30s old
 * cannot change the `stale` verdict in any realistic case, while a scrape
 * interval of a few seconds collapses from "N queries per probe" to at most one
 * aggregate query per 30s regardless of probe rate.
 *
 * NOTHING IS ADJUSTED SILENTLY: the worker announces this value at startup as
 * `embed_watermark_cache_ttl_seconds`, beside the threshold it announces
 * already.
 */
export const EMBED_WATERMARK_CACHE_TTL_MS = 30_000;

/** Sentinel for a numeric field that was never measured. Not an age. */
const NOT_MEASURED = -1;

interface EmbedWatermarkObserverOptions {
  pool: pg.Pool;
  /** The bound the `stale` verdict is taken against. */
  lagThresholdSeconds: number;
  /** Serve a reading this long before scheduling a refresh. */
  cacheTtlMs?: number;
  log?: LoggerLike;
  /** Injectable clock, for tests. */
  now?: () => number;
}

interface EmbedWatermarkObserver {
  /** Synchronous accessor for the health composer. Never queries. */
  read: () => EmbedWatermarkHealth | undefined;
  /** Force a refresh and await it. Used at startup and by tests. */
  refresh: () => Promise<void>;
}

/**
 * Every registry target that physically carries an `embedded_at` column.
 *
 * Names come from `EMBEDDING_TARGET_NAMES` and are used as SQL identifiers
 * below; that is safe precisely because the registry IS the allowlist
 * (`getEmbeddingTarget` throws on anything outside it), which is the same
 * rule the repair path relies on.
 */
function watermarkTargetTables(): string[] {
  return EMBEDDING_TARGET_NAMES.filter(
    (name) => EMBEDDING_TARGETS[name]?.provenance.hasEmbeddedAt === true,
  );
}

/**
 * Aggregate the raw and embedded watermarks across every watermark-bearing
 * target in ONE query.
 *
 * Per target: the newest `created_at` (raw arrival), the newest `embedded_at`
 * (the embed lane's own watermark), and how many rows arrived inside the
 * threshold window. The outer aggregate takes the newest of each across
 * targets, so a single stalled table is visible in the lag and an idle one
 * cannot mask a busy one.
 */
function buildWatermarkSql(tables: string[]): string {
  const parts = tables.map(
    (table) => `
      SELECT
        max(created_at)  AS newest_raw,
        max(embedded_at) AS newest_embedded,
        count(*) FILTER (
          WHERE created_at > now() - make_interval(secs => $1::double precision)
        ) AS raw_rows_recent
      FROM ${table}`,
  );
  return `
    WITH per_target AS (${parts.join("\n      UNION ALL")})
    SELECT
      extract(epoch FROM now() - max(newest_raw))::double precision
        AS newest_raw_age_seconds,
      extract(epoch FROM now() - max(newest_embedded))::double precision
        AS newest_embedded_age_seconds,
      coalesce(sum(raw_rows_recent), 0)::bigint AS raw_rows_recent
    FROM per_target`;
}

interface WatermarkRow {
  newest_raw_age_seconds: number | null;
  newest_embedded_age_seconds: number | null;
  raw_rows_recent: string | number | null;
}

/**
 * Turn one aggregate row into the published block.
 *
 * The empty-corpus case (no rows anywhere, so both watermarks are NULL) is
 * decided HERE and deliberately: it reports `-1` ages, `raw_rows_recent: 0`,
 * and `stale: false`. An empty corpus is not a stalled lane — there is nothing
 * for the lane to have failed to do — and `stale` already requires
 * `raw_rows_recent > 0`, so the guard that keeps an idle week quiet keeps an
 * empty database quiet on exactly the same argument.
 */
function composeWatermarkReading(
  row: WatermarkRow,
  lagThresholdSeconds: number,
): EmbedWatermarkHealth {
  const rawAge = row.newest_raw_age_seconds;
  const embeddedAge = row.newest_embedded_age_seconds;
  const rawRowsRecent = Number(row.raw_rows_recent ?? 0);

  if (rawAge === null) {
    return {
      stale: false,
      newest_raw_age_seconds: NOT_MEASURED,
      newest_embedded_age_seconds: embeddedAge ?? NOT_MEASURED,
      lag_seconds: NOT_MEASURED,
      lag_threshold_seconds: lagThresholdSeconds,
      raw_rows_recent: 0,
      reason: "no rows in any embedding target; nothing to embed",
    };
  }

  // No embedded row at all, but raw rows exist: the lag is the full age of the
  // newest raw row, because nothing has ever been embedded.
  const lagSeconds = embeddedAge === null ? rawAge : embeddedAge - rawAge;
  const stale = lagSeconds > lagThresholdSeconds && rawRowsRecent > 0;

  return {
    stale,
    newest_raw_age_seconds: rawAge,
    newest_embedded_age_seconds: embeddedAge ?? NOT_MEASURED,
    lag_seconds: lagSeconds,
    lag_threshold_seconds: lagThresholdSeconds,
    raw_rows_recent: rawRowsRecent,
    reason: stale
      ? "embedded watermark trails raw arrivals past the threshold while raw rows keep arriving"
      : rawRowsRecent === 0
        ? "no raw rows inside the threshold window; idle corpus, not a stalled lane"
        : "embed watermark within threshold",
  };
}

/** Compose the reading served when the watermark query itself failed. */
function composeReadFailureReading(
  previous: EmbedWatermarkHealth | undefined,
  lagThresholdSeconds: number,
): EmbedWatermarkHealth {
  return {
    stale: false,
    newest_raw_age_seconds: previous?.newest_raw_age_seconds ?? NOT_MEASURED,
    newest_embedded_age_seconds: previous?.newest_embedded_age_seconds ?? NOT_MEASURED,
    lag_seconds: previous?.lag_seconds ?? NOT_MEASURED,
    lag_threshold_seconds: lagThresholdSeconds,
    raw_rows_recent: previous?.raw_rows_recent ?? 0,
    reason: previous
      ? "embed watermark query failed; numbers are the last successful reading"
      : "embed watermark query failed; never measured",
  };
}

export function createEmbedWatermarkObserver(
  options: EmbedWatermarkObserverOptions,
): EmbedWatermarkObserver {
  const cacheTtlMs = options.cacheTtlMs ?? EMBED_WATERMARK_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const tables = watermarkTargetTables();
  const sql = buildWatermarkSql(tables);

  let reading: EmbedWatermarkHealth | undefined;
  let lastGood: EmbedWatermarkHealth | undefined;
  let readAtMs = 0;
  let inFlight: Promise<void> | null = null;

  const refresh = async (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const result = await options.pool.query<WatermarkRow>(sql, [
          options.lagThresholdSeconds,
        ]);
        const row = result.rows[0];
        if (!row) throw new Error("watermark aggregate returned no row");
        reading = composeWatermarkReading(row, options.lagThresholdSeconds);
        lastGood = reading;
      } catch (err) {
        options.log?.error("Open Brain embed watermark read failed", {
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
        reading = composeReadFailureReading(lastGood, options.lagThresholdSeconds);
      } finally {
        readAtMs = now();
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return {
    read: () => {
      if (now() - readAtMs >= cacheTtlMs) {
        // Fire and forget: the NEXT probe reads the fresher value. The guard
        // keeps an unhandled rejection off the request path, and now says so.
        void refresh().catch((err: unknown) => {
          // refresh() catches its own read failures, so reaching here means the
          // refresh machinery itself broke and the reading silently went stale.
          options.log?.error("Open Brain embed watermark refresh failed", {
            error_type: err instanceof Error ? err.constructor.name : typeof err,
          });
        });
      }
      return reading;
    },
    refresh,
  };
}
