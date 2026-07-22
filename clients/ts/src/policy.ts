/**
 * Redaction and idempotency policy, mirroring
 * `python/openbrain-memory/src/openbrain_memory/policy.py`.
 *
 * The pattern set is the redact-before-persist security boundary: every
 * payload passes `redactValue` before it reaches any spool or sidecar file.
 */

// Prefixes are assembled from fragments so credential scanners never see a
// literal token prefix in source (mirrors the Python module).
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
const STRIPE_KEY_RE = "[sprk]k_(live|test)_[A-Za-z0-9]{16,}";
// Credentials embedded in a URL's userinfo. Fixed scheme alternation keeps
// the pattern linear-time (mirrors the Python ReDoS guard).
const URL_SCHEME_ALT =
  "(?:https?|ftp|postgres|postgresql|mysql|mariadb|mongodb|redis|amqp|amqps|" +
  "ssh|sftp|smtp|smtps|imap|imaps|ldap|ldaps)";
const URL_USERINFO_CRED_RE = `${URL_SCHEME_ALT}://[^\\s:@/]{1,256}:[^\\s@/]{1,256}@[^\\s/]+`;
const LABELED_LONG_SECRET_RE =
  "(client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key)" +
  "\\s*[:=]\\s*[A-Za-z0-9._/+=-]{20,}";
const BARE_THREE_SEGMENT_TOKEN_RE =
  "(?<![A-Za-z0-9_-])" +
  "(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])" +
  "(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}\\." +
  "(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])" +
  "(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{6,}\\." +
  "(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])" +
  "(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}" +
  "(?![A-Za-z0-9_-])";
const UNLABELED_HIGH_ENTROPY_BLOB_RE =
  "(?<![A-Za-z0-9+=/])" +
  "(?=[A-Za-z0-9+=/]{40,}(?![A-Za-z0-9+=/]))" +
  "(?=[A-Za-z0-9+=/]*[A-Z])" +
  "(?=[A-Za-z0-9+=/]*[a-z])" +
  "(?=[A-Za-z0-9+=/]*[0-9])" +
  "(?=[A-Za-z0-9+=/]*[+=])" +
  "[A-Za-z0-9+=/]+";

/** Fail-closed write rejection consumes exactly this set (never heuristics). */
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

/** Display-only heuristic redaction; too broad for fail-closed rejection. */
export const HEURISTIC_REDACTION_PATTERNS: readonly RegExp[] = [
  new RegExp(BARE_THREE_SEGMENT_TOKEN_RE),
  new RegExp(UNLABELED_HIGH_ENTROPY_BLOB_RE),
];

export const SENSITIVE_KEY_RE =
  /(token|secret|password|api[_-]?key|credential|authorization|session[_-]?id)/i;
export const MAX_REDACT_DEPTH = 32;

function globalized(pattern: RegExp): RegExp {
  return new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g",
  );
}

const GLOBAL_SECRET_PATTERNS = SECRET_PATTERNS.map(globalized);
const GLOBAL_HEURISTIC_PATTERNS = HEURISTIC_REDACTION_PATTERNS.map(globalized);

export function idempotencyKey(): string {
  return `obmem-${crypto.randomUUID().replaceAll("-", "")}`;
}

export function redactText(text: string): string {
  let redacted = text;
  for (const pattern of GLOBAL_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  // Heuristic display redaction deliberately starts at 40 characters to avoid
  // shredding short benign identifiers (mirrors the Python threshold).
  if (redacted.length < 40) {
    return redacted;
  }
  for (const pattern of GLOBAL_HEURISTIC_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactValueAtDepth(value: unknown, depth: number): unknown {
  if (depth >= MAX_REDACT_DEPTH) {
    return "[REDACTED:depth]";
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValueAtDepth(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[key] = SENSITIVE_KEY_RE.test(key)
        ? "[REDACTED]"
        : redactValueAtDepth(item, depth + 1);
    }
    return redacted;
  }
  return value;
}

/** Redact secret-shaped strings and sensitive keys before any persistence. */
export function redactValue(value: unknown): unknown {
  return redactValueAtDepth(value, 0);
}

/** Raised for caller-input validation failures (Python `ValueError` peer). */
export class ValidationError extends Error {}

/**
 * Fail closed on secret-like write payloads (Python `_reject_secret_payload`).
 * Consumes only SECRET_PATTERNS; heuristics are display-only.
 */
export function rejectSecretPayload(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new ValidationError(`${path} contains secret-like material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      rejectSecretPayload(item, `${path}[${index}]`);
    });
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        throw new ValidationError(
          `${path}.${key} contains secret-like material`,
        );
      }
      rejectSecretPayload(item, `${path}.${key}`);
    }
  }
}
