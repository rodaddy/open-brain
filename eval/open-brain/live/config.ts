// Env-gated configuration for the live recall gate.
//
// The gate is OFF unless OPEN_BRAIN_LIVE_EVAL=1 is set, so `bun test` and the
// offline eval never touch a hosted service. When enabled, the gate needs a
// base URL and a bearer token with archive permission AND X-Namespace
// delegation authority (admin / ob-admin), so it can bind a per-run throwaway
// namespace via the X-Namespace header.
//
// The isolation proof is a REAL negative control, not token inequality: the
// negative session reads/writes a sibling namespace via a different X-Namespace
// header. That header binding is what isolates it, so the SAME bearer token is
// permitted for both sessions -- an optional distinct negative token is
// accepted but never required. What is required is that a negative control can
// always be constructed; there is no silent-skip path.
//
// A unique throwaway namespace is derived per run so concurrent or repeated
// runs never collide and teardown only ever targets this run's records.

export interface LiveEvalConfig {
  baseUrl: string;
  /** Token used to seed + read + archive the primary throwaway namespace. */
  primaryToken: string;
  /**
   * Token used for the negative sibling namespace. Defaults to the primary
   * token: isolation is proven by the distinct X-Namespace binding, not by a
   * different token. An operator MAY supply a distinct token to also exercise
   * cross-token denial, but it is never required and, when supplied, must
   * differ from the primary token to be meaningful.
   */
  negativeToken: string;
  /** True when the negative token is a distinct credential from the primary. */
  negativeTokenIsDistinct: boolean;
  /** Per-run unique primary namespace. */
  primaryNamespace: string;
  /** Per-run unique negative (unreadable-from-primary) sibling namespace. */
  negativeNamespace: string;
  /** Recall search mode; hybrid by default to exercise the full retriever. */
  searchMode: "hybrid" | "vector" | "keyword";
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
}

/** True only when the operator has explicitly opted into live execution. */
export function liveEvalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPEN_BRAIN_LIVE_EVAL === "1";
}

/**
 * Derive a unique per-run namespace pair from a run id. The run id is supplied
 * by the caller; the gate constructs it at startup from an operator-provided
 * run id or crypto randomness (see makeRunId), keeping this helper pure and
 * deterministic so unit tests can pin it (no Date.now/random here).
 */
export function runNamespaces(runId: string): {
  primary: string;
  negative: string;
} {
  const safe = runId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  if (safe.length === 0) {
    throw new Error(
      "live eval run id must contain at least one usable character",
    );
  }
  return {
    primary: `eval-live-recall-${safe}`,
    negative: `eval-live-recall-${safe}-negative`,
  };
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Build a per-run id that is unique across repeated runs on the same commit.
 *
 * Precedence:
 *  1. An explicit operator run id (OPEN_BRAIN_LIVE_EVAL_RUN_ID) -- reproducible.
 *  2. A crypto-random suffix combined with a caller-supplied prefix (e.g. the
 *     short commit) so two runs of the same commit never collide.
 *
 * `randomHex` is injected so tests can assert the shape deterministically; the
 * gate passes a crypto.randomUUID-derived value. This function itself never
 * calls Date.now/Math.random, keeping runNamespaces deterministic under test.
 */
export function makeRunId(opts: {
  prefix: string;
  randomHex: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = opts.env ?? process.env;
  const explicit = (env.OPEN_BRAIN_LIVE_EVAL_RUN_ID ?? "").trim();
  if (explicit.length > 0) {
    return explicit;
  }
  const suffix = opts.randomHex.trim();
  if (suffix.length === 0) {
    throw new Error(
      "live eval run id needs an operator run id or a random suffix to stay unique across runs",
    );
  }
  const prefix = opts.prefix.trim();
  return prefix.length > 0 ? `${prefix}-${suffix}` : suffix;
}

/**
 * Build and validate live config from the environment. Throws a precise,
 * secret-free error naming the missing/invalid variable. `runId` is required so
 * the namespace pair is stable for the lifetime of the run and reproducible in
 * tests.
 */
export function loadLiveConfig(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): LiveEvalConfig {
  if (!liveEvalEnabled(env)) {
    throw new Error(
      "Live recall gate is disabled. Set OPEN_BRAIN_LIVE_EVAL=1 to run it.",
    );
  }

  const baseUrl = (env.OPEN_BRAIN_LIVE_EVAL_BASE_URL ?? "").trim();
  if (!baseUrl) {
    throw new Error(
      "OPEN_BRAIN_LIVE_EVAL_BASE_URL is required for the live gate",
    );
  }
  try {
    // Reject a malformed URL up front rather than deep in the transport.
    // eslint-disable-next-line no-new
    new URL(baseUrl);
  } catch {
    throw new Error("OPEN_BRAIN_LIVE_EVAL_BASE_URL is not a valid URL");
  }

  const primaryToken = (env.OPEN_BRAIN_LIVE_EVAL_TOKEN ?? "").trim();
  if (!primaryToken) {
    throw new Error("OPEN_BRAIN_LIVE_EVAL_TOKEN is required for the live gate");
  }

  // A real negative control is mandatory. It is provided by binding a distinct
  // X-Namespace on the negative session, so the SAME bearer token is a valid
  // negative control -- the header binding is the isolation proof, not token
  // inequality. An operator MAY supply a distinct token to also cover
  // cross-token denial; when supplied it must differ from the primary token
  // (an identical token would be a no-op that hides a misconfiguration).
  const negativeTokenRaw = (
    env.OPEN_BRAIN_LIVE_EVAL_NEGATIVE_TOKEN ?? ""
  ).trim();
  let negativeToken = primaryToken;
  let negativeTokenIsDistinct = false;
  if (negativeTokenRaw.length > 0) {
    if (negativeTokenRaw === primaryToken) {
      throw new Error(
        "OPEN_BRAIN_LIVE_EVAL_NEGATIVE_TOKEN, when set, must differ from OPEN_BRAIN_LIVE_EVAL_TOKEN; leave it unset to use the same token with a distinct negative namespace",
      );
    }
    negativeToken = negativeTokenRaw;
    negativeTokenIsDistinct = true;
  }

  const searchModeRaw = (
    env.OPEN_BRAIN_LIVE_EVAL_SEARCH_MODE ?? "hybrid"
  ).trim();
  if (
    searchModeRaw !== "hybrid" &&
    searchModeRaw !== "vector" &&
    searchModeRaw !== "keyword"
  ) {
    throw new Error(
      "OPEN_BRAIN_LIVE_EVAL_SEARCH_MODE must be one of hybrid, vector, keyword",
    );
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const timeoutRaw = env.OPEN_BRAIN_LIVE_EVAL_TIMEOUT_MS;
  if (timeoutRaw !== undefined && timeoutRaw.trim() !== "") {
    const parsed = Number.parseInt(timeoutRaw, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      throw new Error(
        "OPEN_BRAIN_LIVE_EVAL_TIMEOUT_MS must be a positive integer",
      );
    }
    timeoutMs = parsed;
  }

  const { primary, negative } = runNamespaces(runId);

  return {
    baseUrl,
    primaryToken,
    negativeToken,
    negativeTokenIsDistinct,
    primaryNamespace: primary,
    negativeNamespace: negative,
    searchMode: searchModeRaw,
    timeoutMs,
  };
}
