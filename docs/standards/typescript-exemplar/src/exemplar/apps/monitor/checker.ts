/**
 * The IO half of a check: perform the request, time it, report what happened.
 *
 * Deliberately thin and deliberately separate from `evaluator.ts`. This module
 * does the thing that needs a network; the evaluator decides what it means.
 * Anything that needs a live server to test belongs here, and nothing else does.
 */

import type { Logger } from "pino";

import type { CheckResult, CheckTarget } from "../../models/check.ts";
import { elapsedMs, iso, utcNow } from "../../utils/datetime.ts";
import { requestWithRetry, TransportError } from "../../utils/http.ts";
import { classify } from "./evaluator.ts";

/**
 * Check one target once.
 *
 * Never throws. A check that throws would take down the loop that schedules it,
 * so a failure is a RESULT -- that is the whole contract of this function, and
 * why its return type has no error channel.
 *
 * @param target - What to check.
 * @param logger - Bound logger for this target.
 * @returns What happened, including failures.
 *
 * @example
 * ```ts
 * const result = await checkOnce(target, logger);
 * // result.status is "up" | "down" | "degraded" | "unknown"
 * ```
 */
export async function checkOnce(
  target: CheckTarget,
  logger: Logger,
): Promise<CheckResult> {
  const startedAt = utcNow();

  try {
    const response = await requestWithRetry(target.url, {
      timeoutMs: target.timeoutMs,
      logger,
    });
    const durationMs = elapsedMs(startedAt);
    const status = classify(target, response.status, null);

    logger.info(
      {
        target: target.name,
        status,
        status_code: response.status,
        duration_ms: durationMs,
      },
      "check complete",
    );

    return {
      targetName: target.name,
      status,
      statusCode: response.status,
      durationMs,
      error: null,
      recordedAt: iso(startedAt),
    };
  } catch (error: unknown) {
    // Narrow, never cast. `error as Error` would be a lie for a thrown string,
    // and the lie only surfaces where .message is read.
    const message =
      error instanceof TransportError
        ? `${error.message}: ${String(error.cause)}`
        : error instanceof Error
          ? error.message
          : String(error);

    const durationMs = elapsedMs(startedAt);

    // Logged, not swallowed. A silent catch here is the exact defect that
    // produced ~1,100 bare `catch {}` blocks while CI stayed green.
    logger.error(
      {
        target: target.name,
        duration_ms: durationMs,
        err: error instanceof Error ? error : new Error(message),
      },
      "check failed",
    );

    return {
      targetName: target.name,
      status: classify(target, null, message),
      statusCode: null,
      durationMs,
      error: message,
      recordedAt: iso(startedAt),
    };
  }
}
