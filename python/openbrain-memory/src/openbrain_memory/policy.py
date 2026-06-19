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
# Credentials embedded in a URL's userinfo (scheme://user:pass@host).
URL_USERINFO_CRED_RE = r"[a-z][a-z0-9+.-]*://[^\s:@/]+:[^\s@/]+@[^\s/]+"
# Context-labeled long hex/base64 secrets; requires a credential LABEL so bare
# git SHAs / content hashes are not over-rejected.
LABELED_LONG_SECRET_RE = (
    r"(?i)(client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key)"
    r"\s*[:=]\s*[A-Za-z0-9._/+=-]{20,}"
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

    def __post_init__(self) -> None:
        if self.attempts < 1:
            raise ValueError("RetryPolicy.attempts must be >= 1")
        if self.backoff_seconds < 0:
            raise ValueError("RetryPolicy.backoff_seconds must be >= 0")


def idempotency_key() -> str:
    return f"obmem-{uuid4().hex}"


def redact_text(text: str) -> str:
    redacted = text
    for pattern in SECRET_PATTERNS:
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
            time.sleep(retry_policy.backoff_seconds * attempt)
    raise RetryExhaustedError("retry attempts exhausted") from last_error


def _default_retryable(exc: BaseException) -> bool:
    status_code = getattr(exc, "status_code", None)
    if isinstance(status_code, int):
        return status_code == 429 or 500 <= status_code <= 599
    return isinstance(exc, (ConnectionError, TimeoutError, OSError))
