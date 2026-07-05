from __future__ import annotations

import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, TypeVar
from uuid import uuid4

SK_PREFIX = "sk" + "-"
GITHUB_PREFIX_RE = "gh" + r"[pousr]_"
GITHUB_PAT_PREFIX = "github" + r"_pat_"
AWS_ACCESS_KEY_PREFIX_RE = r"A[KS]IA[0-9A-Z]{16}"
AWS_SECRET_LIKE_RE = (
    r"(?<![A-Za-z0-9/+=])"
    r"(?=[A-Za-z0-9/+=]*[A-Z])"
    r"(?=[A-Za-z0-9/+=]*[a-z])"
    r"(?=[A-Za-z0-9/+=]*[0-9])"
    r"(?=[A-Za-z0-9/+=]*[/+=])"
    r"[A-Za-z0-9/+=]{40}"
    r"(?![A-Za-z0-9/+=])"
)
AWS_SECRET_CONTEXT_RE = (
    r"(?i)(aws[_ -]?(secret|secret[_ -]?access[_ -]?key))\s*[:=]\s*"
    r"[A-Za-z0-9/+=]{40}"
)
SLACK_TOKEN_RE = r"xox[baprs]-[A-Za-z0-9-]{10,}"
GOOGLE_API_KEY_PREFIX = "AIza"
JWT_LIKE_RE = (
    r"eyJ[A-Za-z0-9_-]{8,}\."
    r"[A-Za-z0-9_-]{8,}\."
    r"[A-Za-z0-9_-]{8,}"
)
PRIVATE_KEY_BLOCK_RE = (
    "-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----"
)
# Stripe-style keys use an underscore separator (sk_live_, pk_live_, rk_live_,
# and the test variants), which the OpenAI `sk-` pattern does not catch.
STRIPE_KEY_RE = r"[sprk]k_(live|test)_[A-Za-z0-9]{16,}"
# Credentials embedded in a URL's userinfo (scheme://user:pass@host). ReDoS
# guard: a FIXED scheme alternation (not [a-z][a-z0-9+.-]*) so the engine cannot
# restart-and-rescan a `*` wildcard at every input position — that unanchored
# prefix was the O(n^2) source, not the userinfo. Userinfo bounded {1,256}.
# (?i) so uppercase schemes match too, keeping this 1:1 with the TS pattern.
URL_SCHEME_ALT = (
    r"(?:https?|ftp|postgres|postgresql|mysql|mariadb|mongodb|redis|amqp|amqps|"
    r"ssh|sftp|smtp|smtps|imap|imaps|ldap|ldaps)"
)
URL_USERINFO_CRED_RE = (
    rf"(?i){URL_SCHEME_ALT}://[^\s:@/]{{1,256}}:[^\s@/]{{1,256}}@[^\s/]+"
)
# Context-labeled long hex/base64 secrets; requires a credential LABEL so bare
# git SHAs / content hashes are not over-rejected.
LABELED_LONG_SECRET_RE = (
    r"(?i)(client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key)"
    r"\s*[:=]\s*[A-Za-z0-9._/+=-]{20,}"
)
# Superset-parity detectors ported from the rtech-hermes fork (#92) so this
# package is a true SUPERSET of that fork's redaction and the fork can retire.
# These catch UNLABELED high-entropy material that the labeled detectors above
# miss (opaque bearer-less tokens, raw base64 secret bodies, session ids pasted
# without a `key=` prefix).
#
# Bare 3-segment dotted token `x.y.z` -- the non-`eyJ` sibling of JWT_LIKE_RE.
# JWTs are already caught by JWT_LIKE_RE; this covers opaque `token.a.sig`
# shapes with no `eyJ` header.
BARE_THREE_SEGMENT_TOKEN_RE = (
    r"\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b"
)
# Unlabeled 40+ char high-entropy blob that CONTAINS at least one of `- _ + / =`.
# ANTI-SHA GUARD: the `(?=.*[+/=_-])` lookahead is load-bearing -- it requires a
# symbol so a benign 40-hex git SHA / content hash (which is pure `[0-9a-f]`,
# no symbol) is NOT redacted. This is exactly why the package originally
# narrowed to LABELED_LONG_SECRET_RE; the symbol requirement restores the fork's
# catch-all coverage without reintroducing SHA over-redaction. The negative
# lookbehind/lookahead pin the run to a full token boundary.
UNLABELED_HIGH_ENTROPY_BLOB_RE = (
    r"(?<![A-Za-z0-9+/=_-])"
    r"(?=[A-Za-z0-9+/=_-]{40,}(?![A-Za-z0-9+/=_-]))"
    r"(?=.*[+/=_-])"
    r"[A-Za-z0-9+/=_-]+"
)

SECRET_PATTERNS = [
    re.compile(r"(?i)authorization\s*[:=]\s*bearer\s+[^\s,;]+"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"(?i)mcp-session-id\s*[:=]\s*[A-Za-z0-9._:-]+"),
    re.compile(rf"\b{SK_PREFIX}[A-Za-z0-9_-]{{10,}}\b"),
    re.compile(rf"(?i){GITHUB_PAT_PREFIX}[A-Za-z0-9_]+"),
    re.compile(rf"(?i){GITHUB_PREFIX_RE}[A-Za-z0-9_]{{20,}}"),
    re.compile(rf"\b{AWS_ACCESS_KEY_PREFIX_RE}\b"),
    re.compile(AWS_SECRET_CONTEXT_RE),
    re.compile(AWS_SECRET_LIKE_RE),
    re.compile(rf"\b{SLACK_TOKEN_RE}\b"),
    re.compile(rf"\b{GOOGLE_API_KEY_PREFIX}[A-Za-z0-9_-]{{35}}\b"),
    re.compile(rf"\b{JWT_LIKE_RE}\b"),
    re.compile(r"(?i)(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+"),
    re.compile(r'(?i)"(api[_-]?key|token|password|secret)"\s*:\s*"[^"]+"'),
    re.compile(PRIVATE_KEY_BLOCK_RE, re.S),
    re.compile(rf"\b{STRIPE_KEY_RE}\b"),
    re.compile(URL_USERINFO_CRED_RE),
    re.compile(LABELED_LONG_SECRET_RE),
]
# Heuristic catch-all detectors ported from the rtech-hermes fork (#92) to make
# redaction a true SUPERSET of that fork. They are DELIBERATELY kept OUT of
# ``SECRET_PATTERNS`` above because ``SECRET_PATTERNS`` also drives the
# fail-closed receipt reject gate (``agent._reject_secret_payload``). These two
# patterns are aggressive by design (any 40+ high-entropy run with a symbol; any
# bare dotted 3-segment token) and WILL match benign material such as a 40+ char
# slash/dash/underscore file path (e.g. ``python/openbrain-memory/tests/...``).
# That aggressiveness is correct for cosmetic redaction of displayed recall
# text (redact-if-in-doubt) but wrong for a fail-closed availability gate, where
# it would reject legitimate receipts. So ``redact_text`` applies BOTH lists;
# the reject gate keeps using only the high-confidence ``SECRET_PATTERNS``. The
# fork itself only ever used these for redaction, so this preserves fork parity
# where it matters (redaction) without importing false rejections.
HEURISTIC_REDACTION_PATTERNS = [
    re.compile(BARE_THREE_SEGMENT_TOKEN_RE),
    re.compile(UNLABELED_HIGH_ENTROPY_BLOB_RE),
]
# All patterns applied by ``redact_text`` (high-confidence + heuristic catch-all).
REDACTION_PATTERNS = SECRET_PATTERNS + HEURISTIC_REDACTION_PATTERNS
SENSITIVE_KEY_RE = re.compile(
    r"(?i)(token|secret|password|api[_-]?key|credential|authorization|session[_-]?id)"
)
MAX_REDACT_DEPTH = 32
T = TypeVar("T")


class RetryExhaustedError(RuntimeError):
    pass


@dataclass(frozen=True)
class RetryPolicy:
    attempts: int = 2
    backoff_seconds: float = 0.05
    max_backoff_seconds: float = 2.0
    honor_retry_after: bool = True

    def __post_init__(self) -> None:
        if self.attempts < 1:
            raise ValueError("RetryPolicy.attempts must be >= 1")
        if self.backoff_seconds < 0:
            raise ValueError("RetryPolicy.backoff_seconds must be >= 0")
        if self.max_backoff_seconds < 0:
            raise ValueError("RetryPolicy.max_backoff_seconds must be >= 0")


def idempotency_key() -> str:
    return f"obmem-{uuid4().hex}"


def redact_text(text: str) -> str:
    redacted = text
    for pattern in REDACTION_PATTERNS:
        redacted = pattern.sub("[REDACTED]", redacted)
    return redacted


def redact_value(value: Any) -> Any:
    return _redact_value(value, depth=0)


def _redact_value(value: Any, *, depth: int) -> Any:
    if depth >= MAX_REDACT_DEPTH:
        return "[REDACTED:depth]"
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            redacted[key_text] = (
                "[REDACTED]"
                if SENSITIVE_KEY_RE.search(key_text)
                else _redact_value(item, depth=depth + 1)
            )
        return redacted
    if isinstance(value, list):
        return [_redact_value(item, depth=depth + 1) for item in value]
    return value


def with_retry(
    operation: Callable[[], T],
    *,
    retry_policy: RetryPolicy,
    retryable: Callable[[BaseException], bool] | None = None,
) -> T:
    retryable = retryable or _default_retryable
    last_error: BaseException | None = None
    for attempt in range(1, retry_policy.attempts + 1):
        try:
            return operation()
        except BaseException as exc:
            last_error = exc
            if attempt >= retry_policy.attempts or not retryable(exc):
                raise
            delay = retry_policy.backoff_seconds * attempt
            retry_after = getattr(exc, "retry_after_seconds", None)
            if retry_policy.honor_retry_after and isinstance(
                retry_after, (int, float)
            ):
                delay = max(delay, float(retry_after))
            if retry_policy.max_backoff_seconds > 0:
                delay = min(delay, retry_policy.max_backoff_seconds)
            time.sleep(delay)
    raise RetryExhaustedError("retry attempts exhausted") from last_error


def _default_retryable(exc: BaseException) -> bool:
    status_code = getattr(exc, "status_code", None)
    if isinstance(status_code, int):
        return status_code == 429 or 500 <= status_code <= 599
    return isinstance(exc, (ConnectionError, TimeoutError, OSError))
