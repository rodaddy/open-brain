/**
 * HTTP with retry, backoff, jitter, and a hard timeout.
 *
 * WHY THIS IS HAND-WRITTEN WHEN THE PYTHON SIDE USES A LIBRARY
 *
 * This is the one place the two exemplars deliberately differ, and the
 * difference IS the lesson.
 *
 * `_DOCS/STANDARDS-python.md ## LAW: do not hand-roll a solved problem` says to
 * search before writing, in this order: repo helper, maintained library, stdlib,
 * custom. Python's `utils/http.py` obeys it by deleting ~90 lines of attempt
 * counters and jitter arithmetic in favour of `tenacity`.
 *
 * Applying the SAME law here produces a different answer, because the ecosystem
 * is different:
 *
 *   - `fetch` is now in the standard library (Node 18+), so the transport layer
 *     needs no dependency at all -- axios and got are both, for this purpose,
 *     a dependency in place of one built-in call.
 *   - `AbortSignal.timeout()` is stdlib and replaces every hand-rolled timeout
 *     race. This is the STDLIB tier of the law and it is the correct tier.
 *   - Retry-with-backoff is genuinely not in the stdlib, and the maintained
 *     options (p-retry, cockatiel, async-retry) are small wrappers over the
 *     ~40 lines below.
 *
 * So: stdlib for the transport and the timeout, a small local loop for the
 * retry policy. The law is "do not reinvent what a maintained thing already
 * does well", NOT "always add a dependency" -- and it says stdlib ranks ABOVE
 * a third-party library. Reaching for `axios` here to mirror `tenacity` there
 * would be cargo-culting the answer instead of applying the rule.
 *
 * If this file grows a circuit breaker, a bulkhead, or a hedging policy, the
 * calculus flips and `cockatiel` becomes correct. The comment stays so the next
 * person can tell that this was decided rather than defaulted.
 *
 * @see _DOCS/STANDARDS-python.md ## LAW: do not hand-roll a solved problem
 */

import type { Logger } from "pino";

import { elapsedMs, utcNow } from "./datetime.ts";

/** How a request should retry. */
export interface RetryPolicy {
  /** Total attempts INCLUDING the first. 1 disables retry. */
  maxAttempts: number;
  /** Delay before the first retry, doubling from there. */
  initialDelayMs: number;
  /** Ceiling for the exponential growth, before jitter. */
  maxDelayMs: number;
  /**
   * Random extra milliseconds ADDED to each delay, 0..jitterMs.
   *
   * Additive on top of the cap, matching `tenacity.wait_exponential_jitter` on
   * the Python side, so a wait can exceed `maxDelayMs` by up to this much.
   * Documented because the alternative -- subtracting jitter -- makes the
   * shortest wait the most common one under load, which is backwards.
   *
   * Without jitter, N clients that fail together retry together forever. That
   * is the thundering herd, and it is why the field is not optional.
   */
  jitterMs: number;
}

/** The default policy. Tuned for a health check, not a bulk transfer. */
export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 5_000,
  jitterMs: 250,
};

/**
 * Every attempt failed.
 *
 * A named class rather than a bare `Error`: the caller can distinguish
 * "the remote is down" from a programming error, which `instanceof Error`
 * cannot.
 */
export class TransportError extends Error {
  override readonly name = "TransportError";

  constructor(
    readonly url: string,
    readonly attempts: number,
    override readonly cause: unknown,
  ) {
    super(`${url} failed after ${String(attempts)} attempt(s)`);
  }
}

/** HTTP statuses worth retrying: transient by definition. */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([
  408, 425, 429, 500, 502, 503, 504,
]);

/**
 * Whether a response should be retried.
 *
 * A lookup rather than an `if`/`else if` ladder -- `STANDARDS-typescript.md
 * ## Control flow`. Adding a status is one entry in the set above.
 */
function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** Exponential backoff with additive jitter, capped. */
function delayFor(attempt: number, policy: RetryPolicy): number {
  const exponential = policy.initialDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  return capped + Math.random() * policy.jitterMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Options for {@link requestWithRetry}. */
export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Hard ceiling per attempt, enforced with `AbortSignal.timeout`. */
  timeoutMs: number;
  policy?: RetryPolicy;
  /** Bound child logger. Omit to stay silent. */
  logger?: Logger;
}

/**
 * Perform an HTTP request, retrying transient failures.
 *
 * Retries on network errors, timeouts, and the statuses in
 * {@link RETRYABLE_STATUS}. A 4xx other than 408/425/429 is returned as-is:
 * retrying a 404 or a 401 cannot succeed and only delays the real error.
 *
 * @param url - Absolute URL.
 * @param options - Method, headers, body, timeout, policy, logger.
 * @returns The successful (or non-retryable) response.
 * @throws {TransportError} When every attempt fails.
 *
 * @example
 * ```ts
 * const res = await requestWithRetry("https://example.test/health", {
 *   timeoutMs: 5_000,
 * });
 * ```
 */
/**
 * The outcome of ONE attempt: either a response worth returning, or the reason
 * this attempt failed.
 *
 * A discriminated union rather than `Response | Error`, because the caller must
 * not have to guess which it got -- `done` is checkable, `instanceof` is a
 * narrowing chore that gets it wrong the first time somebody throws a string.
 */
type Attempt = { done: true; response: Response } | { done: false; error: unknown };

/**
 * Build the `fetch` init from options.
 *
 * Extracted purely to keep the conditional spreads out of the attempt
 * function's complexity budget -- `exactOptionalPropertyTypes` makes each
 * optional header/body a ternary, and three of those is a third of the budget
 * spent on plumbing rather than on logic.
 */
function fetchInit(options: RequestOptions, method: string): RequestInit {
  return {
    method,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.body === undefined ? {} : { body: options.body }),
    // stdlib timeout. A hand-rolled Promise.race leaks the losing promise and
    // never cancels the underlying socket.
    signal: AbortSignal.timeout(options.timeoutMs),
  };
}

/**
 * Make one attempt and classify the result. Never throws.
 *
 * WHY THIS IS ITS OWN FUNCTION
 *
 * `requestWithRetry` scored 12 against the `complexity: 10` ceiling with this
 * inlined, and the split is the fix the rule is designed to force rather than a
 * workaround for it. The two jobs really are separate: this one decides
 * "did THIS attempt succeed", the caller decides "should we try again". Each is
 * now testable without the other -- you can assert the classification of a 503
 * without waiting through a backoff.
 *
 * @param url - Absolute URL.
 * @param options - The caller's options.
 * @param method - Resolved method.
 * @param attempt - 1-based attempt number, for the log line only.
 * @returns Whether to stop, and with what.
 */
async function attemptOnce(
  url: string,
  options: RequestOptions,
  method: string,
  attempt: number,
): Promise<Attempt> {
  const startedAt = utcNow();

  try {
    const response = await fetch(url, fetchInit(options, method));

    if (!isRetryableStatus(response.status)) {
      return { done: true, response };
    }

    options.logger?.warn(
      {
        url,
        method,
        attempt,
        status: response.status,
        duration_ms: elapsedMs(startedAt),
      },
      "retryable status",
    );
    return { done: false, error: new Error(`HTTP ${String(response.status)}`) };
  } catch (error: unknown) {
    // `catch (error: unknown)` and narrow -- never `catch (e: any)`, never
    // `error as Error`. STANDARDS-typescript.md ## Typing.
    options.logger?.warn(
      {
        url,
        method,
        attempt,
        duration_ms: elapsedMs(startedAt),
        err: error instanceof Error ? error : new Error(String(error)),
      },
      "request failed",
    );
    return { done: false, error };
  }
}

export async function requestWithRetry(
  url: string,
  options: RequestOptions,
): Promise<Response> {
  const policy = options.policy ?? DEFAULT_RETRY;
  const method = options.method ?? "GET";
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const result = await attemptOnce(url, options, method, attempt);
    if (result.done) return result.response;

    lastError = result.error;

    if (attempt < policy.maxAttempts) {
      await sleep(delayFor(attempt, policy));
    }
  }

  throw new TransportError(url, policy.maxAttempts, lastError);
}
