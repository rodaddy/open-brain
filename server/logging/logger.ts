/**
 * Structured Pino logging composition.
 *
 * Design authority: `_DOCS/STANDARDS-observability.md` owns the JSON envelope,
 * dual destinations, per-worker rotation, redaction, and operation signals.
 */
import { parse, format } from "node:path";
import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import type { ServerConfig } from "../config.ts";
import { correlationId } from "./context.ts";
import { sanitizeValue } from "./sanitize.ts";

const REDACT_PATHS = [
  "password",
  "passphrase",
  "secret",
  "token",
  "api_key",
  "authorization",
  "cookie",
  "session",
  "credential",
  "private_key",
  "*.password",
  "*.passphrase",
  "*.secret",
  "*.token",
  "*.api_key",
  "*.authorization",
  "*.cookie",
  "*.session",
  "*.credential",
  "*.private_key",
];

/** Derive a rotation chain unique to one worker process. */
export function workerLogPath(file: string, workerName: string): string {
  const safeWorker = workerName.replace(/[^A-Za-z0-9._-]/g, "_");
  const parsed = parse(file);
  return format({ dir: parsed.dir, name: `${parsed.name}.${safeWorker}`, ext: parsed.ext });
}

/** Build the common Pino envelope independently of its destination. */
export function loggerOptions(config: ServerConfig["logging"]): LoggerOptions {
  return {
    level: config.level,
    base: { service: config.service, worker: config.workerName },
    messageKey: "message",
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: {
      level: (level) => ({ level }),
      log: (fields) => sanitizeValue(fields) as Record<string, unknown>,
    },
    mixin: () => ({ correlation_id: correlationId() }),
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  };
}

/**
 * Create JSON stdout plus the required rotating per-worker file transport.
 *
 * Fan-out is in-process `pino.multistream`, NOT a multi-target
 * `pino.transport`. The difference is not stylistic — the multi-target form
 * silently discarded every line this logger ever emitted (#612).
 *
 * Why: `loggerOptions` sets `formatters.level` to render the level as the
 * string `"info"` rather than pino's numeric `30`, which the shared envelope
 * requires (`_DOCS/STANDARDS-observability.md`, "Structured output and
 * required fields"). Multi-target transports route on that serialized value:
 *
 *   - `pino/lib/worker.js:126` — a SINGLE target returns its stream directly
 *     with no level routing, which is why every unit test passed. Two or more
 *     targets go through `pino.multistream` in the transport worker instead.
 *   - `pino-abstract-transport/index.js:49` — `stream.lastLevel = value.level`,
 *     read straight off the parsed JSON with no label-to-number mapping.
 *   - `pino/lib/multistream.js:61` — selects destinations with
 *     `dest.level <= level`.
 *
 * So the comparison performed for every line was `30 <= "info"` — false for
 * every destination — and multistream wrote the line nowhere. No error, no
 * warning, no dropped-line counter: the service logged into a void for as long
 * as the server path has existed. Measured on the live clone before the fix:
 * zero pino lines of any kind in the clone log against 3,465 lines from the
 * legacy `src/logger.ts` module logger, which is why the symptom looked
 * specific to child loggers rather than total.
 *
 * In-process multistream is immune because it takes its routing level from
 * pino's own numeric level via the metadata symbol, BEFORE `formatters.level`
 * rewrites the serialized field. The envelope is therefore unchanged — string
 * level, `timestamp`, `service`, `worker`, `correlation_id`, `message` all
 * emit exactly as before — and both required destinations receive every line.
 *
 * `pino.transport` is still used for the file half, with a SINGLE target,
 * which keeps `pino-roll`'s rotation off the main thread and stays on the
 * safe single-target path above.
 *
 * Passing `levels` explicitly rather than relying on the default keeps the
 * label-to-number map owned here, next to the formatter that makes it matter.
 */
export function createLogTransport(config: ServerConfig["logging"]): DestinationStream {
  const rotatingFile = pino.transport({
    target: "pino-roll",
    options: {
      file: workerLogPath(config.file, config.workerName),
      size: "1m",
      limit: { count: 3 },
      mkdir: true,
    },
  });
  return pino.multistream(
    [{ stream: process.stdout }, { stream: rotatingFile }],
    { levels: pino.levels.values },
  );
}

/** Create the service logger; tests may inject an in-memory destination. */
export function createLogger(
  config: ServerConfig["logging"],
  destination: DestinationStream = createLogTransport(config),
): Logger {
  return pino(loggerOptions(config), destination);
}

export interface OperationInput<T> {
  readonly logger: Logger;
  readonly name: string;
  readonly work: () => Promise<T>;
  readonly fields?: Record<string, unknown>;
}

/** Emit entry, result/duration, and failure for one asynchronous operation. */
export async function withOperation<T>(input: OperationInput<T>): Promise<T> {
  const started = performance.now();
  const operationLogger = input.logger.child({ operation: input.name });
  operationLogger.debug(sanitizeValue(input.fields ?? {}), "operation_entry");
  try {
    const result = await input.work();
    operationLogger.info(
      { duration_ms: Math.round(performance.now() - started) },
      "operation_result",
    );
    return result;
  } catch (error: unknown) {
    operationLogger.error(
      {
        duration_ms: Math.round(performance.now() - started),
        error: sanitizeValue(error),
      },
      "operation_failure",
    );
    throw error;
  }
}
