/**
 * The LIVE embed-watermark observer the deployed NATS worker composes (#724
 * item 3, second half).
 *
 * ## What this closes
 *
 * PR #728 built the whole `embed_watermark` health surface — the block shape,
 * the configurable threshold, the degraded/503 composition in the worker's
 * `/health`, and the runbook section — and proved every one of those behaviors
 * by INJECTING an `embedWatermarkHealth` option. Nothing constructed a real
 * observer, so the deployed worker logged `embed_watermark_observed: false`,
 * published no block, and could never alarm. The surface existed in the tree
 * and was absent from the serving process — the #674 class, which this repo
 * had already paid for once at #656 (capture observer wired).
 *
 * This module is the constructor the live entrypoint gets by default.
 *
 * ## It reads the registry, not a hard-coded table
 *
 * `src/embedding-targets.ts` is the single source of truth for every
 * embedding-bearing table (`EMBEDDING_TARGETS`, `EMBEDDING_TARGET_NAMES`), and
 * it is the SAME registry the lane-A embedding repair drives off. A target
 * carries `provenance.hasEmbeddedAt` telling us whether the physical
 * `embedded_at` column exists (`FULL_PROVENANCE` at
 * `src/embedding-targets.ts:146-150`); `ob_entities` declares
 * `ENTITY_PROVENANCE` (`:158-162`) because it has an `embedding` column and no
 * staleness columns at all, so it is skipped rather than queried for a column
 * that is not there. Adding a target to the registry therefore extends the
 * watermark automatically, and no table name in the SQL below comes from
 * anywhere but that allowlist.
 *
 * ## It is cheap, and `/health` never waits on Postgres
 *
 * `startHealthServer`'s fetch handler is SYNCHRONOUS
 * (`scripts/run-nats-worker.ts`), and a probe must not be able to block on a
 * database round trip or make one query per embedding target per request.
 * So the accessor returned by `createEmbedWatermarkObserver` NEVER queries:
 * it returns the cached reading and, when that reading is older than the TTL,
 * schedules a background refresh whose result serves the NEXT probe. One
 * refresh is in flight at a time. A probe arriving before the first refresh
 * lands gets `undefined` — absence, which by the runbook's contract cannot
 * degrade the endpoint and is the correct answer for "I have not measured
 * yet".
 *
 * ## A failed read is not a stalled lane, and it is not silence either
 *
 * If the query throws, the observer composes a reading whose `stale` is FALSE
 * and whose `reason` names the read failure, carrying the numeric fields from
 * the last successful reading when one exists and `-1` (explicitly "not
 * measured", never an age) when none does.
 *
 * That is deliberate on both sides:
 *
 * - It does not flip `stale: true`. A database the observer cannot reach is
 *   evidence about the OBSERVER, not about the embed lane. Alarming on it
 *   would make a transient blip indistinguishable from the three-day outage
 *   this block exists to catch, and a 503 that fires for unrelated reasons is
 *   how a check stops being read — the same argument `raw_rows_recent` carries
 *   for an idle corpus.
 * - It does not go absent and it does not go stale-forever green. The block is
 *   still published with a reason saying the read failed, the age fields are
 *   `-1` rather than a plausible-looking zero, and every failure is logged. An
 *   operator reading the payload can tell "measured and fine" from "could not
 *   measure", which a silently-omitted block cannot express.
 * - It cannot crash `/health`. The refresh runs in the background with its own
 *   catch; a rejected query composes the error reading and is never thrown
 *   into the request path.
 */
import type pg from "pg";
import {
  EMBEDDING_TARGETS,
  EMBEDDING_TARGET_NAMES,
} from "./embedding-targets.ts";
import type { EmbedWatermarkHealth } from "../scripts/run-nats-worker.ts";

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

export interface EmbedWatermarkObserverOptions {
  pool: pg.Pool;
  /** The bound the `stale` verdict is taken against. */
  lagThresholdSeconds: number;
  /** Serve a reading this long before scheduling a refresh. */
  cacheTtlMs?: number;
  log?: LoggerLike;
  /** Injectable clock, for tests. */
  now?: () => number;
}

export interface EmbedWatermarkObserver {
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
export function watermarkTargetTables(): string[] {
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
export function composeWatermarkReading(
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
    newest_embedded_age_seconds:
      previous?.newest_embedded_age_seconds ?? NOT_MEASURED,
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
        reading = composeReadFailureReading(
          lastGood,
          options.lagThresholdSeconds,
        );
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
        // Fire and forget: the NEXT probe reads the fresher value. A rejection
        // is impossible here (refresh catches its own), but the void guard
        // keeps an unhandled rejection off the request path regardless.
        void refresh().catch(() => undefined);
      }
      return reading;
    },
    refresh,
  };
}
