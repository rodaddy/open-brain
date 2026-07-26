/**
 * Secret detector patterns — a LEAF module with no imports.
 *
 * Extracted from `sharing.ts` so `logger.ts` can redact every string it emits
 * without importing `sharing.ts`. That import is not merely stylistically bad,
 * it crashes: `logger.ts` -> `sharing.ts` -> `observability/index.ts` ->
 * `context.ts` calls `setLogContextReader` back into a half-initialized
 * `logger.ts`, giving `ReferenceError: Cannot access 'contextReader' before
 * initialization` whenever the logger is loaded first — which is the common
 * order, since it is the base dependency.
 *
 * Keep this module import-free. Everything here is a compiled constant, so it
 * can sit at the bottom of the graph and be safely read from anywhere.
 */

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
  "eyJ[A-Za-z0-9_-]{8,}\\." + "[A-Za-z0-9_-]{8,}\\." + "[A-Za-z0-9_-]{8,}";
const PRIVATE_KEY_BLOCK_RE =
  "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----";
// Stripe-style keys use an underscore separator (sk_live_, pk_live_, rk_live_,
// and the test variants), which the OpenAI `sk-` pattern above does not catch.
const STRIPE_KEY_RE = "[sprk]k_(live|test)_[A-Za-z0-9]{16,}";
// Credentials embedded in a URL's userinfo (`scheme://user:pass@host`). The
// password is unlabeled and a realistic lane-journal leak. ReDoS guard: match a
// FIXED scheme alternation (not `[a-z][a-z0-9+.-]*`) so the engine cannot
// restart-and-rescan a `*` wildcard at every input position — that unanchored
// prefix, not the userinfo, was the O(n²) source. Userinfo segments stay
// length-bounded ({1,256}); real credentials are far shorter.
// `nats`/`tls` are Open Brain's OWN transport schemes and were the gap that
// mattered: a review caught `nats://user:pass@host` reaching the log through a
// thrown error's name, since every other service OB talks to was listed but the
// one it *is* was not.
const URL_SCHEME_ALT =
  "(?:https?|ftp|postgres|postgresql|mysql|mariadb|mongodb|redis|amqp|amqps|" +
  "nats|tls|ws|wss|ssh|sftp|smtp|smtps|imap|imaps|ldap|ldaps)";
const URL_USERINFO_CRED_RE = `${URL_SCHEME_ALT}://[^\\s:@/]{1,256}:[^\\s@/]{1,256}@[^\\s/]+`;
// Context-labeled long hex/base64 secrets (client_secret, access_token, etc.).
// Deliberately requires a credential LABEL — bare high-entropy hex is left
// alone because git SHAs and content_hashes are pervasive and legitimate here
// (avoiding the over-rejection the SME guidance warns against).
const LABELED_LONG_SECRET_RE =
  "(client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key)" +
  "\\s*[:=]\\s*[A-Za-z0-9._/+=-]{20,}";

export interface SecretPatternDetector {
  kind: string;
  pattern: RegExp;
}

/**
 * Compiled secret detectors. `i` mirrors the Python `(?i)` inline flags; the
 * private-key block uses dot-all via the explicit `[\s\S]` class so no `s` flag
 * is required (keeps Bun/JS regex engine parity with the Python `re.S`).
 *
 * The `kind` labels are safe to return in structured rejection details. They
 * identify the classifier, never the matched secret value.
 */
export const SECRET_DETECTORS: readonly SecretPatternDetector[] = [
  {
    kind: "authorization_bearer_header",
    pattern: /authorization\s*[:=]\s*bearer\s+[^\s,;]+/i,
  },
  { kind: "bearer_token", pattern: /bearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  {
    kind: "mcp_session_id",
    pattern: /mcp-session-id\s*[:=]\s*[A-Za-z0-9._:-]+/i,
  },
  {
    kind: "openai_api_key",
    pattern: new RegExp(`\\b${SK_PREFIX}[A-Za-z0-9_-]{10,}\\b`),
  },
  {
    kind: "github_pat",
    pattern: new RegExp(`${GITHUB_PAT_PREFIX}[A-Za-z0-9_]+`, "i"),
  },
  {
    kind: "github_token",
    pattern: new RegExp(`${GITHUB_PREFIX_RE}[A-Za-z0-9_]{20,}`, "i"),
  },
  {
    kind: "aws_access_key_id",
    pattern: new RegExp(`\\b${AWS_ACCESS_KEY_PREFIX_RE}\\b`),
  },
  {
    kind: "aws_secret_access_key",
    pattern: new RegExp(AWS_SECRET_CONTEXT_RE, "i"),
  },
  { kind: "aws_secret_like", pattern: new RegExp(AWS_SECRET_LIKE_RE) },
  { kind: "slack_token", pattern: new RegExp(`\\b${SLACK_TOKEN_RE}\\b`) },
  {
    kind: "google_api_key",
    pattern: new RegExp(`\\b${GOOGLE_API_KEY_PREFIX}[A-Za-z0-9_-]{35}\\b`),
  },
  { kind: "jwt", pattern: new RegExp(`\\b${JWT_LIKE_RE}\\b`) },
  {
    kind: "labeled_secret",
    pattern: /(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/i,
  },
  {
    kind: "json_labeled_secret",
    pattern: /"(api[_-]?key|token|password|secret)"\s*:\s*"[^"]+"/i,
  },
  { kind: "private_key_block", pattern: new RegExp(PRIVATE_KEY_BLOCK_RE) },
  { kind: "stripe_key", pattern: new RegExp(`\\b${STRIPE_KEY_RE}\\b`) },
  {
    kind: "url_userinfo_credential",
    pattern: new RegExp(URL_USERINFO_CRED_RE, "i"),
  },
  {
    kind: "labeled_long_secret",
    pattern: new RegExp(LABELED_LONG_SECRET_RE, "i"),
  },
];

export const SECRET_PATTERNS: readonly RegExp[] = SECRET_DETECTORS.map(
  ({ pattern }) => pattern,
);
