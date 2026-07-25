/**
 * Observability surface for open-brain.
 *
 * Implements the shared contract in `_DOCS/CODING_STANDARDS.md`
 * (`## Observability` + `### TypeScript observability spellings`). rtech-infra's
 * standards repo will eventually publish this as an installable package; this
 * module is open-brain's conforming implementation until then, and is
 * deliberately shaped so it can be swapped for that import.
 *
 * The whole surface a service author needs:
 *
 * ```ts
 * import { logger, withContext, withLogging } from "./observability/index.ts";
 *
 * await withContext({ correlation_id: requestId }, async () => {
 *   await withLogging("lane_context_load", async () => {
 *     if (!lane) logger.warn("lane_scope_miss", { session_key });
 *   });
 * });
 * ```
 *
 * Rules this exists to make cheaper to follow than to break:
 *
 * - **Silence is a signal.** No log line must reliably mean success, so every
 *   degraded path emits a warning. `withFallback()` makes a deliberate
 *   fail-open one call instead of a silent `catch { return null }`.
 * - **Never swallow an error.** `withLogging()` logs and re-throws.
 * - **One envelope.** `timestamp`, `level`, `message`, `service`, and
 *   `correlation_id` are stamped by the logger, never supplied by callers, so
 *   application and infrastructure logs share one Loki query surface.
 * - **`message` is a stable event name**, never a sentence.
 *
 * Emission stays deliberately dumb: structured JSON to stdout plus a rotating
 * file (1 MB, 3 retained). Shipping is not this process's job — Alloy tails the
 * output into Loki. The application must never know its destination.
 */
export { logger } from "../logger.ts";
export {
  withContext,
  currentContext,
  currentCorrelationId,
  type LogContext,
} from "./context.ts";
export { withLogging, withFallback, describeError } from "./with-logging.ts";
