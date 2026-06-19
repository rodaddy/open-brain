/**
 * Lane/own-durable → shared-kb shared-worthiness classifier (Issue #161).
 *
 * Pure, no DB, no I/O. Decides whether a nominated entry (a thought, decision,
 * or session event flagged `share_candidate`) is safe and worthwhile to promote
 * into the shared-kb namespace — shared TRUTH that every agent reads.
 *
 * The highest-stakes rule is `reject-secret`: a secret reaching shared truth is
 * the worst failure mode, so `containsSecret` is deliberately conservative
 * (false negatives are far more dangerous than false positives here). The secret
 * patterns are ported from the Python client's `policy.py` SECRET_PATTERNS so the
 * server enforces the same redaction surface the client already trusts.
 */

/** Default minimum trimmed content length for a share-eligible entry. */
export const DEFAULT_MIN_SHARE_LENGTH = 24;

/**
 * Ported from python/openbrain-memory/src/openbrain_memory/policy.py
 * SECRET_PATTERNS. Kept structurally 1:1 so the two surfaces stay in lockstep.
 * Prefixes are split to avoid tripping repo secret scanners on the literals.
 */
const SK_PREFIX = "sk" + "-";
const GITHUB_PREFIX_RE = "gh" + "[pousr]_";
const GITHUB_PAT_PREFIX = "github" + "_pat_";
const AWS_ACCESS_KEY_PREFIX_RE = "A[KS]IA[0-9A-Z]{16}";
const AWS_SECRET_LIKE_RE =
  "(?<![A-Za-z0-9/+=])" +
  "(?=[A-Za-z0-9/+=]*[A-Z])" +
  "(?=[A-Za-z0-9/+=]*[a-z])" +
  "(?=[A-Za-z0-9/+=]*[0-9])" +
  "(?=[A-Za-z0-9/+=]*[/+=])" +
  "[A-Za-z0-9/+=]{40}" +
  "(?![A-Za-z0-9/+=])";
const AWS_SECRET_CONTEXT_RE =
  "(aws[_ -]?(secret|secret[_ -]?access[_ -]?key))\\s*[:=]\\s*" +
  "[A-Za-z0-9/+=]{40}";
const SLACK_TOKEN_RE = "xox[baprs]-[A-Za-z0-9-]{10,}";
const GOOGLE_API_KEY_PREFIX = "AIza";
const JWT_LIKE_RE =
  "eyJ[A-Za-z0-9_-]{8,}\\." +
  "[A-Za-z0-9_-]{8,}\\." +
  "[A-Za-z0-9_-]{8,}";
const PRIVATE_KEY_BLOCK_RE =
  "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----";
// Stripe-style keys use an underscore separator (sk_live_, pk_live_, rk_live_,
// and the test variants), which the OpenAI `sk-` pattern above does not catch.
const STRIPE_KEY_RE = "[sprk]k_(live|test)_[A-Za-z0-9]{16,}";
// Credentials embedded in a URL's userinfo (`scheme://user:pass@host`). The
// password is unlabeled and a realistic lane-journal leak. Require a non-empty
// password and a host to avoid matching `a://b:@` noise.
const URL_USERINFO_CRED_RE =
  "[a-z][a-z0-9+.-]*://[^\\s:@/]+:[^\\s@/]+@[^\\s/]+";
// Context-labeled long hex/base64 secrets (client_secret, access_token, etc.).
// Deliberately requires a credential LABEL — bare high-entropy hex is left
// alone because git SHAs and content_hashes are pervasive and legitimate here
// (avoiding the over-rejection the SME guidance warns against).
const LABELED_LONG_SECRET_RE =
  "(client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key)" +
  "\\s*[:=]\\s*[A-Za-z0-9._/+=-]{20,}";

/**
 * Compiled secret detectors. `i` mirrors the Python `(?i)` inline flags; the
 * private-key block uses dot-all via the explicit `[\s\S]` class so no `s` flag
 * is required (keeps Bun/JS regex engine parity with the Python `re.S`).
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /authorization\s*[:=]\s*bearer\s+[^\s,;]+/i,
  /bearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /mcp-session-id\s*[:=]\s*[A-Za-z0-9._:-]+/i,
  new RegExp(`\\b${SK_PREFIX}[A-Za-z0-9_-]{10,}\\b`),
  new RegExp(`${GITHUB_PAT_PREFIX}[A-Za-z0-9_]+`, "i"),
  new RegExp(`${GITHUB_PREFIX_RE}[A-Za-z0-9_]{20,}`, "i"),
  new RegExp(`\\b${AWS_ACCESS_KEY_PREFIX_RE}\\b`),
  new RegExp(AWS_SECRET_CONTEXT_RE, "i"),
  new RegExp(AWS_SECRET_LIKE_RE),
  new RegExp(`\\b${SLACK_TOKEN_RE}\\b`),
  new RegExp(`\\b${GOOGLE_API_KEY_PREFIX}[A-Za-z0-9_-]{35}\\b`),
  new RegExp(`\\b${JWT_LIKE_RE}\\b`),
  /(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/i,
  /"(api[_-]?key|token|password|secret)"\s*:\s*"[^"]+"/i,
  new RegExp(PRIVATE_KEY_BLOCK_RE),
  new RegExp(`\\b${STRIPE_KEY_RE}\\b`),
  new RegExp(URL_USERINFO_CRED_RE, "i"),
  new RegExp(LABELED_LONG_SECRET_RE, "i"),
];

/**
 * True if `text` contains anything matching a known secret pattern. Conservative
 * by design: a secret must NEVER reach shared truth, so this is the hard gate
 * `classifyShareCandidate` consults before anything else.
 */
export function containsSecret(text: string): boolean {
  if (!text) return false;
  for (const pattern of SECRET_PATTERNS) {
    // Patterns are stateless here (no global flag) so test() is safe to reuse.
    if (pattern.test(text)) return true;
  }
  return false;
}

export type ShareDecision =
  | "share"
  | "reject-secret"
  | "reject-private"
  | "reject-noise"
  | "manual-review";

/** Minimal shape the classifier needs from a share candidate. */
export interface ShareCandidateInput {
  /** Event type when the candidate is a lane event; omitted for thoughts/decisions. */
  event_type?: string;
  importance?: string;
  content: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface ClassifyShareOptions {
  /** Minimum trimmed content length to be share-eligible. */
  minLen?: number;
}

/** Event types that carry shareable substance. */
const SHARE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "fact",
  "decision",
  "handoff",
]);

/** Event types that are operational noise — never shared truth. */
const NOISE_EVENT_TYPES: ReadonlySet<string> = new Set(["question", "action"]);

/** Tags that mark content as person-private and unfit for shared truth. */
const PRIVATE_TAGS: ReadonlySet<string> = new Set([
  "private",
  "personal",
  "secret",
  "confidential",
]);

function isPrivate(input: ShareCandidateInput): boolean {
  const metadata = input.metadata ?? {};
  if (metadata.private === true || metadata.personal === true) return true;
  // Conservative namespace-personal markers an agent may stamp on a candidate.
  const visibility = metadata.visibility ?? metadata.scope;
  if (typeof visibility === "string") {
    const v = visibility.toLowerCase();
    if (v === "private" || v === "personal") return true;
  }
  for (const tag of input.tags ?? []) {
    if (PRIVATE_TAGS.has(tag.trim().toLowerCase())) return true;
  }
  return false;
}

/**
 * Decide how a single share candidate should be handled. Precedence is
 * deliberate and security-first:
 *
 *   1. reject-secret  — content matches any secret pattern (HARD, first).
 *   2. reject-private — person-private markers (metadata/tags).
 *   3. reject-noise   — noise event types, cold importance, or too short.
 *   4. share          — substantive, eligible, and clears every gate.
 *   5. manual-review  — share-eligible but near the minimum length (ambiguous).
 *
 * Eligibility: lane events qualify only for {fact, decision, handoff}; entries
 * with no `event_type` (thoughts/decisions) are always type-eligible. Cold
 * importance always demotes to noise — the agent has down-tiered it.
 */
export function classifyShareCandidate(
  input: ShareCandidateInput,
  options: ClassifyShareOptions = {},
): ShareDecision {
  const minLen = options.minLen ?? DEFAULT_MIN_SHARE_LENGTH;

  // 1. Secret — hard reject, checked before anything else.
  if (containsSecret(input.content)) {
    return "reject-secret";
  }

  // 2. Private — person-private content must not become shared truth.
  if (isPrivate(input)) {
    return "reject-private";
  }

  // 3. Noise — wrong event type, cold importance, or too short.
  const eventType = input.event_type;
  if (eventType !== undefined && NOISE_EVENT_TYPES.has(eventType)) {
    return "reject-noise";
  }
  if (input.importance === "cold") {
    return "reject-noise";
  }
  const length = input.content.trim().length;
  if (length < minLen) {
    return "reject-noise";
  }

  // 4. Type eligibility. Lane events must be a shareable type; thoughts and
  //    decisions (no event_type) are always type-eligible.
  if (eventType !== undefined && !SHARE_EVENT_TYPES.has(eventType)) {
    return "reject-noise";
  }

  // 5. Ambiguity band: just over the minimum length is share-eligible but not
  //    obviously substantive — route to a human for review.
  if (length < minLen * 1.5) {
    return "manual-review";
  }

  return "share";
}
