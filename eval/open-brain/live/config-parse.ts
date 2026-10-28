// Per-field env parsers for the live recall gate configuration.
//
// Split out of config.ts (issue 752) so `loadLiveConfig` stays under the repo
// complexity rule value. Nothing about the validation boundary changed: each
// helper below is a verbatim lift of one field's checks out of the original
// function body, so every thrown message, every default, and every accepted
// shape is identical. `loadLiveConfig` is now composition over these.
//
// These are internal helpers of the config module. config.ts does NOT re-export
// them, so no import specifier anywhere in the repo moves.

const DEFAULT_TIMEOUT_MS = 15_000;

/** The recall search mode, hybrid by default. */
export type LiveSearchMode = "hybrid" | "vector" | "keyword";

/**
 * The base URL the gate talks to. Rejects a malformed URL up front rather than
 * deep in the transport.
 */
export function parseBaseUrl(env: NodeJS.ProcessEnv): string {
  const baseUrl = (env.OPEN_BRAIN_LIVE_EVAL_BASE_URL ?? "").trim();
  if (!baseUrl) {
    throw new Error("OPEN_BRAIN_LIVE_EVAL_BASE_URL is required for the live gate");
  }
  try {
    // eslint-disable-next-line no-new
    new URL(baseUrl);
  } catch {
    throw new Error("OPEN_BRAIN_LIVE_EVAL_BASE_URL is not a valid URL");
  }
  return baseUrl;
}

/** The bearer token used to seed + read + archive the primary namespace. */
export function parsePrimaryToken(env: NodeJS.ProcessEnv): string {
  const primaryToken = (env.OPEN_BRAIN_LIVE_EVAL_TOKEN ?? "").trim();
  if (!primaryToken) {
    throw new Error("OPEN_BRAIN_LIVE_EVAL_TOKEN is required for the live gate");
  }
  return primaryToken;
}

/**
 * Resolve the negative-control credential.
 *
 * A real negative control is mandatory. It is provided by binding a distinct
 * X-Namespace on the negative session, so the SAME bearer token is a valid
 * negative control -- the header binding is the isolation proof, not token
 * inequality. An operator MAY supply a distinct token to also cover cross-token
 * denial; when supplied it must differ from the primary token (an identical
 * token would be a no-op that hides a misconfiguration).
 */
export function parseNegativeToken(
  env: NodeJS.ProcessEnv,
  primaryToken: string,
): { negativeToken: string; negativeTokenIsDistinct: boolean } {
  const negativeTokenRaw = (env.OPEN_BRAIN_LIVE_EVAL_NEGATIVE_TOKEN ?? "").trim();
  if (negativeTokenRaw.length === 0) {
    return { negativeToken: primaryToken, negativeTokenIsDistinct: false };
  }
  if (negativeTokenRaw === primaryToken) {
    throw new Error(
      "OPEN_BRAIN_LIVE_EVAL_NEGATIVE_TOKEN, when set, must differ from OPEN_BRAIN_LIVE_EVAL_TOKEN; leave it unset to use the same token with a distinct negative namespace",
    );
  }
  return { negativeToken: negativeTokenRaw, negativeTokenIsDistinct: true };
}

/** The recall search mode; hybrid by default to exercise the full retriever. */
export function parseSearchMode(env: NodeJS.ProcessEnv): LiveSearchMode {
  const searchModeRaw = (env.OPEN_BRAIN_LIVE_EVAL_SEARCH_MODE ?? "hybrid").trim();
  if (
    searchModeRaw !== "hybrid" &&
    searchModeRaw !== "vector" &&
    searchModeRaw !== "keyword"
  ) {
    throw new Error(
      "OPEN_BRAIN_LIVE_EVAL_SEARCH_MODE must be one of hybrid, vector, keyword",
    );
  }
  return searchModeRaw;
}

/** The per-request timeout in milliseconds, defaulted when unset or empty. */
export function parseTimeoutMs(env: NodeJS.ProcessEnv): number {
  const timeoutRaw = env.OPEN_BRAIN_LIVE_EVAL_TIMEOUT_MS;
  if (timeoutRaw === undefined || timeoutRaw.trim() === "") {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(timeoutRaw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    throw new Error("OPEN_BRAIN_LIVE_EVAL_TIMEOUT_MS must be a positive integer");
  }
  return parsed;
}
