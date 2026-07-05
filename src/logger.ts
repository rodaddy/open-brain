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
 * Rotation is only single-writer safe, so when OPEN_BRAIN_WORKER_NAME is set
 * (the two-worker launcher sets a distinct name per child) the effective path
 * is derived per worker automatically: `open-brain.log` becomes
 * `open-brain.<worker-name>.log`. Two workers inheriting the same configured
 * LOG_FILE therefore never share an active file or rotation chain.
 */
export function deriveWorkerLogPath(
  path: string,
  workerName: string | undefined,
): string {
  const worker = workerName?.trim();
  if (!worker) return path;
  // Sanitize so the worker name can only alter the filename, never the dir.
  const safe = worker.replace(/[^A-Za-z0-9._-]/g, "_");
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const file = slash === -1 ? path : path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return `${dir}${file}.${safe}`;
  return `${dir}${file.slice(0, dot)}.${safe}${file.slice(dot)}`;
}

/**
 * Parse an integer env value, falling back when below `min` or non-numeric.
 * LOG_MAX_BYTES requires min 1 (a zero-byte cap is meaningless and would
 * otherwise be silently coerced to the default deeper in the sink), while
 * LOG_MAX_FILES=0 is a real setting (keep only the active file).
 */
function resolveBoundedInt(
  raw: string | undefined,
  min: number,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function resolveFileSink(): RotatingFileSink | undefined {
  const configured = process.env.LOG_FILE?.trim();
  if (!configured) return undefined;
  const path = deriveWorkerLogPath(
    configured,
    process.env.OPEN_BRAIN_WORKER_NAME,
  );
  return createRotatingFileSink({
    path,
    maxBytes: resolveBoundedInt(process.env.LOG_MAX_BYTES, 1, 1_000_000),
    maxFiles: resolveBoundedInt(process.env.LOG_MAX_FILES, 0, 3),
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
