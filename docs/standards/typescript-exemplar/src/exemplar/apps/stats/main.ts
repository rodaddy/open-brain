/**
 * Stats -- aggregate the history the monitor recorded.
 *
 * WHY THIS APP IS IN THE EXEMPLAR
 *
 * It is the payoff for `db/`. Every question it answers -- p95 latency, failure
 * rate per target over a window -- is one a JSON file cannot answer without
 * loading and scanning everything. Seeing the query next to `store.ts` is what
 * makes "match the store to the access pattern" concrete instead of a slogan.
 *
 * It is also the only CLI here rather than a service, which is why `no-console`
 * is switched off for `scripts/**` and this file uses the logger anyway: a CLI
 * whose output is structured logs is unreadable, so the REPORT goes to stdout
 * and the DIAGNOSTICS go to the logger. Mixing those is a common mistake --
 * piping the report into another tool then yields log lines interleaved with
 * data.
 *
 * Run it: `npm run stats`
 */

import { join } from "node:path";

import { loadSettings, PROJECT_ROOT } from "../../config.ts";
import { Database, type TargetSummary } from "../../db/database.ts";
import { createLogger } from "../../utils/logging.ts";
import { iso, utcNow } from "../../utils/datetime.ts";

/**
 * The p-th percentile of a numeric series.
 *
 * Written out rather than imported because it is six lines and the
 * interpolation choice matters enough to be visible: this is the
 * NEAREST-RANK method, which always returns an OBSERVED value. Linear
 * interpolation would invent a latency nobody measured, and a p95 that never
 * happened is a worse answer for an SLO than a slightly coarse one.
 *
 * @param values - The series. Not required to be sorted.
 * @param percentile - 0..100.
 * @returns The value at that rank, or null for an empty series.
 */
export function percentile(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] ?? null;
}

/** One line of the report. */
export interface ReportRow extends TargetSummary {
  failureRate: number;
  p95DurationMs: number | null;
}

/**
 * Build the report rows for a window.
 *
 * Separated from printing so it can be asserted on directly -- a function that
 * both computes and prints can only be tested by capturing stdout.
 *
 * @param database - Where the history lives.
 * @param sinceIso - ISO-8601 lower bound.
 * @returns One row per target with any record in the window.
 */
export function buildReport(database: Database, sinceIso: string): ReportRow[] {
  return database.summarize(sinceIso).map((summary) => {
    const durations = database
      .recentFor(summary.targetName, 1_000)
      .map((record) => record.durationMs)
      .filter((value): value is number => value !== null);

    return {
      ...summary,
      failureRate: summary.total === 0 ? 0 : summary.failures / summary.total,
      p95DurationMs: percentile(durations, 95),
    };
  });
}

/** Format the report as fixed-width text for a terminal. */
export function formatReport(rows: ReportRow[]): string {
  if (rows.length === 0) {
    return "No observations in this window.\n";
  }

  const header = [
    "TARGET".padEnd(24),
    "N".padStart(6),
    "FAIL%".padStart(7),
    "AVG ms".padStart(8),
    "P95 ms".padStart(8),
  ].join(" ");
  const lines = rows.map((row) =>
    [
      row.targetName.slice(0, 24).padEnd(24),
      String(row.total).padStart(6),
      `${(row.failureRate * 100).toFixed(1)}%`.padStart(7),
      (row.avgDurationMs === null ? "-" : String(row.avgDurationMs)).padStart(8),
      (row.p95DurationMs === null ? "-" : String(row.p95DurationMs)).padStart(8),
    ].join(" "),
  );

  return [header, "-".repeat(header.length), ...lines, ""].join("\n");
}

function main(): void {
  const settings = loadSettings();
  const logger = createLogger({
    service: "stats",
    level: settings.logging.level,
    pretty: settings.logging.pretty,
  });

  const hours = Number(process.argv[2] ?? "24");
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(
      `Invalid window: ${String(process.argv[2])}. ACTION REQUIRED: pass a positive number of hours.`,
    );
  }

  const since = new Date(utcNow().getTime() - hours * 3_600_000);
  const database = new Database(
    settings.database.path === ":memory:"
      ? ":memory:"
      : join(PROJECT_ROOT, settings.database.path),
    logger,
  );

  try {
    const rows = buildReport(database, iso(since));
    logger.debug({ window_hours: hours, targets: rows.length }, "report built");
    // The REPORT goes to stdout; the diagnostics went to the logger above.
    process.stdout.write(`\nSince ${iso(since)} (${String(hours)}h)\n\n`);
    process.stdout.write(formatReport(rows));
  } finally {
    // finally, so the handle closes even when report building throws. A leaked
    // sqlite handle keeps the WAL file locked.
    database.close();
  }
}

if (process.argv[1]?.endsWith("stats/main.ts") === true) {
  try {
    main();
  } catch (error: unknown) {
    // eslint-disable-next-line no-console -- the logger may be what failed
    console.error("FATAL:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
