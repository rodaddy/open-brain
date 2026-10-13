/**
 * Adapt the legacy logger singleton (`server/logging/legacy-logger.ts`) to this
 * lane's logger shape.
 *
 * The two spellings are genuinely inverted: the legacy logger is
 * `warn(message, fields)` and Pino — what the server composition root builds —
 * is `warn(fields, message)`. Passing one where the other is expected
 * type-checks nowhere useful and, worse, would silently
 * file the message under a field name. So the flip happens ONCE, here, rather
 * than at each legacy root.
 *
 * This exists for the roots that predate `ServerConfig` — today
 * `scripts/run-nats-worker.ts` — and for nothing else. The server root
 * passes its Pino logger straight through, because that logger already has this
 * shape; when those roots move onto the composed logger this file goes with
 * them.
 */
import type { TracingLogger } from "./trace-types.ts";

/** The legacy message-first surface, declared structurally to avoid importing it. */
interface MessageFirstLogger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
}

/** Wrap a message-first logger so it reads as the fields-first shape. */
export function tracingLoggerFrom(legacy: MessageFirstLogger): TracingLogger {
  return {
    info: (fields, message) => legacy.info(message, fields),
    warn: (fields, message) => legacy.warn(message, fields),
  };
}
