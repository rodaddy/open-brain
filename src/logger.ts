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

/**
 * Service identity stamped onto every line. Part of the shared observability
 * envelope (`_DOCS/CODING_STANDARDS.md`, `## Observability`) so that logs from
 * every emitter on the fleet — applications and infrastructure alike — share one
 * queryable shape in Loki.
 *
 * Read once at module load. When more than one worker writes, the worker name is
 * appended so lines are attributable to the process that emitted them, matching
 * how `deriveWorkerLogPath` separates their files.
 */
const SERVICE_NAME = (() => {
  const base = process.env.SERVICE_NAME?.trim() || "open-brain";
  const worker = process.env.OPEN_BRAIN_WORKER_NAME?.trim();
  return worker ? `${base}.${worker}` : base;
})();

/**
 * Async-scoped context reader, installed by `observability/context.ts`.
 *
 * Set through a registration function rather than imported directly: the
 * observability wrappers import this module, so a static import back the other
 * way would be circular. It stays undefined until something opts in, which keeps
 * the logger usable on its own (scripts, tests, early boot) with no context
 * machinery loaded.
 */
type ContextReader = () => Record<string, unknown> | undefined;
let contextReader: ContextReader | undefined;

/**
 * Register the reader supplying async-scoped envelope fields.
 *
 * Called once by `observability/context.ts`. Not part of the call-site surface.
 */
export function setLogContextReader(reader: ContextReader): void {
  contextReader = reader;
}

/**
 * Additional sinks receiving every emitted entry as a structured object.
 *
 * Exists so a consumer can observe emitted lines without depending on global
 * `console` state — which tests must not do, since Bun runs all test files in
 * one process and a suite that swaps `console.error` without restoring it would
 * otherwise silently break unrelated assertions.
 *
 * Also the extension point for a genuine second destination later (a metrics
 * counter, an in-process ring buffer for `operator-doctor`) without touching
 * the call sites.
 */
type ExtraSink = (entry: Record<string, unknown>) => void;
const extraSinks = new Set<ExtraSink>();

/**
 * Subscribe to every emitted log entry.
 *
 * @param sink Called with each entry after the envelope is applied.
 * @returns An unsubscribe function. Callers must call it, or the sink leaks.
 */
export function addLogSink(sink: ExtraSink): () => void {
  extraSinks.add(sink);
  return () => {
    extraSinks.delete(sink);
  };
}

function contextFields(): Record<string, unknown> {
  if (!contextReader) return {};
  // DELIBERATE FAIL-OPEN, and the one place in this codebase where an unlogged
  // catch is correct: this runs *inside* the log path, so reporting the failure
  // through the logger would recurse. A broken context reader must degrade the
  // line to "no correlation id" rather than prevent the line from being written
  // at all — losing the whole line is strictly worse than losing one field.
  try {
    return contextReader() ?? {};
  } catch {
    return {};
  }
}

/**
 * A single emitted line.
 *
 * `timestamp`, `level`, `message`, `service`, and `correlation_id` are the
 * shared envelope. The first four are always present; `correlation_id` appears
 * whenever the line was emitted inside a `withContext()` scope.
 *
 * `message` is a stable event name (`lane_scope_miss`), never a sentence — event
 * names are what Loki filters on.
 */
interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
  service: string;
  [key: string]: unknown;
}

function log(
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[MIN_LEVEL]) return;

  // Envelope fields are owned here and stamped last so a caller cannot
  // accidentally shadow them with a same-named field: callers that spell
  // `service` or `correlation_id` differently per repo are how one query
  // surface becomes several.
  const entry: LogEntry = {
    ...extra,
    level,
    message,
    timestamp: new Date().toISOString(),
    service: SERVICE_NAME,
    ...contextFields(),
  };
  const output = JSON.stringify(entry);
  FILE_SINK?.write(output);
  for (const sink of extraSinks) {
    // A misbehaving observer must not silence the line for everyone else, and
    // reporting through the logger from inside the logger would recurse.
    try {
      sink(entry);
    } catch {
      /* deliberate: see contextFields() */
    }
  }
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
