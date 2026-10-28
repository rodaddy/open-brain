"""Mask secret values in a turn while keeping the statement that carried them.

Purpose:
    Secret-shaped values must never reach the provider, the lane, or a log. But
    a turn is not dropped for containing one -- "I put the token in .env" is a
    real decision, and losing it to protect a value that gets masked anyway is
    the wrong trade.

Architecture:
    One function, one job: replace value-shaped matches with a placeholder.

    The sentence survives; only the value changes. That is the whole design, and
    it is why this is redaction rather than rejection.

Pattern/Convention:
    Patterns are ordered MOST-SPECIFIC FIRST. A looser pattern matching first
    would consume part of a token and leave the remainder exposed -- a partial
    match is worse than no match, because it looks handled.

    This module DOES NOT decide whether a turn is safe to keep. It has no
    opinion about the turn at all; it returns text with values masked.

Example:
    >>> redact("token is sk-abc123def456ghi789jkl")
    'token is [REDACTED]'

See Also:
    - ``docs/decisions/capture-never-drops-a-turn.md`` - a turn is never dropped
      for containing a credential
"""

from __future__ import annotations

import re

#: What a masked value is replaced with.
#:
#: A fixed string rather than a length-preserving mask: preserving the length
#: leaks how long the secret was, and a uniform marker makes a redaction
#: obvious when reading a stored turn.
PLACEHOLDER = "[REDACTED]"

#: Value shapes that are masked, most-specific first.
#:
#: Each entry is (pattern, replacement). The replacement may reference groups so
#: the surrounding statement -- the key name, the assignment -- is kept while
#: only the value is replaced. Keeping the key is deliberate: "OPENAI_API_KEY
#: was wrong" is useful, and it is not a secret.
REDACTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    # Provider-prefixed keys. Specific prefixes first so a generic
    # long-random-string rule can never claim part of one.
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"), PLACEHOLDER),
    (re.compile(r"\bghp_[A-Za-z0-9]{16,}"), PLACEHOLDER),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), PLACEHOLDER),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"), PLACEHOLDER),
    # Bearer tokens in a header or a curl line.
    (re.compile(r"\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*"), rf"\1 {PLACEHOLDER}"),
    # KEY=value and "key": "value" assignments, where the NAME says it is secret.
    # The name is kept; only the value is masked.
    (
        re.compile(
            r"\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|APIKEY|API_KEY|CREDENTIAL)[A-Z0-9_]*)"
            r"(\s*[=:]\s*)"
            r'["\']?[^\s"\',;]+["\']?'
        ),
        rf"\1\2{PLACEHOLDER}",
    ),
    # A password inside a connection URI, keeping the rest of the URI readable.
    (re.compile(r"(://[^:/@\s]+):[^@/\s]+@"), rf"\1:{PLACEHOLDER}@"),
)


def redact(text: str) -> str:
    """Mask secret-shaped values, leaving the statement around them intact.

    Args:
        text: The turn, after system wrappers have been removed.

    Returns:
        The text with values masked. Length is not preserved and is not meant to
        be -- the returned text is what gets stored, whole, and it is the
        redacted form that is the real content.

    Example:
        >>> redact('DB_PASSWORD="hunter2"')
        'DB_PASSWORD=[REDACTED]'
    """
    for pattern, replacement in REDACTIONS:
        text = pattern.sub(replacement, text)
    return text
