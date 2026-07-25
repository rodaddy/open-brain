/**
 * Lane/own-durable → shared-kb shared-worthiness classifier (Issue #161).
 *
 * Pure, no DB, no I/O. Decides whether a nominated entry (a thought, decision,
 * or session event explicitly nominated with `share_candidate=true` and
 * `memory_lifecycle_action=nominate_shared`) is safe and worthwhile to promote
 * into the shared-kb namespace — shared TRUTH that every agent reads.
 *
 * The highest-stakes rule is `reject-secret`: a secret reaching shared truth is
 * the worst failure mode, so `containsSecret` is deliberately conservative
 * (false negatives are far more dangerous than false positives here). The secret
 * patterns are ported from the Python client's `policy.py` SECRET_PATTERNS so the
 * server enforces the same redaction surface the client already trusts.
 */

import { logger } from "./observability/index.ts";

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

export const SHARE_REJECTION_MAX_RESUBMIT_ATTEMPTS = 2;

export interface ShareRejectionDetail {
  category: "reject-secret" | "reject-private";
  matched_kind: string;
  span_count: number;
  redaction_hint: string;
  resubmittable: boolean;
  resubmit_attempt: number;
  max_resubmit_attempts: number;
  resubmit_blocked_reason?: "max_attempts" | "invalid_resubmit_root";
}

export interface ShareRejectionDetailOptions {
  resubmit_attempt?: number;
  resubmit_blocked_reason?: "max_attempts" | "invalid_resubmit_root";
}

function globalClone(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function countMatches(pattern: RegExp, text: string): number {
  return Array.from(text.matchAll(globalClone(pattern))).length;
}

function detectSecret(
  text: string,
): { matched_kind: string; span_count: number } | null {
  if (!text) return null;
  let matchedKind: string | null = null;
  let spanCount = 0;
  for (const { kind, pattern } of SECRET_DETECTORS) {
    if (pattern.test(text)) {
      matchedKind ??= kind;
      spanCount += countMatches(pattern, text);
    }
  }
  return matchedKind
    ? { matched_kind: matchedKind, span_count: spanCount }
    : null;
}

/**
 * True if `text` contains anything matching a known secret pattern. Conservative
 * by design: a secret must NEVER reach shared truth, so this is the hard gate
 * `classifyShareCandidate` consults before anything else.
 */
export function containsSecret(text: string): boolean {
  return detectSecret(text) !== null;
}

/**
 * Redact known secret material. Some label-aware and URL patterns intentionally
 * over-redact surrounding context so callers do not keep misleading secret
 * diagnostics. Uses the same SECRET_PATTERNS gate as shared-kb promotion so
 * automated OB importers do not maintain their own weaker redaction fork.
 */
export function redactText(text: string): string {
  if (!text) return text;
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    const flags = pattern.flags.includes("g")
      ? pattern.flags
      : `${pattern.flags}g`;
    redacted = redacted.replace(
      new RegExp(pattern.source, flags),
      "[REDACTED]",
    );
  }
  if (redacted !== text) {
    // A redaction is a silent content mutation: the caller stores something
    // different from what it was handed and nothing in the return value says
    // so. Only the fact and the size delta are recorded — never the matched
    // material, and never the surrounding text.
    logger.warn("sharing_text_redacted", {
      original_length: text.length,
      redacted_length: redacted.length,
    });
  }
  return redacted;
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
  return detectPrivate(input) !== null;
}

function detectPrivate(input: ShareCandidateInput): {
  matched_kind: string;
  span_count: number;
} | null {
  const metadata = input.metadata ?? {};
  if (metadata.private === true) {
    return { matched_kind: "private-flag", span_count: 1 };
  }
  if (metadata.personal === true) {
    return { matched_kind: "personal-flag", span_count: 1 };
  }
  // Conservative namespace-personal markers an agent may stamp on a candidate.
  const visibility = metadata.visibility ?? metadata.scope;
  if (typeof visibility === "string") {
    const v = visibility.toLowerCase();
    if (v === "private") {
      return { matched_kind: "private-visibility", span_count: 1 };
    }
    if (v === "personal") {
      return { matched_kind: "personal-visibility", span_count: 1 };
    }
  }
  const privateTagCount = (input.tags ?? []).filter((tag) =>
    PRIVATE_TAGS.has(tag.trim().toLowerCase()),
  ).length;
  if (privateTagCount > 0) {
    return { matched_kind: "private-tag", span_count: privateTagCount };
  }
  return null;
}

function resubmitAttempt(
  metadata: Record<string, unknown> | undefined,
): number {
  const raw = metadata?.sanitized_resubmit_attempt;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return 0;
  return raw;
}

export function shareRejectionDetail(
  input: ShareCandidateInput,
  options: ShareRejectionDetailOptions = {},
): ShareRejectionDetail | null {
  const attempt =
    typeof options.resubmit_attempt === "number" &&
    Number.isInteger(options.resubmit_attempt) &&
    options.resubmit_attempt >= 0
      ? options.resubmit_attempt
      : resubmitAttempt(input.metadata);
  const secret = detectSecret(input.content);
  if (secret) {
    const resubmittable = attempt < SHARE_REJECTION_MAX_RESUBMIT_ATTEMPTS;
    const blockedReason = resubmittable
      ? undefined
      : (options.resubmit_blocked_reason ?? "max_attempts");
    if (blockedReason) {
      // Limit trigger: the agent is now permanently blocked from re-nominating
      // this candidate. Without a line here the agent just stops getting
      // through and nothing on the server says the cap is why.
      logger.warn("sharing_resubmit_blocked", {
        category: "reject-secret",
        matched_kind: secret.matched_kind,
        resubmit_attempt: attempt,
        max_resubmit_attempts: SHARE_REJECTION_MAX_RESUBMIT_ATTEMPTS,
        blocked_reason: blockedReason,
      });
    }
    return {
      category: "reject-secret",
      matched_kind: secret.matched_kind,
      span_count: secret.span_count,
      redaction_hint:
        blockedReason === "invalid_resubmit_root"
          ? "The resend root was not recognized; use the original rejection metadata before retrying."
          : resubmittable
            ? "Remove the credential and re-nominate the sanitized fact; describe the action, not the secret."
            : "Maximum sanitized resend attempts reached; stop retrying this rejected share nomination.",
      resubmittable,
      resubmit_attempt: attempt,
      max_resubmit_attempts: SHARE_REJECTION_MAX_RESUBMIT_ATTEMPTS,
      ...(blockedReason ? { resubmit_blocked_reason: blockedReason } : {}),
    };
  }
  const privateMatch = detectPrivate(input);
  if (privateMatch) {
    const resubmittable = attempt < SHARE_REJECTION_MAX_RESUBMIT_ATTEMPTS;
    const blockedReason = resubmittable
      ? undefined
      : (options.resubmit_blocked_reason ?? "max_attempts");
    if (blockedReason) {
      // Limit trigger — see the secret branch above.
      logger.warn("sharing_resubmit_blocked", {
        category: "reject-private",
        matched_kind: privateMatch.matched_kind,
        resubmit_attempt: attempt,
        max_resubmit_attempts: SHARE_REJECTION_MAX_RESUBMIT_ATTEMPTS,
        blocked_reason: blockedReason,
      });
    }
    return {
      category: "reject-private",
      matched_kind: privateMatch.matched_kind,
      span_count: privateMatch.span_count,
      redaction_hint:
        blockedReason === "invalid_resubmit_root"
          ? "The resend root was not recognized; use the original rejection metadata before retrying."
          : resubmittable
            ? "Remove personal/private markers or rewrite without private details before re-nominating."
            : "Maximum sanitized resend attempts reached; stop retrying this rejected share nomination.",
      resubmittable,
      resubmit_attempt: attempt,
      max_resubmit_attempts: SHARE_REJECTION_MAX_RESUBMIT_ATTEMPTS,
      ...(blockedReason ? { resubmit_blocked_reason: blockedReason } : {}),
    };
  }
  return null;
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
  const length = input.content.trim().length;

  // Content-free decision context carried on every outcome line below. Only
  // shapes and enum values: the candidate body is NEVER logged here, and the
  // secret/private detectors contribute only their `kind` label (the name of
  // the classifier that fired), never the matched span.
  const base = {
    event_type: input.event_type ?? null,
    importance: input.importance ?? null,
    content_length: length,
    min_share_length: minLen,
    tag_count: input.tags?.length ?? 0,
  };

  // 1. Secret — hard reject, checked before anything else.
  if (containsSecret(input.content)) {
    // Re-derive the detector label purely for the log line; `containsSecret`
    // remains the decision. error, not warn: a credential reaching a shared-kb
    // nomination is the failure mode this whole module exists to prevent. It
    // must be loud even though the gate held, because the leak already happened
    // upstream — the secret is sitting in a lane event.
    const secret = detectSecret(input.content);
    logger.error("sharing_reject_secret", {
      ...base,
      matched_kind: secret?.matched_kind ?? null,
      span_count: secret?.span_count ?? 0,
    });
    return "reject-secret";
  }

  // 2. Private — person-private content must not become shared truth.
  if (isPrivate(input)) {
    // Re-derive the detector label purely for the log line. `isPrivate` is the
    // decision (unchanged); this only names WHICH marker fired, and runs on the
    // reject path only.
    const privateMatch = detectPrivate(input);
    logger.warn("sharing_reject_private", {
      ...base,
      matched_kind: privateMatch?.matched_kind ?? null,
      span_count: privateMatch?.span_count ?? 0,
    });
    return "reject-private";
  }

  // 3. Noise — wrong event type, cold importance, or too short.
  const eventType = input.event_type;
  if (eventType !== undefined && NOISE_EVENT_TYPES.has(eventType)) {
    logger.debug("sharing_reject_noise", {
      ...base,
      noise_reason: "event_type",
    });
    return "reject-noise";
  }
  if (input.importance === "cold") {
    logger.debug("sharing_reject_noise", {
      ...base,
      noise_reason: "cold_importance",
    });
    return "reject-noise";
  }
  if (length < minLen) {
    logger.debug("sharing_reject_noise", {
      ...base,
      noise_reason: "too_short",
    });
    return "reject-noise";
  }

  // 4. Type eligibility. Lane events must be a shareable type; thoughts and
  //    decisions (no event_type) are always type-eligible.
  if (eventType !== undefined && !SHARE_EVENT_TYPES.has(eventType)) {
    logger.debug("sharing_reject_noise", {
      ...base,
      noise_reason: "type_not_shareable",
    });
    return "reject-noise";
  }

  // 5. Ambiguity band: just over the minimum length is share-eligible but not
  //    obviously substantive — route to a human for review.
  if (length < minLen * 1.5) {
    // warn: a partially-completed path. The candidate cleared every gate and
    // was then parked, so it will never reach shared-kb without a human.
    logger.warn("sharing_manual_review", base);
    return "manual-review";
  }

  logger.info("sharing_share_approved", base);
  return "share";
}
