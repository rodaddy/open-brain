import { createHash } from "node:crypto";

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

/** Max sanitized run-id length that is copied verbatim into a namespace. */
const MAX_SAFE_RUN_ID_LEN = 80;
/** Hex chars of the deterministic collision-suffix used when bounding. */
const RUN_ID_HASH_LEN = 12;

/**
 * Bound a sanitized run id to a safe length WITHOUT losing uniqueness. A naive
 * `.slice(0, N)` collides whenever two distinct run ids share their first N
 * characters -- which is exactly what happens when a long operator label is
 * suffixed with a per-invocation nonce: the nonce is past the cut and both runs
 * enter the SAME namespace, where the second seed upserts onto the first run's
 * stranded row.
 *
 * Instead, when the sanitized id exceeds the safe length, we keep a truncated
 * prefix and append a deterministic short hash of the FULL sanitized id. Because
 * the hash covers the whole input (including the trailing nonce), two ids that
 * share only the first N characters produce different suffixes and therefore
 * different namespaces. The hash is SHA-256 (pure/deterministic -- no
 * Date.now/random), so this helper stays pinnable in tests.
 */
export function boundRunId(safe: string): string {
  if (safe.length <= MAX_SAFE_RUN_ID_LEN) return safe;
  const hash = createHash("sha256")
    .update(safe)
    .digest("hex")
    .slice(0, RUN_ID_HASH_LEN);
  // Reserve room for the "-<hash>" suffix so the bounded id still fits.
  const prefixLen = MAX_SAFE_RUN_ID_LEN - RUN_ID_HASH_LEN - 1;
  return `${safe.slice(0, prefixLen)}-${hash}`;
}

/**
 * Derive a unique per-run namespace pair from a run id. The run id is supplied
 * by the caller; the gate constructs it at startup by combining an optional
 * operator LABEL with a per-invocation crypto nonce (see makeRunId), keeping
 * this helper pure and deterministic so unit tests can pin it (no
 * Date.now/random here). Bounding preserves uniqueness: two run ids that share
 * an 80-char prefix still map to distinct namespaces (see boundRunId).
 */
export function runNamespaces(runId: string): {
  primary: string;
  negative: string;
} {
  const sanitized = runId.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (sanitized.length === 0) {
    throw new Error(
      "live eval run id must contain at least one usable character",
    );
  }
  const safe = boundRunId(sanitized);
  return {
    primary: `eval-live-recall-${safe}`,
    negative: `eval-live-recall-${safe}-negative`,
  };
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Build a per-run id that is unique across EVERY invocation, including repeated
 * runs on the same commit and runs that reuse an operator-supplied label.
 *
 * The injected `randomHex` nonce is ALWAYS appended -- it is the only part of
 * the id that guarantees uniqueness, so it is mandatory. The optional
 * `OPEN_BRAIN_LIVE_EVAL_RUN_ID` is an operator LABEL (a human-readable prefix
 * for triage), NOT a reusable namespace id: reusing a label would otherwise let
 * two runs enter the same namespace, where the second seed upserts onto the
 * first run's stranded row. The commit prefix is a fallback label. Precedence
 * for the label is: explicit operator label > commit prefix > none.
 *
 * Shapes: `<label>-<nonce>`, `<prefix>-<nonce>`, or `<nonce>`.
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
  const nonce = opts.randomHex.trim();
  if (nonce.length === 0) {
    // The nonce is the uniqueness guarantee; without it we cannot promise two
    // invocations differ, so refuse rather than emit a reusable id.
    throw new Error(
      "live eval run id needs a crypto random suffix to stay unique across every invocation",
    );
  }
  const explicitLabel = (env.OPEN_BRAIN_LIVE_EVAL_RUN_ID ?? "").trim();
  const label = explicitLabel.length > 0 ? explicitLabel : opts.prefix.trim();
  return label.length > 0 ? `${label}-${nonce}` : nonce;
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
