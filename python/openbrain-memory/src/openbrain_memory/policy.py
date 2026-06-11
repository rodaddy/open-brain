from __future__ import annotations

from dataclasses import dataclass
import re
import time
from typing import Any, Callable, TypeVar
from uuid import uuid4


SK_PREFIX = "sk" + "-"
GITHUB_PREFIX_RE = "gh" + r"[pousr]_"
GITHUB_PAT_PREFIX = "github" + r"_pat_"
PRIVATE_KEY_BLOCK_RE = (
    "-----BEGIN [A-Z ]*PRIVATE "
    "KEY-----.*?-----END [A-Z ]*PRIVATE "
    "KEY-----"
)

SECRET_PATTERNS = [
    re.compile(r"(?i)authorization\s*[:=]\s*bearer\s+[^\s,;]+"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(rf"\b{SK_PREFIX}[A-Za-z0-9_-]{{10,}}\b"),
    re.compile(rf"(?i){GITHUB_PAT_PREFIX}[A-Za-z0-9_]+"),
    re.compile(rf"(?i){GITHUB_PREFIX_RE}[A-Za-z0-9_]{{20,}}"),
    re.compile(r"(?i)(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+"),
    re.compile(r'(?i)"(api[_-]?key|token|password|secret)"\s*:\s*"[^"]+"'),
    re.compile(PRIVATE_KEY_BLOCK_RE, re.S),
]
SENSITIVE_KEY_RE = re.compile(r"(?i)(token|secret|password|api[_-]?key|credential|authorization)")


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


T = TypeVar("T")


def idempotency_key() -> str:
    return f"obmem-{uuid4().hex}"


def redact_text(text: str) -> str:
    redacted = text
    for pattern in SECRET_PATTERNS:
        redacted = pattern.sub("[REDACTED]", redacted)
    return redacted


def redact_value(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            redacted[key_text] = "[REDACTED]" if SENSITIVE_KEY_RE.search(key_text) else redact_value(item)
        return redacted
    if isinstance(value, list):
        return [redact_value(item) for item in value]
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
