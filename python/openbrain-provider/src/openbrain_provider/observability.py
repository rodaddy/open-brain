"""Observability init, delegating the envelope to `rtech-obs`.

This module is deliberately thin. `rtech-standards/OBSERVABILITY_CONTRACT.md`
is normative -- "if an implementation and this document disagree, this document
wins and the implementation is a bug" -- and it ships `rtech-obs` as the
reference implementation precisely so nine repos do not each grow their own
logger. An earlier revision of this package DID grow its own; it emitted
loguru's internal `{"text":..., "record":{...}}` shape, which has none of the
five required top-level fields, an uppercase level, and no `host` at all. Every
contract Loki query missed it.

The one thing this package knows that `rtech-obs` cannot: **these processes are
agent hooks, so stdout is the machine-readable return channel.** A log line on
stdout is not stray output, it is a corrupted response. `rtech-obs` defaults
`LOG_STDOUT` to true, which is right for a service under journald and wrong
here, so this module pins `stdout=False`.

That pin alone is not sufficient, which is the subtle part. Contract §5.1 says
an unwritable `LOG_FILE` MUST NOT be fatal, and `rtech-obs` honors it by adding
a stdout sink when the file sink fails -- *overriding* `stdout=False`, by
design. On a box without the `/mnt/logs` mount that default path is unwritable,
so a hook would silently start logging onto its own return channel. Both
behaviors are individually right; the collision is specific to hooks.

Resolved by never letting the fallback trigger: this module resolves a log file
it can actually write, preferring the contract's location, then falling back to
a user-writable directory before handing the path to `rtech-obs`. The file sink
succeeds, so no stdout sink is ever added.
"""

from __future__ import annotations

import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from rtech_obs import ObservabilityConfig, init_observability, logger

from .config import ProviderConfig

__all__ = ["SERVICE_NAME", "configure_observability", "logger", "resolve_log_file"]

#: Catalog service name for every record this package emits.
SERVICE_NAME = "openbrain-provider"

#: Contract §5 default log location, preferred when the mount exists.
_CONTRACT_LOG_ROOT = Path("/mnt/logs/services")


def _is_writable_dir(path: Path) -> bool:
    """Report whether a directory exists (or can be made) and accepts writes.

    Args:
        path: Directory to test.

    Returns:
        True if a log file could be created there.
    """
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError:
        return False
    return os.access(path, os.W_OK)


def resolve_log_file(explicit: Path | None, *, service: str = SERVICE_NAME) -> Path:
    """Choose a log path that is actually writable.

    An explicit path is honored as-is: the operator asked for it, and silently
    relocating their logs would be worse than failing where they can see it.

    Args:
        explicit: Operator-configured path, or None to resolve a default.
        service: Service name, used in the default path.

    Returns:
        A path whose parent directory accepts writes.
    """
    if explicit is not None:
        return explicit

    day = datetime.now(UTC).strftime("%Y-%m-%d")
    filename = f"{day}.jsonl"

    contract_dir = _CONTRACT_LOG_ROOT / service
    if _is_writable_dir(contract_dir):
        return contract_dir / filename

    # No /mnt/logs on this box. Anywhere writable beats the stdout fallback,
    # because stdout is the hook's response channel.
    fallback = Path(tempfile.gettempdir()) / f"{service}-logs"
    if _is_writable_dir(fallback):
        return fallback / filename

    return contract_dir / filename


def configure_observability(
    config: ProviderConfig, *, service: str = SERVICE_NAME
) -> ObservabilityConfig:
    """Install contract-conforming sinks for a hook process.

    Args:
        config: Validated provider configuration.
        service: Catalog service name bound to every record.

    Returns:
        The frozen `rtech-obs` configuration that was installed.

    Raises:
        rtech_obs.ConfigError: If the resolved level or service is invalid.
            Configuration fails closed at init rather than degrading silently.
    """
    return init_observability(
        {},
        service=service,
        # Lowercase is the contract spelling; `rtech-obs` validates it and
        # raises on anything non-conforming, so a bad value cannot reach a sink.
        level=config.log.level,
        # Always a resolved, writable path. Passing None would let rtech-obs
        # default to /mnt/logs and, where that is absent, fall back to a stdout
        # sink -- onto the hook's response channel. See the module docstring.
        log_file=str(resolve_log_file(config.log.log_file, service=service)),
        # Never stdout. See the module docstring: this is the whole point.
        stdout=False,
        # Hooks are short-lived processes. An HTTP exposition endpoint would
        # outlive nothing and a textfile write would race every other hook
        # invocation, so metrics stay off until a slice needs them.
        metrics_mode="off",
    )
