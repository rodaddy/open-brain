import {
  createRotatingFileSink,
  type RotatingFileSink,
} from "./rotating-file.ts";

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

function resolveLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (env in LOG_LEVELS) return env as LogLevel;
  return "info";
}
const MIN_LEVEL = resolveLevel();

/**
 * Optional rolling file sink (OB issue #193). When `LOG_FILE` is set the
 * logger mirrors every emitted line into a size-capped rotating file so no
 * single OB log can grow unbounded, independent of any host log tooling.
 *
 *   LOG_FILE       absolute path of the active log file (enables the sink)
 *   LOG_MAX_BYTES  rotate threshold in bytes (default 1_000_000 = 1MB)
 *   LOG_MAX_FILES  rotated files retained beyond the active file (default 3)
 *
 * Under multiple workers, give each worker a distinct LOG_FILE (e.g. include
 * OPEN_BRAIN_WORKER_NAME in the path) so rotation is single-writer safe.
 */
function resolvePositiveInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function resolveFileSink(): RotatingFileSink | undefined {
  const path = process.env.LOG_FILE?.trim();
  if (!path) return undefined;
  return createRotatingFileSink({
    path,
    maxBytes: resolvePositiveInt(process.env.LOG_MAX_BYTES, 1_000_000),
    maxFiles: resolvePositiveInt(process.env.LOG_MAX_FILES, 3),
  });
}

const FILE_SINK = resolveFileSink();

interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

function log(
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[MIN_LEVEL]) return;

  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  };
  const output = JSON.stringify(entry);
  FILE_SINK?.write(output);
  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else if (level === "debug") {
    console.debug(output);
  } else {
    console.log(output);
  }
}

export const logger = {
  info: (message: string, extra?: Record<string, unknown>) =>
    log("info", message, extra),
  warn: (message: string, extra?: Record<string, unknown>) =>
    log("warn", message, extra),
  error: (message: string, extra?: Record<string, unknown>) =>
    log("error", message, extra),
  debug: (message: string, extra?: Record<string, unknown>) =>
    log("debug", message, extra),
};
