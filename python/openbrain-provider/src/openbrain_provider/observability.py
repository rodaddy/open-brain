"""Observability init, delegating the envelope to `rtech-obs`.

This module is deliberately thin. `rtech-standards/OBSERVABILITY_CONTRACT.md`
and its `rtech-obs` package are infra's shared implementation -- a first pass,
not settled policy -- but the reason to use them does not depend on their
authority: a second, divergent logger in this repo is worse than a shared one
that still has rough edges, and being an early consumer is how the rough edges
get found. An earlier revision of this package grew its own logger; it emitted
loguru's internal `{"text":..., "record":{...}}` shape, which has none of the
five expected top-level fields, an uppercase level, and no `host` at all. Any
query written against the shared envelope would have missed it entirely.

The one thing this package knows that `rtech-obs` cannot: **these processes are
agent hooks, so stdout is the machine-readable return channel.** A log line on
stdout is not stray output, it is a corrupted response. `rtech-obs` defaults
`LOG_STDOUT` to true, which is right for a service under journald and wrong
here, so this module pins `stdout=False`.

That pin alone is not sufficient, which is the subtle part. §5.1 says an
unwritable `LOG_FILE` must not be fatal, and `rtech-obs` honors that by adding a
stdout sink when the file sink fails -- *overriding* `stdout=False`, by design.
Its default log location is `/mnt/logs/services/<service>/`, and **that mount
does not exist yet**, so today the fallback fires every time: a hook would
silently start logging onto its own return channel. Both behaviors are
individually reasonable; the collision is specific to processes whose stdout
carries data.

Resolved by never letting the fallback trigger. `resolve_log_file` prefers the
shared location and falls back to a writable temp directory, so the file sink
always succeeds and no stdout sink is ever added. It needs no change when
`/mnt/logs` is eventually provisioned -- it starts preferring the real location
the day the mount appears.
"""

from __future__ import annotations

import tempfile
from datetime import UTC, datetime
from pathlib import Path

from rtech_obs import ObservabilityConfig, init_observability, logger

from .config import ProviderConfig

__all__ = ["SERVICE_NAME", "configure_observability", "logger", "resolve_log_file"]

#: Catalog service name for every record this package emits.
SERVICE_NAME = "openbrain-provider"

#: Shared log location from the observability contract. Not provisioned yet, so
#: this is aspirational today and the temp fallback is what actually runs.
_CONTRACT_LOG_ROOT = Path("/mnt/logs/services")


def _usable_log_dir(path: Path) -> Path | None:
    """Return the directory if a log file can actually be written there.

    Creating the directory is not proof it is usable: it can exist and still
    reject writes, and a read-only mount fails at `mkdir` while a
    wrong-permissions one fails at open. Both are the same answer here, so this
    tries the real operation rather than inspecting permission bits.

    Args:
        path: Candidate directory.

    Returns:
        The path if a file was successfully created and removed in it,
        otherwise None.
    """
    probe = path / ".write-probe"
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe.touch()
        probe.unlink()
    except OSError:
        return None
    return path


def resolve_log_file(explicit: Path | None, *, service: str = SERVICE_NAME) -> Path:
    """Choose a log path that is actually writable.

    An explicit path is honored as-is: the operator asked for it, and silently
    relocating their logs would be worse than failing where they can see it.

    Args:
        explicit: Operator-configured path, or None to resolve a default.
        service: Service name, used in the default path.

    Returns:
        A path whose parent directory accepts writes. Falls back to the shared
        location as a last resort, which lets `rtech-obs` report the failure in
        its own words rather than this function inventing an error for a
        situation the caller can do nothing about.
    """
    if explicit is not None:
        return explicit

    filename = f"{datetime.now(UTC).strftime('%Y-%m-%d')}.jsonl"
    shared_dir = _CONTRACT_LOG_ROOT / service

    # Shared location first, so this starts using /mnt/logs the day it exists
    # with no code change. Local temp dir second: anywhere writable beats
    # rtech-obs falling back to a stdout sink, because stdout is the hook's
    # response channel.
    for candidate in (shared_dir, Path(tempfile.gettempdir()) / f"{service}-logs"):
        usable = _usable_log_dir(candidate)
        if usable is not None:
            return usable / filename

    return shared_dir / filename


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
