/**
 * What ONE provider attempt decides: retry after a delay, or stop with an
 * `EmbeddingError`.
 *
 * Split out of `./provider.ts` (issue 864) because the retry loop there carried
 * every branch inline and failed the whole-file lint the moment the file moved
 * under `server/`. Nothing about the decisions changed: each function below is
 * the branch that used to sit in the loop body, with the same order, the same
 * comparisons, the same log events and fields, and the same messages. The loop
 * keeps the parts that need its own state — the abort wiring, the timeout, and
 * `lastError`.
 */
import { logger } from "../../src/logger.ts";
import type { EmbeddingError, EmbeddingResult } from "./provider.ts";

/** Milliseconds waited before each retry, indexed by the attempt just made. */
export const BACKOFF_DELAYS_MS = [200, 800];

/** Fallback delay when an attempt index runs past `BACKOFF_DELAYS_MS`. */
const DEFAULT_BACKOFF_MS = 800;

/** Retry after `delayMs`, or stop with `error`. Never both. */
export type AttemptOutcome =
  | { readonly retry: true; readonly delayMs: number }
  | { readonly retry: false; readonly error: EmbeddingError };

function backoffFor(attempt: number): number {
  return BACKOFF_DELAYS_MS[attempt - 1] ?? DEFAULT_BACKOFF_MS;
}

/**
 * Decide what a non-`ok` HTTP response means.
 *
 * 4xx is never retried and 5xx is retried while attempts remain, which is the
 * same rule `isTransient` applies to a thrown error.
 */
export function classifyHttpFailure(input: {
  readonly status: number;
  readonly attempt: number;
  readonly totalAttempts: number;
}): AttemptOutcome {
  const { status, attempt, totalAttempts } = input;

  if (status >= 400 && status < 500) {
    const code: EmbeddingError["code"] =
      status === 400 || status === 422 ? "input_invalid" : "client_error";
    logger.error("Embedding provider request failed (non-retryable)", {
      status,
      attempts: attempt,
    });
    return {
      retry: false,
      error: {
        code,
        message: `Embedding provider returned ${status}`,
        attempts: attempt,
        lastStatus: status,
      },
    };
  }

  if (attempt < totalAttempts) {
    const delayMs = backoffFor(attempt);
    logger.warn("Embedding request failed, retrying", {
      attempt,
      status,
      code: "server_error",
      delayMs,
    });
    return { retry: true, delayMs };
  }

  logger.error("Embedding request failed after all attempts", {
    status,
    attempts: attempt,
  });
  return {
    retry: false,
    error: {
      code: "server_error",
      message: `Embedding provider returned ${status} after ${attempt} attempt(s)`,
      attempts: attempt,
      lastStatus: status,
    },
  };
}

/**
 * Classify whether an error or HTTP status is transient and worth retrying.
 * Only 5xx, AbortError (timeout), and network-level errors are retried.
 * 4xx errors are never retried.
 */
export function isTransient(err: unknown, status?: number): boolean {
  if (status !== undefined && status >= 400 && status < 500) return false;
  if (status !== undefined && status >= 500) return true;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (!(err instanceof Error)) return false;
  return TRANSIENT_MESSAGE_FRAGMENTS.some((fragment) => err.message.includes(fragment));
}

/** Substrings that mark a fetch rejection as a network-level, retryable one. */
const TRANSIENT_MESSAGE_FRAGMENTS = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "fetch failed",
];

export function classifyError(err: unknown, status?: number): EmbeddingError["code"] {
  if (err instanceof DOMException && err.name === "AbortError") return "timeout";
  if (status !== undefined && status >= 500) return "server_error";
  return "network";
}

/** Decide what a thrown `fetch` rejection means. */
export function classifyThrownFailure(input: {
  readonly err: unknown;
  readonly attempt: number;
  readonly totalAttempts: number;
  readonly lastStatus?: number;
}): AttemptOutcome {
  const { err, attempt, totalAttempts, lastStatus } = input;
  const code = classifyError(err);
  const message = err instanceof Error ? err.message : String(err);

  if (!isTransient(err)) {
    logger.error("Embedding request failed (non-retryable)", {
      error: message,
      attempts: attempt,
    });
    return {
      retry: false,
      error: {
        code,
        message,
        attempts: attempt,
        ...(lastStatus === undefined ? {} : { lastStatus }),
      },
    };
  }

  if (attempt < totalAttempts) {
    const delayMs = backoffFor(attempt);
    logger.warn("Embedding request failed, retrying", {
      attempt,
      code,
      error: message,
      delayMs,
    });
    return { retry: true, delayMs };
  }

  logger.error("Embedding request failed after all attempts", {
    error: message,
    code,
    attempts: attempt,
  });
  return {
    retry: false,
    error: {
      code,
      message: `${message} after ${attempt} attempt(s)`,
      attempts: attempt,
      ...(lastStatus === undefined ? {} : { lastStatus }),
    },
  };
}

/** Pick out the two numeric usage counters the provider may report. */
function readUsageDetails(
  usage:
    | {
        prompt_tokens?: unknown;
        total_tokens?: unknown;
      }
    | undefined,
): Record<string, number> {
  const usageDetails: Record<string, number> = {};
  if (typeof usage?.prompt_tokens === "number") {
    usageDetails.promptTokens = usage.prompt_tokens;
  }
  if (typeof usage?.total_tokens === "number") {
    usageDetails.totalTokens = usage.total_tokens;
  }
  return usageDetails;
}

/** Either a usable result or the error that says why the body was unusable. */
export type DecodedResponse =
  | { readonly error: EmbeddingError; readonly result?: undefined }
  | { readonly error?: undefined; readonly result: EmbeddingResult };

/** Read the provider body and check the vector is the width we asked for. */
export async function decodeEmbeddingResponse(input: {
  readonly response: Response;
  readonly expectedDimensions: number;
  readonly attempt: number;
}): Promise<DecodedResponse> {
  const { response, expectedDimensions, attempt } = input;
  const json = (await response.json()) as {
    data?: Array<{ embedding?: unknown }>;
    usage?: { prompt_tokens?: unknown; total_tokens?: unknown };
  };

  const embedding = json.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== expectedDimensions) {
    const message = "Embedding provider returned malformed embedding";
    logger.error(message, {
      hasData: !!json.data,
      length: Array.isArray(embedding) ? embedding.length : "not-array",
      expectedLength: expectedDimensions,
      attempts: attempt,
    });
    return {
      error: {
        code: "malformed_response",
        message,
        attempts: attempt,
        lastStatus: response.status,
      },
    };
  }

  const usageDetails = readUsageDetails(json.usage);

  return {
    result: {
      embedding: embedding as number[],
      ...(Object.keys(usageDetails).length === 0 ? {} : { usageDetails }),
    },
  };
}
