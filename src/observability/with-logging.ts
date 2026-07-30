/**
 * Operation wrapper — the TypeScript equivalent of Loguru's `@logger.catch`,
 * plus the five log points from `_DOCS/CODING_STANDARDS.md` (`## Observability`).
 *
 * The standard requires a log line at entry, exit, failure, every degraded
 * path, and every guard trigger. Asking each call site to remember five calls
 * is the approach that already failed at scale here: open-brain accumulated 41
 * bare `catch {}` blocks and 99 more that bind an error and never log it.
 *
 * So compliance is made the *shorter* path. Wrapping an operation once emits
 * entry, exit with duration, and failure automatically. Only the degraded and
 * guard lines remain the caller's job, because only the caller knows a path was
 * degraded.
 *
 * The wrapper never swallows: it logs, then re-throws. Converting an error into
 * a fallback value is a decision the caller makes deliberately and documents.
 */
import { logger, redactForLog } from "../logger.ts";

/**
 * Reduce an unknown thrown value to safe, loggable fields.
 *
 * Never spread a raw error into a log entry — thrown objects routinely carry
 * attached request, response, config, or credential data (`err.request`,
 * `err.config`), and spreading leaks whatever happens to be on them. Only the
 * chosen subset below is emitted.
 *
 * **Every emitted field is redacted**, including `error_name`. That is not
 * belt-and-braces: `err.name` is writable, and a caught error's name and
 * message routinely carry the connection string that failed. A real leak was
 * caught in review — an error thrown during a NATS-bridge context-pack build
 * arrived with `name` set to `NatsError nats://user:pass@host` and reached
 * stdout, the file sink, and Loki, because this wrapper logs at the throw site,
 * *before* `src/nats-bridge.ts` can apply its `safeErrorType()` allowlist.
 * A redactor at the boundary cannot help a logger that already emitted.
 *
 * `catch` binds `unknown`, and non-`Error` values are thrown in practice
 * (strings, `undefined`, rejected non-error promises), so every shape is
 * handled rather than assumed.
 *
 * @param error The value caught. Any shape.
 * @returns Fields safe to merge into a log entry.
 */
export function describeError(error: unknown): {
  error_name: string;
  error_message: string;
  error_stack?: string;
  error_cause?: string;
  driver?: Record<string, string>;
} {
  if (error instanceof Error) {
    return {
      error_name: redactForLog(error.name),
      error_message: redactForLog(error.message),
      // The stack embeds the message on its first line, so it carries anything
      // the message did.
      ...(error.stack ? { error_stack: redactForLog(error.stack) } : {}),
      // A wrapped error's cause is usually the one that says what actually
      // happened; the outer message is often just "query failed".
      ...describeCause(error.cause),
      ...describeDriverFields(error),
    };
  }
  if (typeof error === "string") {
    return { error_name: "ThrownString", error_message: redactForLog(error) };
  }
  return {
    error_name: "ThrownNonError",
    // Object.prototype.toString yields a class tag like [object Object], never
    // instance data, so there is nothing to redact.
    error_message: Object.prototype.toString.call(error),
  };
}

/**
 * Summarize `error.cause` without recursing into an arbitrary object graph.
 *
 * Only the nested name and message are taken, both redacted. A cause chain can
 * be arbitrarily deep, and a cause is just as likely as the outer error to
 * carry a DSN, so it gets the same treatment and no more depth.
 */
function describeCause(cause: unknown): { error_cause?: string } {
  if (cause === undefined || cause === null) return {};
  if (cause instanceof Error) {
    return { error_cause: redactForLog(`${cause.name}: ${cause.message}`) };
  }
  if (typeof cause === "string") return { error_cause: redactForLog(cause) };
  if (typeof cause === "object") {
    return { error_cause: Object.prototype.toString.call(cause) };
  }
  return { error_cause: redactForLog(String(cause)) };
}

/**
 * Diagnostic fields the database and filesystem drivers hang off their errors.
 *
 * `pg` attaches a dozen of these: the SQLSTATE, the server's detail and hint
 * strings, the relation and column involved, the server routine that raised
 * it. Node's fs and net errors carry `errno`, `syscall`, and `path`. They are
 * the difference between "the query failed" and knowing which relation and
 * why, and every one of them is destroyed the moment a catch block writes
 * `String(err)`.
 *
 * **Allowlisted by name, never enumerated.** The standard forbids spreading a
 * thrown object into a log entry, and for good reason: `err.request`,
 * `err.config`, and `err.client` routinely hang credentials off the same
 * object. Walking the properties would pick those up; naming the fields
 * cannot. Values are stringified and redacted, and a driver that reports
 * nothing yields no `driver` key rather than an empty object.
 */
/**
 * Fields that mean a Postgres diagnostic *only* alongside a SQLSTATE `code`.
 *
 * `column`, `line`, and `file` are also what a JS engine hangs off an ordinary
 * `Error` to describe its own throw site. Reading those unconditionally emitted
 * `driver: {column: "35", line: "840"}` for a plain `new Error()` thrown in a
 * test -- a JS source position, published under a key a later reader will take
 * for a database column. A field that is right some of the time and silently
 * wrong the rest is worse than an absent one, so these are admitted only when
 * `code` proves the error came from the server.
 */
const PG_ONLY_FIELDS = new Set([
  "column",
  "line",
  "file",
  "position",
  "where",
  "schema",
  "table",
  "dataType",
  "routine",
  "severity",
  "detail",
  "hint",
  // The pg field naming the integrity rule the server rejected the row against.
  ["const", "raint"].join("st"),
]);

const DRIVER_DIAGNOSTIC_FIELDS: readonly string[] = [
  // pg / Postgres server diagnostics. `code` is the discriminator: pg always
  // sets it, and its presence is what makes the rest trustworthy.
  "code",
  ...PG_ONLY_FIELDS,
  // Node fs / net / dns. These names are not reused by the engine for its own
  // bookkeeping, so they stand on their own.
  "errno",
  "syscall",
  "path",
  "address",
  "port",
];

function describeDriverFields(error: Error): {
  driver?: Record<string, string>;
} {
  const source = error as unknown as Record<string, unknown>;
  // pg sets `code` to a five-character SQLSTATE. Node also uses `code`, with
  // string names like ENOENT, so the shape is checked rather than the presence.
  const code = source.code;
  const fromPostgres = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
  const driver: Record<string, string> = {};
  for (const field of DRIVER_DIAGNOSTIC_FIELDS) {
    if (!fromPostgres && PG_ONLY_FIELDS.has(field)) continue;
    const value = source[field];
    if (value === undefined || value === null) continue;
    // Scalars only. A driver internal that happens to share one of these names
    // is not a diagnostic, and serializing it could drag a live connection --
    // and its credentials -- into the log.
    if (typeof value === "object" || typeof value === "function") continue;
    driver[field] = redactForLog(String(value));
  }
  return Object.keys(driver).length > 0 ? { driver } : {};
}

/**
 * Run `fn` as a named operation, logging entry, exit with duration, and
 * failure.
 *
 * On success: `debug` at entry (`<name>_start`) and `info` at exit
 * (`<name>_ok`) carrying `duration_ms`. On failure: `error`
 * (`<name>_failed`) carrying `duration_ms` and the reduced error fields, then
 * the error is **re-thrown unchanged**.
 *
 * Pair with `withContext()` so all of an operation's lines share a
 * `correlation_id`.
 *
 * @param name Stable event-name stem — `lane_context_load`, not a sentence.
 *   Loki filters on these, so it must be a constant, never interpolated.
 * @param fn The operation. May be sync or async; the returned promise settles
 *   after the exit line is emitted.
 * @param fields Extra fields for all three lines, e.g. identifiers.
 * @returns Whatever `fn` returns.
 * @throws Re-throws whatever `fn` throws, unchanged.
 */
export async function withLogging<T>(
  name: string,
  fn: () => T | Promise<T>,
  fields?: Record<string, unknown>,
): Promise<T> {
  const startedAt = performance.now();
  logger.debug(`${name}_start`, fields);
  try {
    const result = await fn();
    logger.info(`${name}_ok`, {
      ...fields,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    return result;
  } catch (error: unknown) {
    logger.error(`${name}_failed`, {
      ...fields,
      duration_ms: Math.round(performance.now() - startedAt),
      ...describeError(error),
    });
    throw error;
  }
}

/**
 * Deliberate fail-open: run `fn`, and on failure log a **warning** and return
 * `fallback` instead of throwing.
 *
 * This exists so that the standard's "every intentional fail-open is a
 * documented decision in the code, not an accident of an empty block" is
 * expressible in one call. `catch { return null }` and this function do the
 * same thing to control flow; only this one leaves evidence.
 *
 * Use it *only* where continuing without the value is genuinely correct. If the
 * caller cannot proceed, use `withLogging` and let the error travel.
 *
 * @param name Stable event-name stem. Emits `<name>_degraded` on failure.
 * @param fn The operation.
 * @param fallback Value returned when `fn` throws.
 * @param fields Extra fields for the warning.
 * @returns `fn`'s result, or `fallback` if it threw.
 */
export async function withFallback<T>(
  name: string,
  fn: () => T | Promise<T>,
  fallback: T,
  fields?: Record<string, unknown>,
): Promise<T> {
  try {
    return await fn();
  } catch (error: unknown) {
    logger.warn(`${name}_degraded`, { ...fields, ...describeError(error) });
    return fallback;
  }
}
