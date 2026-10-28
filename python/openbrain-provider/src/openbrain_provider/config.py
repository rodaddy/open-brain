"""Typed, immutable provider configuration.

Environment is read HERE and nowhere else. The adapter this replaces read
`process.env` at scattered call sites, which is how a value ends up spelled two
ways and how nobody can answer "what is actually configured" without grepping.

Every config object is a frozen dataclass that validates in ``__post_init__``,
so an invalid value fails at construction rather than at first use. That is the
fail-closed-at-boot rule: a provider that starts with a broken configuration and
discovers it mid-session has already lost the write it was configured to make.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Final
from urllib.parse import urlsplit

from .constants import (
    MAX_CONTEXT_PACK_MAX_TOKENS,
    MIN_CONTEXT_PACK_MAX_TOKENS,
    PACKAGE_TIMEOUT_SECONDS,
)

#: Conforming level spellings, lowercase per OBSERVABILITY_CONTRACT.md §1.1.
#: `warn`, `err`, and `crit` are explicitly non-conforming (§): Loki matches
#: level values literally, so an abbreviation -- or a case variant -- splits the
#: query surface for every dashboard that filters on level.
LOG_LEVELS: Final[frozenset[str]] = frozenset(
    {"debug", "info", "warning", "error", "critical"}
)

#: Logging variables are the contract's names (§5), not package-prefixed ones.
#: A service that reads OPENBRAIN_PROVIDER_LOG_LEVEL is unconfigurable by the
#: fleet-wide tooling that sets LOG_LEVEL, which is the entire reason the
#: contract names them.
_ENV_LOG_LEVEL: Final[str] = "LOG_LEVEL"
_ENV_LOG_FILE: Final[str] = "LOG_FILE"

#: Provider-specific settings keep the package prefix; they are not part of the
#: observability contract.
_ENV_BASE_URL: Final[str] = "OPENBRAIN_BASE_URL"
_ENV_TIMEOUT: Final[str] = "OPENBRAIN_PROVIDER_TIMEOUT_SECONDS"
_ENV_CONTEXT_PACK_MAX_TOKENS: Final[str] = "OPENBRAIN_CONTEXT_PACK_MAX_TOKENS"


class ConfigError(ValueError):
    """Raised when configuration is invalid.

    A distinct type so a caller can tell "the operator configured this wrong"
    apart from an arbitrary ``ValueError`` raised deeper in a call stack. The
    two need different operator actions.
    """


@dataclass(frozen=True)
class LogConfig:
    """Logging configuration.

    Attributes:
        level: One of :data:`LOG_LEVELS`.
        log_file: Destination file, or ``None`` for stderr only. Never stdout —
            stdout is the hook's machine-readable return channel and a stray log
            line there corrupts it.
    """

    level: str = "info"
    log_file: Path | None = None

    def __post_init__(self) -> None:
        """Validate the level spelling.

        Raises:
            ConfigError: If ``level`` is not a conforming spelling.
        """
        if self.level not in LOG_LEVELS:
            raise ConfigError(
                f"log level must be one of {sorted(LOG_LEVELS)}, got {self.level!r}"
            )


@dataclass(frozen=True)
class DispatchConfig:
    """How the provider invokes the openbrain-memory CLI.

    Attributes:
        timeout_seconds: Wall-clock ceiling on one invocation. Must be positive
            and finite; an unbounded wait would hang the agent session the hook
            runs inside.
    """

    timeout_seconds: float = PACKAGE_TIMEOUT_SECONDS

    def __post_init__(self) -> None:
        """Validate the timeout.

        Raises:
            ConfigError: If the timeout is not a positive, finite number.
        """
        value = self.timeout_seconds
        if value != value or value in (float("inf"), float("-inf")):
            raise ConfigError(f"dispatch timeout must be finite, got {value!r}")
        if value <= 0:
            raise ConfigError(f"dispatch timeout must be positive, got {value!r}")


#: The only schemes the provider will talk to. `file://` would turn a config
#: value into a local file read, and a bare hostname with no scheme is
#: ambiguous enough that different HTTP clients disagree on what it means.
_ALLOWED_URL_SCHEMES: Final[frozenset[str]] = frozenset({"http", "https"})


def _safe_url(value: str) -> str:
    """Return a URL with any embedded credentials replaced.

    `urlsplit` accepts userinfo, so `http://alice:hunter2@host` is a valid base
    URL. Every validation error below quotes the offending value, and a config
    error at boot is exactly the thing that gets printed to a terminal, captured
    by a service manager, or attached to a bug report -- so quoting the raw
    value turns a malformed URL into credential disclosure.

    Args:
        value: The configured base URL, possibly malformed.

    Returns:
        The value with any `user:password@` portion replaced by `***@`. Falls
        back to a fully redacted marker if the value cannot be parsed at all,
        because an unparseable string is exactly where a naive regex would miss.
    """
    if "@" not in value:
        return value

    # Everything before the LAST '@' in the authority is userinfo. Operating on
    # the raw string rather than parsed attributes keeps this correct for values
    # too malformed to parse -- which is precisely when it is called. Reading
    # `parsed.port` would itself raise on the invalid-port case being reported.
    scheme, sep, rest = value.partition("://")
    if not sep:
        return "***"
    authority, slash, path = rest.partition("/")
    if "@" not in authority:
        return value
    hostport = authority.rsplit("@", 1)[1]
    return f"{scheme}://***@{hostport}{slash}{path}"


def _validate_base_url(value: str) -> None:
    """Reject a base URL that is not a usable HTTP(S) endpoint.

    The previous revision accepted anything, including `file:///etc/passwd`,
    `javascript:alert(1)`, and `http://127.0.0.1:3100 ; rm -rf /`, while this
    module's own docstring promised it failed closed. The value reaches an HTTP
    client and a subprocess environment in later slices, so "we validate
    everything except the one field that names a remote host" was the wrong
    place to stop.

    Args:
        value: The configured base URL.

    Raises:
        ConfigError: If the URL is unparseable, has no host, uses a scheme
            outside :data:`_ALLOWED_URL_SCHEMES`, or contains whitespace or
            control characters.
    """
    if value != value.strip() or any(c.isspace() for c in value):
        raise ConfigError(
            f"base url must not contain whitespace, got {_safe_url(value)!r}"
        )

    # C0/C1 control characters can smuggle a newline into a header or a log
    # line; neither belongs in a URL.
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in value):
        raise ConfigError(
            f"base url must not contain control characters, got {_safe_url(value)!r}"
        )

    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise ConfigError(f"base url is not a valid URL: {_safe_url(value)!r}") from exc

    if parsed.scheme not in _ALLOWED_URL_SCHEMES:
        raise ConfigError(
            f"base url scheme must be one of {sorted(_ALLOWED_URL_SCHEMES)}, "
            f"got {parsed.scheme!r} in {_safe_url(value)!r}"
        )

    if not parsed.hostname:
        raise ConfigError(f"base url must include a host, got {_safe_url(value)!r}")

    # urlsplit defers port parsing, so an invalid port only surfaces when the
    # attribute is read. Bind it so that read is unmistakably deliberate.
    try:
        _port = parsed.port
    except ValueError as exc:
        raise ConfigError(
            f"base url has an invalid port: {_safe_url(value)!r}"
        ) from exc
    del _port


@dataclass(frozen=True)
class ProviderConfig:
    """The complete provider configuration.

    Attributes:
        log: Logging configuration.
        dispatch: Package invocation configuration.
        base_url: Open Brain server URL, or ``None`` when the package resolves
            it itself.
        context_pack_max_tokens: Requested context-pack budget, or ``None`` for
            the package default.
    """

    log: LogConfig
    dispatch: DispatchConfig
    base_url: str | None = None
    context_pack_max_tokens: int | None = None

    def __post_init__(self) -> None:
        """Validate the base URL and the context-pack budget.

        Raises:
            ConfigError: If the base URL is malformed or uses a non-HTTP scheme,
                or the budget is not a positive int within bounds.
        """
        if self.base_url is not None:
            _validate_base_url(self.base_url)

        budget = self.context_pack_max_tokens
        if budget is None:
            return
        # Both ends, matching the adapter. Only checking the ceiling would let a
        # budget of 1 through here and be rejected by the TS path, which is the
        # cross-runtime disagreement the port is supposed to eliminate.
        if not MIN_CONTEXT_PACK_MAX_TOKENS <= budget <= MAX_CONTEXT_PACK_MAX_TOKENS:
            raise ConfigError(
                f"context pack budget must be between "
                f"{MIN_CONTEXT_PACK_MAX_TOKENS} and {MAX_CONTEXT_PACK_MAX_TOKENS}, "
                f"got {budget!r}"
            )


def _optional_int(env: dict[str, str], key: str) -> int | None:
    """Read an optional integer setting.

    Args:
        env: The environment mapping to read from.
        key: Variable name.

    Returns:
        The parsed value, or ``None`` when unset or empty.

    Raises:
        ConfigError: If the value is set but is not an integer. A malformed
            number is an operator mistake and is reported as one, rather than
            silently falling back to a default the operator did not choose.
    """
    raw = env.get(key, "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be an integer, got {raw!r}") from exc


def _optional_float(env: dict[str, str], key: str) -> float | None:
    """Read an optional float setting.

    Args:
        env: The environment mapping to read from.
        key: Variable name.

    Returns:
        The parsed value, or ``None`` when unset or empty.

    Raises:
        ConfigError: If the value is set but is not a number.
    """
    raw = env.get(key, "").strip()
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be a number, got {raw!r}") from exc


def load_config(env: dict[str, str] | None = None) -> ProviderConfig:
    """Build the provider configuration from the environment.

    The single place environment is read. Everything downstream takes a
    :class:`ProviderConfig`, which makes configuration injectable in tests
    without touching real environment variables.

    Args:
        env: Environment mapping. Defaults to ``os.environ``.

    Returns:
        A validated, frozen configuration.

    Raises:
        ConfigError: If any value is invalid. Configuration fails closed at
            construction rather than degrading silently.
    """
    source = dict(os.environ) if env is None else env

    level = source.get(_ENV_LOG_LEVEL, "").strip().lower() or "info"
    log_file_raw = source.get(_ENV_LOG_FILE, "").strip()
    timeout = _optional_float(source, _ENV_TIMEOUT)
    base_url = source.get(_ENV_BASE_URL, "").strip() or None

    return ProviderConfig(
        log=LogConfig(
            level=level,
            log_file=Path(log_file_raw) if log_file_raw else None,
        ),
        dispatch=DispatchConfig(
            timeout_seconds=(PACKAGE_TIMEOUT_SECONDS if timeout is None else timeout),
        ),
        base_url=base_url,
        context_pack_max_tokens=_optional_int(source, _ENV_CONTEXT_PACK_MAX_TOKENS),
    )
