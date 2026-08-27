/**
 * Logging decoration seam.
 *
 * Design authority: `_DOCS/STANDARDS-observability.md` owns the envelope and
 * `_plans/server-hardening-ladder.md` rung L3 ("one logger, threaded") owns the
 * seam, gated by `scripts/done-means/750-l3-logger-threaded.sh`.
 *
 * The rung exists so that exactly one logger is constructed, in
 * `server/main.ts`, and every other module receives it. This file therefore
 * never imports `./logger.ts` for construction: the logger arrives as a
 * parameter. Threading it through every signature by hand is the alternative
 * this seam replaces — `withLogging` wraps a plain function or closure and
 * `logged` decorates a class method, so a call site gains entry, exit, and
 * failure lines without its signature changing.
 *
 * Failures always rethrow. A wrapper that swallows a throw to log it has
 * replaced a loud defect with a quiet one, and the emitted failure line carries
 * `stack` plus the ambient correlation id from `./context.ts` so the failure
 * ties back to the request that caused it across await boundaries.
 */
import type { Logger } from "pino";
import { sanitizeValue } from "./sanitize.ts";

/** Any function the seam can wrap, synchronous or asynchronous. */
type AnyFunction = (...args: never[]) => unknown;

export interface DecorationOptions {
  /** The logger this call site was given. Never constructed here. */
  readonly logger: Logger;
  /** Operation name recorded on every emitted line. */
  readonly name: string;
  /** Extra structured fields merged into the entry line. */
  readonly fields?: Record<string, unknown>;
}

export interface MethodDecorationOptions {
  /**
   * Resolved when the method runs, not when the class is defined. A decorator
   * evaluates at class-definition time, which is usually before the
   * composition root has built the logger, so an eager value would pin the
   * wrong one — or nothing at all.
   */
  readonly logger: () => Logger;
  readonly name: string;
  readonly fields?: Record<string, unknown>;
}

function elapsedMs(started: number): number {
  return Math.round(performance.now() - started);
}

function logEntry(options: DecorationOptions): Logger {
  const operationLogger = options.logger.child({ operation: options.name });
  operationLogger.debug(
    sanitizeValue(options.fields ?? {}) as Record<string, unknown>,
    "operation_entry",
  );
  return operationLogger;
}

function logExit(operationLogger: Logger, started: number): void {
  operationLogger.info({ duration_ms: elapsedMs(started) }, "operation_result");
}

function logFailure(
  operationLogger: Logger,
  started: number,
  error: unknown,
): void {
  operationLogger.error(
    {
      duration_ms: elapsedMs(started),
      error: {
        ...(sanitizeValue(error) as Record<string, unknown>),
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    },
    "operation_failure",
  );
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Run one call under the seam.
 *
 * A synchronous function must stay synchronous — awaiting it would turn a
 * plain return value into a promise and change every caller — so the result is
 * only chained when it is actually thenable.
 */
function runDecorated(
  options: DecorationOptions,
  invoke: () => unknown,
): unknown {
  const started = performance.now();
  const operationLogger = logEntry(options);
  let result: unknown;
  try {
    result = invoke();
  } catch (error: unknown) {
    logFailure(operationLogger, started, error);
    throw error;
  }
  if (!isThenable(result)) {
    logExit(operationLogger, started);
    return result;
  }
  return result.then(
    (resolved: unknown) => {
      logExit(operationLogger, started);
      return resolved;
    },
    (error: unknown) => {
      logFailure(operationLogger, started, error);
      throw error;
    },
  );
}

/**
 * Wrap a synchronous or asynchronous function with entry, exit, and failure
 * logging through the injected logger. Arguments, return value, and thrown
 * errors all pass through unchanged.
 */
export function withLogging<F extends AnyFunction>(
  options: DecorationOptions,
  fn: F,
): F {
  const wrapped = function wrappedWithLogging(
    this: unknown,
    ...args: Parameters<F>
  ): ReturnType<F> {
    return runDecorated(options, () =>
      Reflect.apply(fn, this, args),
    ) as ReturnType<F>;
  };
  return wrapped as unknown as F;
}

/**
 * Decorate a class method with the same entry, exit, and failure logging.
 *
 * The logger is supplied by a thunk so it is read at call time; see
 * `MethodDecorationOptions.logger`.
 */
export function logged<F extends AnyFunction>(
  options: MethodDecorationOptions,
): (value: F, context: ClassMethodDecoratorContext) => F {
  return function applyLogged(value: F, _context: ClassMethodDecoratorContext) {
    const decorated = function decoratedMethod(
      this: unknown,
      ...args: Parameters<F>
    ): ReturnType<F> {
      const resolved: DecorationOptions = {
        logger: options.logger(),
        name: options.name,
        ...(options.fields === undefined ? {} : { fields: options.fields }),
      };
      return runDecorated(resolved, () =>
        Reflect.apply(value, this, args),
      ) as ReturnType<F>;
    };
    return decorated as unknown as F;
  };
}
