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

/** Create JSON stdout plus the required rotating per-worker file transport. */
export function createLogTransport(config: ServerConfig["logging"]): DestinationStream {
  return pino.transport({
    targets: [
      { target: "pino/file", options: { destination: 1 } },
      {
        target: "pino-roll",
        options: {
          file: workerLogPath(config.file, config.workerName),
          size: "1m",
          limit: { count: 3 },
          mkdir: true,
        },
      },
    ],
  });
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
