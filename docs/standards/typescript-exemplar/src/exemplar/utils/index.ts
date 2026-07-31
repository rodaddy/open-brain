/**
 * The shared floor: helpers every app uses rather than reinventing.
 *
 * A module earns a place here when the alternative is each app writing its own
 * slightly different version -- which is how a codebase ends up with four retry
 * implementations that back off differently and one that does not jitter.
 *
 * Contents:
 * - {@link module:utils/datetime} -- instants and ISO-8601. The rule is that no
 *   formatting depends on the host timezone, which is JavaScript's quiet
 *   equivalent of Python's naive-datetime trap.
 * - {@link module:utils/http} -- `fetch` with retry, backoff, jitter, and a
 *   hard timeout. Read its header for why this one is local rather than a
 *   dependency; the reasoning is the interesting part.
 * - {@link module:utils/logging} -- three sinks and correlation ids that
 *   survive `await`. The ONLY module permitted to touch `console`.
 *
 * Nothing here imports from `apps/`. The dependency runs one way: apps build on
 * utils, never the reverse. A util that knows about an app is that app's code
 * living in the wrong directory.
 */

export { elapsedMs, iso, parseIso, utcNow } from "./datetime.ts";
export { createLogger, currentLogContext, withLogContext } from "./logging.ts";
export type { LogContext, LoggingOptions, LogLevel } from "./logging.ts";
export { DEFAULT_RETRY, requestWithRetry, TransportError } from "./http.ts";
export type { RequestOptions, RetryPolicy } from "./http.ts";
