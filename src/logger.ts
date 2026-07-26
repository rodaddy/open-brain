import os from "node:os";
import { SECRET_PATTERNS } from "./secret-patterns.ts";
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

/**
 * Active minimum level. Mutable, not a module-load constant.
 *
 * A frozen level means the only way to raise verbosity during an incident is a
 * restart — which destroys the in-flight state being investigated, and is the
 * one moment the logs matter most. `setLogLevel` lets an operator turn debug on
 * against a running process (the dogfood default is `debug`; production runs
 * `info` or `warn`).
 */
let minLevel: LogLevel = resolveLevel();

/**
 * Raise or lower the active log level at runtime.
 *
 * @param level One of debug, info, warn, error. An unknown value is rejected
 *   rather than silently coerced, because silently staying at the old level
 *   during an incident looks identical to the setting having worked.
 * @returns The level now in effect.
 * @throws {Error} If `level` is not a known level.
 */
export function setLogLevel(level: string): LogLevel {
  const next = level.trim().toLowerCase();
  if (!(next in LOG_LEVELS)) {
    throw new Error(
      `unknown log level ${JSON.stringify(level)}; expected one of ${Object.keys(LOG_LEVELS).join(", ")}`,
    );
  }
  const previous = minLevel;
  const target = next as LogLevel;
  // Announce through whichever gate is more permissive, so the transition is
  // never filtered by the change itself. Emitting after the swap loses the line
  // when lowering verbosity (`info` -> `warn` hides its own `info` notice), and
  // emitting before it loses the line when raising from a level that already
  // suppressed `info` (`error` -> `debug`). Widening for this one line makes
  // "when did the level change?" answerable from the log in both directions.
  const widened = LOG_LEVELS[previous] < LOG_LEVELS[target] ? previous : target;
  minLevel = widened;
  try {
    log("info", "log_level_changed", { from: previous, to: target });
  } finally {
    // `finally`, not a plain assignment: the widened gate above is a temporary
    // state that exists only for the announce line, and `log` can throw for
    // real -- FILE_SINK.write fails on a full or unwritable disk. Without this,
    // a throw leaves minLevel stuck at the WIDENED value while the caller sees
    // an error and reasonably concludes nothing changed. That inverts the
    // intent on the one path this function exists for: an operator raising
    // verbosity mid-incident, on the box whose disk just filled, would silently
    // get debug-volume logging from a call that reported failure.
    //
    // Conditional, because the widened window runs registered sinks
    // synchronously and one of them can reenter this function -- an
    // auto-escalate-on-error sink is exactly the documented extension point. An
    // unconditional restore silently reverted that nested change AND the nested
    // call returned its own target as though it had taken effect. A later
    // decision wins.
    if (minLevel === widened) minLevel = target;
  }
  // `minLevel`, not `target`: the returned value must be what is actually in
  // effect, or a reentrant change is reported as the caller's own.
  return minLevel;
}

/** The level currently in effect. */
export function getLogLevel(): LogLevel {
  return minLevel;
}

/**
 * Host identity stamped onto every line.
 *
 * Required by the shared observability envelope
 * (`_DOCS/CODING_STANDARDS.md`, `## Observability`): `service` and `host` are
 * the only two fields that become Loki labels, so every emitter on the fleet
 * must carry both or the per-host query surface has holes. Read once — a
 * process does not change hosts.
 */
const HOST_NAME = (() => {
  const configured = process.env.HOSTNAME?.trim() || process.env.HOST?.trim();
  if (configured) return configured;
  try {
    return os.hostname();
  } catch {
    // Deliberate fail-open: an unavailable hostname must degrade one label,
    // never prevent logging. Reporting it through the logger would recurse.
    return "unknown";
  }
})();

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
 * `timestamp`, `level`, `message`, `service`, `host`, and `correlation_id` are
 * the shared envelope. The first five are always present and are stamped here,
 * never passed by a caller; `correlation_id` appears whenever the line was
 * emitted inside a `withContext()` scope.
 *
 * `service` and `host` are the only two fields that become Loki labels
 * (`_DOCS/CODING_STANDARDS.md`, `## Observability`) — everything else stays in
 * the body, because Loki builds one index stream per unique label combination
 * and a high-cardinality label produces unbounded streams.
 *
 * `message` is a stable event name (`lane_scope_miss`), never a sentence — event
 * names are what Loki filters on.
 */
interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
  service: string;
  host: string;
  [key: string]: unknown;
}

/**
 * Strip known secret material from a string bound for a log entry.
 *
 * Applies `SECRET_PATTERNS` — the same detector set that gates shared-kb
 * promotion and the Python client's `policy.py` — rather than a second, weaker
 * redaction fork.
 *
 * `redactText()` is deliberately NOT reused here: it emits a `logger.warn` when
 * it changes something, and this function runs *inside* the log path, so that
 * would recurse. The patterns are applied directly and the substitution is
 * silent; the redaction marker in the output is the evidence.
 *
 * Lives here, not in `observability/with-logging.ts` where it started, because
 * review found it was applied only to `error_name`/`error_message`/`error_stack`
 * — so the identical DSN went out redacted in `error_message` and in clear in a
 * caller-supplied field on the same line. Redaction belongs at the envelope,
 * which is here, and that also covers `contextFields()` output. `with-logging`
 * imports it from this module; the reverse would be a cycle.
 *
 * The input is bounded first: `PRIVATE_KEY_BLOCK_RE` is quadratic on repeated
 * `-----BEGIN` markers with no `END` (measured 625 KB -> 3.9 s of blocked event
 * loop), and an unbounded string in a log line is its own problem regardless.
 */
const MAX_REDACT_INPUT_CHARS = 16_384;

export function redactForLog(value: string): string {
  if (!value) return value;
  const bounded =
    value.length > MAX_REDACT_INPUT_CHARS
      ? `${value.slice(0, MAX_REDACT_INPUT_CHARS)}…[truncated ${value.length - MAX_REDACT_INPUT_CHARS} chars]`
      : value;
  let redacted = bounded;
  for (const pattern of SECRET_PATTERNS) {
    const flags = pattern.flags.includes("g")
      ? pattern.flags
      : `${pattern.flags}g`;
    redacted = redacted.replace(
      new RegExp(pattern.source, flags),
      "[REDACTED]",
    );
  }
  return redacted;
}

/**
 * Serialize one entry without ever throwing, redacting every string it emits.
 *
 * Two review findings meet here, and both were reproduced.
 *
 * **It must not throw.** Every other step in `log()` is deliberately fail-open --
 * `contextFields()` catches a throwing reader, the file sink is guarded, each
 * extra sink is guarded -- but the bare `JSON.stringify(entry)` was not. A
 * cycle, a `BigInt`, or a throwing `toJSON` in any caller field or context field
 * lost the line on all four destinations *and* threw into arbitrary application
 * code. The consequences went well past logging: `withLogging` replaced the real
 * error with a serializer error on its failure path, `withFallback` threw
 * instead of returning its fallback, and worst, at `debug` the entry line threw
 * before `fn` was ever called -- so **raising the log level silently stopped
 * work from running**. That is the exact scenario `setLogLevel` exists for.
 * `src/audit-log.ts` already defends itself against "a cycle, a BigInt
 * anywhere"; the shared envelope every emitter routes through did not.
 *
 * **It must redact the whole entry, not one contributor.** `redactForLog` was
 * applied only to `error_name`/`error_message`/`error_stack`, so the identical
 * DSN went out redacted in `error_message` and in clear in a caller field on the
 * same line. Redacting at the envelope also covers `contextFields()` output,
 * which nothing covered before.
 *
 * Values are handled rather than dropped: `bigint` becomes its digits, a cycle
 * becomes `"[Circular]"`, a throwing getter becomes `"[Unserializable]"`. Losing
 * one field is acceptable; losing the line during an incident is not.
 */
function serializeEntry(
  entry: LogEntry,
  level: LogLevel,
  message: string,
): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(entry, function replacer(_key, value: unknown) {
      if (typeof value === "string") return redactForLog(value);
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "function" || typeof value === "symbol") {
        return `[${typeof value}]`;
      }
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
  } catch {
    // A throwing `toJSON`, or anything else the replacer could not tame. Emit
    // the envelope alone so the line still lands and says why it is thin.
    try {
      return JSON.stringify({
        level,
        message: redactForLog(message),
        timestamp: new Date().toISOString(),
        service: SERVICE_NAME,
        host: HOST_NAME,
        log_serialize_failed: true,
      });
    } catch {
      // Envelope-only serialization cannot realistically fail; if it somehow
      // does, a hand-built string still beats losing the line.
      return `{"level":"${level}","message":"log_serialize_failed","service":"${SERVICE_NAME}","host":"${HOST_NAME}"}`;
    }
  }
}

function log(
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[minLevel]) return;

  // Envelope fields are owned here and stamped last so a caller cannot
  // accidentally shadow them with a same-named field: callers that spell
  // `service` or `correlation_id` differently per repo are how one query
  // surface becomes several.
  const entry: LogEntry = {
    ...extra,
    // Context spreads BEFORE the envelope, not after. It used to spread last,
    // which meant a context reader returning `service`, `host`, or `level`
    // silently overrode the fields this block claims to own -- and `service`
    // and `host` are the only two that become Loki labels, so one mislabelled
    // reader splits the query surface with nothing in the output saying so.
    // Context supplies correlation fields; it does not get to rename the
    // service.
    ...contextFields(),
    level,
    message,
    timestamp: new Date().toISOString(),
    service: SERVICE_NAME,
    host: HOST_NAME,
  };
  const output = serializeEntry(entry, level, message);
  // Sinks receive the SERIALIZED-then-parsed entry, not the raw object. Review
  // found that redacting only inside `serializeEntry` left every extra sink
  // reading the unredacted original -- so a credential-bearing caller field went
  // out in clear to any observer while the file and console saw `[REDACTED]`.
  // Round-tripping guarantees all three destinations see byte-identical data,
  // and it is the same object shape sinks already expected.
  let delivered: LogEntry = entry;
  try {
    delivered = JSON.parse(output) as LogEntry;
  } catch {
    // serializeEntry never returns invalid JSON, but a sink getting the raw
    // entry is still better than no line at all.
  }
  // NOT wrapped in try/catch, deliberately. An earlier revision guarded this,
  // reasoning that a full disk must not take the line down with it. The
  // reasoning was right and the guard was redundant: `createRotatingFileSink`
  // documents "Never throws on write" and already wraps its `appendFileSync` in
  // a try/catch that re-syncs and continues (`rotating-file.ts`). A review lane
  // caught that the guard had no test which failed when it was reverted; the
  // reason it could not be tested is that the throw it caught cannot occur.
  // Keeping a guard for an impossible case makes the next reader believe this
  // sink is a throwing one.
  FILE_SINK?.write(output);
  // Snapshot, not the live Set. `Set` iteration observes mutation, so a sink
  // that re-subscribes itself during an emit lands back at the tail and is
  // reached again by the same loop -- one log line drove a sink 50,001 times in
  // review before a circuit breaker stopped it. It is inside the per-sink
  // catch, so it surfaces as a silent hang rather than an error. A snapshot
  // also makes "a sink added mid-emit does not receive the in-flight line"
  // defined rather than incidental.
  for (const sink of [...extraSinks]) {
    // A misbehaving observer must not silence the line for everyone else, and
    // reporting through the logger from inside the logger would recurse.
    try {
      sink(delivered);
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
