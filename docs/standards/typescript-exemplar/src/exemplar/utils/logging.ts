/**
 * Logging -- one configured logger, three sinks, correlation ids that survive
 * `await`.
 *
 * THIS IS THE ONLY MODULE ALLOWED TO TOUCH `console`.
 *
 * `eslint.config.js` sets `no-console: error` repo-wide and turns it off for
 * this one file. That is deliberate: a rule with a global exception is not a
 * rule, and "never `console.log` outside the logging module" is only true if
 * something checks.
 *
 * WHY THREE SINKS
 *
 * They answer three different questions and no single format answers all three:
 *
 *   - **console** (pretty, human) -- "what is happening right now", read by a
 *     person watching a terminal during development or an incident.
 *   - **file** (JSON lines, rotated) -- "what happened an hour ago", read after
 *     the fact when the terminal is long gone.
 *   - **structured** (JSON to stdout in production) -- "what happened across
 *     every instance", read by a log aggregator that needs machine-parseable
 *     fields, not prose.
 *
 * Collapsing to one sink means either a human squints at JSON during an
 * incident, or the aggregator gets prose it cannot index.
 *
 * WHY `AsyncLocalStorage` FOR CORRELATION IDS
 *
 * A correlation id threaded by hand gets dropped -- not maybe, reliably, at the
 * first function somebody adds without thinking about logging. `AsyncLocalStorage`
 * carries it across every `await` in the call chain without a single parameter
 * being passed, so a log line written five layers deep still names the request
 * that caused it.
 *
 * @see _DOCS/STANDARDS-typescript.md ## Logging and observability
 * @see _DOCS/CODING_STANDARDS.md ## Observability (non-negotiable, all languages)
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import pino from "pino";
import type { Logger } from "pino";

/** Fields carried automatically on every log line within a request. */
export interface LogContext {
  /** Ties every line produced by one request/job together. */
  correlationId: string;
  /** Which app wrote the line, when several share a log destination. */
  service?: string;
}

/**
 * The store that makes correlation ids survive `await`.
 *
 * Module-level and intentionally so: there is exactly one async context per
 * process, and passing it around would recreate the threading problem it
 * exists to remove.
 */
const contextStore = new AsyncLocalStorage<LogContext>();

/**
 * Run a function with a log context bound to it.
 *
 * Every log line written inside `fn` -- including from functions it calls, and
 * after any `await` -- carries these fields without being told.
 *
 * @param context - Fields to attach to every line in this scope.
 * @param fn - The work to run.
 * @returns Whatever `fn` returns.
 *
 * @example
 * ```ts
 * await withLogContext({ correlationId: crypto.randomUUID() }, async () => {
 *   await handleRequest();   // every line inside carries the id
 * });
 * ```
 */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return contextStore.run(context, fn);
}

/** The context bound to the current async scope, if any. */
export function currentLogContext(): LogContext | undefined {
  return contextStore.getStore();
}

/** How verbose a logger should be. A union, not a TS `enum`. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** What a logger needs to know at construction. */
export interface LoggingOptions {
  /** Name bound to every line, so shared destinations stay attributable. */
  service: string;
  level: LogLevel;
  /** Absolute path for the rotating JSON sink. Omit to disable the file sink. */
  filePath?: string;
  /** Pretty-print to the console. False in production, where JSON is wanted. */
  pretty: boolean;
}

/**
 * Build the configured root logger for a service.
 *
 * Called ONCE per process, at startup, by the entry point -- never at a call
 * site. Assembling a logger where it is used means the configuration silently
 * differs between modules and there is no single place to change it.
 *
 * @param options - Service name, level, and sink configuration.
 * @returns A logger with the correlation id mixed into every line.
 *
 * @example
 * ```ts
 * const logger = createLogger({ service: "monitor", level: "info", pretty: true });
 * logger.info({ target: "api" }, "check starting");
 * ```
 */
export function createLogger(options: LoggingOptions): Logger {
  const targets: pino.TransportTargetOptions[] = [];

  targets.push(
    options.pretty
      ? {
          target: "pino-pretty",
          level: options.level,
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        }
      : { target: "pino/file", level: options.level, options: { destination: 1 } },
  );

  if (options.filePath !== undefined) {
    // mkdir before pino opens the file: pino's file transport does not create
    // the directory and the failure surfaces as an unhandled error inside a
    // worker thread, which points nowhere near the real cause.
    mkdirSync(dirname(options.filePath), { recursive: true });
    targets.push({
      target: "pino/file",
      level: options.level,
      options: { destination: options.filePath, mkdir: true },
    });
  }

  return pino({
    level: options.level,
    base: { service: options.service },

    // `mixin` runs per log call, which is what makes the correlation id
    // automatic. Binding it once with .child() would capture whatever context
    // existed when the child was created -- for a long-lived service logger,
    // that is no context at all.
    mixin(): Record<string, unknown> {
      const context = contextStore.getStore();
      return context === undefined ? {} : { correlation_id: context.correlationId };
    },

    // NEVER spread a raw error into a log entry: an Error from a HTTP client
    // commonly carries the request, its headers, and therefore credentials.
    // pino's stdSerializer emits type/message/stack and nothing else.
    serializers: { err: pino.stdSerializers.err },

    transport: { targets },
  });
}
