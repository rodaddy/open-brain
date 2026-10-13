/**
 * Sanitization helpers for ob-backfill (issue 864 L6 seam).
 *
 * Split out of scripts/ob-backfill.ts so the entrypoint stays within the
 * repo file-size rule. Behavior is unchanged; the entrypoint re-exports
 * `sanitize` and `buildDecisionLogParams` so no caller or test import moves.
 */

import { containsSecret, redactText } from "../server/domain/sharing.ts";

const TOKEN_FRAGMENT_RE = /[A-Za-z0-9._~+/=:@-]+/g;
const MAX_REFORMED_FRAGMENT_COUNT = 16;
const MAX_REFORMED_LABELED_FRAGMENT_COUNT = 4;
const MAX_REFORMED_SECRET_LENGTH = 512;
const AWS_SECRET_WIDTH = 40;
const BOUNDARYLESS_SCAN_INTERVAL = 128;
const WRAPPED_SECRET_SEPARATOR_RE = /[\s,;"'()[\]<>?!&%#|`*{}^$\\]/;
const BOUNDARYLESS_SECRET_PATTERNS = [
  /authorization[:=]?bearer[A-Za-z0-9._~+/=-]{8,}/i,
  /bearer[A-Za-z0-9._~+/=-]{8,}/i,
  /mcp-session-id[:=]?[A-Za-z0-9._:-]{6,}/i,
  /sk-[A-Za-z0-9_-]{20,}/i,
  /github_pat_[A-Za-z0-9_]{20,}/i,
  /gh[pousr]_[A-Za-z0-9_]{20,}/i,
  /A[KS]IA[A-Z0-9]{16}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/i,
  /AIza[0-9A-Za-z_-]{35}/,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /[sprk]k_(?:live|test)_[A-Za-z0-9]{16,}/i,
];

function startsLikeStandaloneSecret(fragment: string): boolean {
  return /^(authorization|bearer|mcp-session-id|sk-|github_pat_|gh[pousr]_|A[KS]IA|xox[baprs]-|AIza|eyJ|[sprk]k_(live|test)_|https?:\/\/|ftp:\/\/|postgres(?:ql)?:\/\/|mysql:\/\/|mariadb:\/\/|mongodb:\/\/|redis:\/\/|amqps?:\/\/|ssh:\/\/|sftp?:\/\/|smtps?:\/\/|imaps?:\/\/|ldaps?:\/\/)/i.test(
    fragment,
  );
}

function startsLikeUrl(fragment: string): boolean {
  return /^(?:https?|ftp|postgres(?:ql)?|mysql|mariadb|mongodb|redis|amqps?|ssh|sftp|smtps?|imaps?|ldaps?):\/\//i.test(
    fragment,
  );
}

function isPlainWordFragment(fragment: string): boolean {
  return /^[A-Za-z]+$/.test(fragment);
}

function startsLikeLabeledSecret(fragment: string): boolean {
  return /^(mcp-session-id|api[_-]?key|token|password|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key)\s*[:=]/i.test(
    fragment,
  );
}

function hasPlausibleLabeledSecretValue(fragment: string): boolean {
  const match =
    /^(?:mcp-session-id|api[_-]?key|token|password|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key)\s*[:=]\s*(.+)$/i.exec(
      fragment,
    );
  const value = match?.[1] ?? "";
  const characterClassCount = [/[a-z]/, /[A-Z]/, /[0-9]/, /[_~+/=.-]/].filter(
    (pattern) => pattern.test(value),
  ).length;
  return (
    (value.length >= 12 && characterClassCount >= 2) ||
    (value.length >= 6 && /[A-Za-z]/.test(value) && /[0-9]/.test(value))
  );
}

function containsBoundarylessSecretAcrossSeparator(
  text: string,
  separatorBefore: boolean[],
): boolean {
  return BOUNDARYLESS_SECRET_PATTERNS.some((pattern) => {
    const match = pattern.exec(text);
    if (!match?.[0]) return false;
    const start = match.index;
    const end = start + match[0].length;
    return separatorBefore.slice(start, end).some(Boolean);
  });
}

function hasAwsSecretWindow(compacted: string): boolean {
  for (let start = 0; start <= compacted.length - AWS_SECRET_WIDTH; start += 1) {
    const window = compacted.slice(start, start + AWS_SECRET_WIDTH);
    if (
      /[A-Z]/.test(window) &&
      /[a-z]/.test(window) &&
      /[0-9]/.test(window) &&
      /[/+=]/.test(window)
    ) {
      return true;
    }
  }
  return false;
}

function containsWrappedBoundarylessSecret(text: string): boolean {
  let compacted = "";
  let separatorBefore: boolean[] = [];
  let pendingSeparator = false;
  let sawSeparator = false;

  const maybeMatch = (): boolean =>
    sawSeparator &&
    containsBoundarylessSecretAcrossSeparator(compacted, separatorBefore);

  const append = (char: string): boolean => {
    compacted += char;
    separatorBefore.push(pendingSeparator);
    pendingSeparator = false;
    if (compacted.length > MAX_REFORMED_SECRET_LENGTH) {
      compacted = compacted.slice(-MAX_REFORMED_SECRET_LENGTH);
      separatorBefore = separatorBefore.slice(-MAX_REFORMED_SECRET_LENGTH);
    }
    return compacted.length % BOUNDARYLESS_SCAN_INTERVAL === 0 && maybeMatch();
  };

  const flush = (): boolean => {
    const matched = maybeMatch();
    compacted = "";
    separatorBefore = [];
    pendingSeparator = false;
    sawSeparator = false;
    return matched;
  };

  for (const char of text) {
    if (/[A-Za-z0-9._~+/=:@-]/.test(char)) {
      if (append(char)) return true;
      continue;
    }
    if (WRAPPED_SECRET_SEPARATOR_RE.test(char) && compacted) {
      sawSeparator = true;
      pendingSeparator = true;
      continue;
    }
    if (compacted && flush()) return true;
  }

  return compacted ? flush() : false;
}

function containsWrappedAwsSecret(text: string): boolean {
  let run = "";
  let sawSeparator = false;

  const flush = (): boolean => {
    const compacted = run.replace(new RegExp(WRAPPED_SECRET_SEPARATOR_RE, "g"), "");
    const matched =
      sawSeparator &&
      compacted.length >= AWS_SECRET_WIDTH &&
      hasAwsSecretWindow(compacted);
    run = "";
    sawSeparator = false;
    return matched;
  };

  for (const char of text) {
    if (/[A-Za-z0-9/+=]/.test(char)) {
      run += char;
      continue;
    }
    if (WRAPPED_SECRET_SEPARATOR_RE.test(char) && run) {
      run += char;
      sawSeparator = true;
      continue;
    }
    if (run && flush()) return true;
  }

  return run ? flush() : false;
}

/** True when a fragment reads as a secret on its own or once space-padded. */
function readsAsSecret(fragment: string): boolean {
  return containsSecret(fragment) || containsSecret(` ${fragment} `);
}

/** A URL join stops at the next plain word or the start of another URL. */
function breaksUrlJoin(fragment: string): boolean {
  return isPlainWordFragment(fragment) || startsLikeUrl(fragment);
}

/**
 * Walks forward from one fragment, re-joining neighbours, and reports whether
 * any join reads as a secret. Hoisted out of containsWhitespaceReformedSecret
 * so that function stays within the repo complexity rule; the join order, the
 * URL break, and the labelled-value test are unchanged.
 */
function joinsIntoSecret(
  fragments: string[],
  start: number,
  maxEnd: number,
  flags: { startsLabeled: boolean; startsUrl: boolean },
): boolean {
  const { startsLabeled, startsUrl } = flags;
  let joined = fragments[start] ?? "";
  for (let end = start + 1; end < maxEnd; end += 1) {
    const next = fragments[end] ?? "";
    if (startsUrl && breaksUrlJoin(next)) break;
    joined += next;
    if (joined.length > MAX_REFORMED_SECRET_LENGTH) break;
    if (!readsAsSecret(joined)) continue;
    if (!startsLabeled || hasPlausibleLabeledSecretValue(joined)) return true;
  }
  return false;
}

function containsWhitespaceReformedSecret(text: string): boolean {
  const fragments = Array.from(text.matchAll(TOKEN_FRAGMENT_RE), (match) => match[0]);
  for (let start = 0; start < fragments.length; start += 1) {
    const first = fragments[start] ?? "";
    const startsLabeled = startsLikeLabeledSecret(first);
    const startsUrl = startsLikeUrl(first);
    if (!startsLikeStandaloneSecret(first) && !startsLabeled) continue;
    if (!startsLabeled && readsAsSecret(first)) continue;

    const maxEnd = Math.min(
      fragments.length,
      start +
        (startsLabeled
          ? MAX_REFORMED_LABELED_FRAGMENT_COUNT
          : MAX_REFORMED_FRAGMENT_COUNT),
    );
    if (joinsIntoSecret(fragments, start, maxEnd, { startsLabeled, startsUrl })) {
      return true;
    }
  }
  return containsWrappedAwsSecret(text) || containsWrappedBoundarylessSecret(text);
}

// Control characters are stripped before matching so a secret cannot be
// hidden inside them. Built from escapes rather than a literal class so the
// regex carries no control characters of its own.
const CONTROL_CHAR_RANGES: Array<[number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
];

const CONTROL_CHARS_RE = new RegExp(
  `[${CONTROL_CHAR_RANGES.map(
    ([lo, hi]) => `${String.fromCharCode(lo)}-${String.fromCharCode(hi)}`,
  ).join("")}]`,
  "g",
);

export function sanitize(text: string): string {
  const normalized = text.replace(CONTROL_CHARS_RE, "").replace(/\n/g, " ");
  // Reformed or wrapped candidates fall back to whole-field redaction. Once a
  // secret has been split across tokens, surgical replacement can leave tails.
  if (containsWhitespaceReformedSecret(normalized)) return "[REDACTED]";

  const redacted = redactText(normalized).trim();
  const spaceCompacted = redacted.replace(/\s+/g, " ");
  if (
    containsSecret(redacted) ||
    containsSecret(spaceCompacted) ||
    containsWhitespaceReformedSecret(redacted) ||
    containsWrappedBoundarylessSecret(redacted)
  ) {
    return "[REDACTED]";
  }
  return redacted;
}

function sanitizeDecisionBeforeSplit(decision: string): string {
  const withoutStructuralBecause = decision.replace(/\s+because\s+/gi, " ");
  if (
    withoutStructuralBecause !== decision &&
    sanitize(withoutStructuralBecause) === "[REDACTED]"
  ) {
    return "[REDACTED]";
  }
  return sanitize(decision);
}

export function sanitizeStructuralField(text: string): string {
  return sanitize(text).slice(0, 200);
}

export function buildDecisionLogParams(
  decision: string,
  project: string,
): {
  title: string;
  rationale: string;
  tags: string[];
} {
  const cleanDecision = sanitizeDecisionBeforeSplit(decision);
  const [title = "", ...rationaleParts] = cleanDecision.split(" because ");
  return {
    title: title.slice(0, 200),
    rationale: rationaleParts.join(" because ").slice(0, 200),
    tags: ["backfill", sanitizeStructuralField(project)],
  };
}
