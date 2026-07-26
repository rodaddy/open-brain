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

from .constants import (
    MAX_CONTEXT_PACK_MAX_TOKENS,
    PACKAGE_TIMEOUT_SECONDS,
)

#: Conforming level spellings. `warn`, `err`, and `crit` are non-conforming:
#: Loki matches level values literally, so an abbreviation splits the query
#: surface for every dashboard that filters on level.
LOG_LEVELS: Final[frozenset[str]] = frozenset(
    {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
)

_ENV_LOG_LEVEL: Final[str] = "OPENBRAIN_PROVIDER_LOG_LEVEL"
_ENV_LOG_FILE: Final[str] = "OPENBRAIN_PROVIDER_LOG_FILE"
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

    level: str = "INFO"
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
        """Validate the context-pack budget.

        Raises:
            ConfigError: If the budget is not a positive int within bounds.
        """
        budget = self.context_pack_max_tokens
        if budget is None:
            return
        if budget <= 0:
            raise ConfigError(f"context pack budget must be positive, got {budget!r}")
        if budget > MAX_CONTEXT_PACK_MAX_TOKENS:
            raise ConfigError(
                f"context pack budget must be <= {MAX_CONTEXT_PACK_MAX_TOKENS}, "
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

    level = source.get(_ENV_LOG_LEVEL, "").strip().upper() or "INFO"
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
