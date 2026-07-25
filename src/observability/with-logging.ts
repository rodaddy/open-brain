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
import { logger } from "../logger.ts";

/**
 * Reduce an unknown thrown value to safe, loggable fields.
 *
 * Never spread a raw error into a log entry — thrown objects routinely carry
 * attached request, response, config, or credential data (`err.request`,
 * `err.config`), and spreading leaks whatever happens to be on them. Only the
 * chosen subset below is emitted.
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
} {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      ...(error.stack ? { error_stack: error.stack } : {}),
    };
  }
  if (typeof error === "string") {
    return { error_name: "ThrownString", error_message: error };
  }
  return {
    error_name: "ThrownNonError",
    error_message: Object.prototype.toString.call(error),
  };
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
