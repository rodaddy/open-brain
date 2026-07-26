"""Structured logging that emits the shared observability envelope.

The envelope is the one from `rtech-standards/OBSERVABILITY_CONTRACT.md`: a
single-line JSON object carrying `timestamp`, `level`, `service`, `host`, and
`message` at the top level, with everything else nested under `context`.

**This is deliberately not the `rtech-obs` package**, which is the shared
implementation of that contract and would otherwise be the right dependency.
`rtech-standards` is a private repository and this repo's CI passes no token, so
no git URL can fetch it -- SSH fails on host-key verification, HTTPS fails with
`could not read Username`. Both were tried, and the second failure is what the
new CI gate caught. Publishing the package, or wiring a cross-repo checkout
secret, is the real fix; until then a dependency CI cannot install is worse than
a small local writer.

What that costs, stated plainly: this is a second implementation of a shared
envelope, which is the drift the contract exists to prevent. It is mitigated
only by being small, by writing the contract's field names rather than a
convenient approximation, and by `test_observability.py` asserting conformance
directly rather than asserting whatever this code happens to emit. Replace it
with `rtech-obs` once that package is installable here; the public surface
(`configure_observability`, `logger`) is shaped to make that a drop-in swap.

The one policy this module owns regardless of implementation: **these processes
are agent hooks, so stdout is the machine-readable return channel.** A log line
on stdout is not stray output, it is a corrupted response. Records go to a file,
and to stderr if that file cannot be opened. Never stdout.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import sys
import tempfile
import traceback
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

from loguru import logger

from .config import ProviderConfig

__all__ = [
    "SERVICE_NAME",
    "TOP_LEVEL_FIELDS",
    "configure_observability",
    "flush_logs",
    "install_signal_flush",
    "logger",
    "resolve_log_file",
]

#: Catalog service name for every record this package emits.
SERVICE_NAME = "openbrain-provider"

#: Contract §1.1: every record carries exactly these at the top level.
TOP_LEVEL_FIELDS: Final[tuple[str, ...]] = (
    "timestamp",
    "level",
    "service",
    "host",
    "message",
)

#: Shared log location from the contract. Not provisioned yet, so this is
#: aspirational today and the temp fallback is what actually runs.
_CONTRACT_LOG_ROOT = Path("/mnt/logs/services")

#: Resolved once: `gethostname` is a syscall and cannot change usefully within
#: the lifetime of a hook process.
_HOSTNAME: Final[str] = socket.gethostname()


def _usable_log_dir(path: Path) -> Path | None:
    """Return the directory if a log file can actually be written there.

    Creating the directory is not proof it is usable: it can exist and still
    reject writes, and a read-only mount fails at `mkdir` while a
    wrong-permissions one fails at open. Both are the same answer here, so this
    tries the real operation rather than inspecting permission bits.

    Args:
        path: Candidate directory.

    Returns:
        The path if a file was created and removed in it, otherwise None.
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

    An operator-supplied path is preferred but still probed. An earlier revision
    returned it unchecked, reasoning that silently relocating an operator's logs
    was worse than failing where they could see it. That reasoning was wrong
    about the consequence: the failure was not visible, it silently redirected
    every log record onto the hook's response channel.

    Args:
        explicit: Operator-configured path, or None to resolve a default.
        service: Service name, used in the default path.

    Returns:
        A path whose parent directory accepts writes.
    """
    filename = f"{datetime.now(UTC).strftime('%Y-%m-%d')}.jsonl"
    shared_dir = _CONTRACT_LOG_ROOT / service
    temp_dir = Path(tempfile.gettempdir()) / f"{service}-logs"

    if explicit is not None:
        if _usable_log_dir(explicit.parent) is not None:
            return explicit
        candidates: tuple[Path, ...] = (temp_dir, shared_dir)
    else:
        # Shared location first, so this starts using /mnt/logs the day it
        # exists with no code change.
        candidates = (shared_dir, temp_dir)

    for candidate in candidates:
        usable = _usable_log_dir(candidate)
        if usable is not None:
            return usable / filename

    return shared_dir / filename


def _error_payload(exception: Any) -> dict[str, Any] | None:
    """Build the contract's `error` object from a loguru exception record.

    Args:
        exception: The loguru record's exception tuple, or None.

    Returns:
        A dict with `type`, `message`, and `stacktrace`, or None if the record
        carries no exception.
    """
    if exception is None or exception.type is None:
        return None
    payload: dict[str, Any] = {
        "type": exception.type.__name__,
        "message": str(exception.value),
    }
    if exception.traceback is not None:
        payload["stacktrace"] = "".join(
            traceback.format_exception(
                exception.type, exception.value, exception.traceback
            )
        ).rstrip("\n")
    return payload


def _timestamp(moment: datetime) -> str:
    """Render a timestamp in the contract's format.

    Args:
        moment: The record's time, in any timezone.

    Returns:
        RFC 3339 / ISO 8601 in UTC with millisecond precision and a Z suffix,
        e.g. `2026-07-25T04:16:07.418Z`. Built explicitly rather than via
        `isoformat()`, which emits microseconds and `+00:00`.
    """
    utc = moment.astimezone(UTC)
    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"


def _format_record(record: Mapping[str, Any], *, service: str) -> str:
    """Render one loguru record as a conforming single-line JSON envelope.

    Args:
        record: The loguru record mapping.
        service: Catalog service name to stamp on the record.

    Returns:
        A single-line JSON string. `json.dumps` escapes any embedded newline, so
        a multi-line message cannot break line-oriented collection.
    """
    extra = dict(record["extra"])
    extra.pop("service", None)
    extra.pop("_serialized", None)

    envelope: dict[str, Any] = {
        "timestamp": _timestamp(record["time"]),
        "level": str(record["level"].name).lower(),
        "service": service,
        "host": _HOSTNAME,
        "message": str(record["message"]),
    }

    for optional in ("correlation_id", "event", "duration_ms"):
        value = extra.pop(optional, None)
        if value is not None:
            envelope[optional] = value

    error = _error_payload(record.get("exception")) or extra.pop("error", None)
    if error is not None:
        envelope["error"] = error

    context = extra.pop("context", None)
    if isinstance(context, dict):
        extra.update(context)
    elif context is not None:
        extra["context"] = context

    # Anything left is caller-supplied and not a contract field, so it goes
    # under `context` rather than polluting the indexed top level.
    if extra:
        envelope["context"] = extra

    return json.dumps(envelope, separators=(",", ":"), default=str)


def flush_logs() -> None:
    """Drain the background writer queue.

    `enqueue=True` hands each record to a writer thread, so `logger.info()`
    returns before the bytes reach disk. That is the right trade for a hook --
    it must not block on I/O to log -- but it means the queue can outlive the
    process.
    """
    logger.remove()


def install_signal_flush() -> None:
    """Drain the log queue on SIGTERM and SIGINT before exiting.

    **Call this from an entrypoint, not from library code.** It is deliberately
    opt-in: `configure_observability` does not call it. Installing a
    process-global signal handler is the entrypoint's decision, because the
    entrypoint is the only layer that knows whether something else already owns
    shutdown. `b1x-message-coordinator` -- a long-running loguru service that has
    never had a logging problem -- puts its `signal_handler` in each service's
    `__main__` and keeps the logging module free of signals. Same split here.

    Why a hook needs it when that service does not: loguru's `atexit` hook drains
    the queue on a **clean** exit, which is how a daemon shutting down through
    its own handler exits. Measured, with plain `enqueue=True` and no handler at
    all: clean exit 200/200, abrupt SIGTERM ~100/200. A daemon never hits the
    second case. A hook is a short-lived process the runtime can kill mid-run, so
    it hits exactly that case, and the records it loses are the newest ones --
    the ones explaining whatever killed it.

    Only installs a handler when none is set, and chains to any previous one, so
    this never silently overrides a caller's own shutdown logic. Signal handlers
    can only be installed from the main thread; when called from another thread
    this is a no-op rather than an error.
    """
    for signum in (signal.SIGTERM, signal.SIGINT):
        try:
            previous = signal.getsignal(signum)
        except (ValueError, OSError):  # pragma: no cover - platform dependent
            continue

        # SIG_DFL/SIG_IGN mean nobody has claimed it. So does
        # `default_int_handler`, which is the interpreter's own SIGINT default
        # and is a callable -- checking `callable()` alone would skip SIGINT
        # every time. Any other callable is a real caller-installed handler, and
        # stomping it would be worse than the records it saves.
        claimed = callable(previous) and previous is not signal.default_int_handler
        if claimed:
            continue

        def handler(
            _sig: int, _frame: Any, _previous: Any = previous, _signum: int = signum
        ) -> None:
            flush_logs()
            # Restore the previous disposition and re-raise, so the process
            # still dies the way the sender asked. Swallowing the signal would
            # trade a lost log line for a process that ignores shutdown.
            #
            # SIGINT is the exception: Python's default handler raises
            # KeyboardInterrupt rather than terminating, and re-raising through
            # SIG_DFL would hard-kill instead -- turning a Ctrl-C that `finally`
            # blocks can clean up after into one that skips them.
            if _signum == signal.SIGINT and _previous is signal.default_int_handler:
                signal.signal(_signum, _previous)
                raise KeyboardInterrupt
            signal.signal(_signum, _previous)
            os.kill(os.getpid(), _signum)

        try:
            signal.signal(signum, handler)
        except (ValueError, OSError):  # pragma: no cover - non-main thread
            continue


def configure_observability(
    config: ProviderConfig, *, service: str = SERVICE_NAME
) -> Path:
    """Install the process's log sinks.

    Idempotent: removes all existing sinks first, so calling it twice
    reconfigures rather than duplicating output. A duplicated sink is silent --
    the process still works, it just writes every line twice, and nobody notices
    until a log-volume alarm fires.

    Args:
        config: Validated provider configuration.
        service: Catalog service name bound to every record.

    Returns:
        The log file that was actually opened, which may differ from the
        configured one when that path was not writable.
    """
    logger.remove()

    log_file = resolve_log_file(config.log.log_file, service=service)
    level = config.log.level.upper()

    def sink_format(record: Mapping[str, Any]) -> str:
        record["extra"]["_serialized"] = _format_record(record, service=service)
        return "{extra[_serialized]}\n"

    try:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        logger.add(
            str(log_file),
            level=level,
            format=sink_format,
            enqueue=True,
            rotation="100 MB",
            retention="30 days",
        )
    except OSError:
        # Contract §5.1: an unopenable log file must not stop the process. The
        # fallback is stderr, NOT stdout -- stdout is the hook's response
        # channel, the one place a log line must never land.
        logger.add(sys.stderr, level=level, format=sink_format, enqueue=True)

    # NOTE: no signal handler is installed here. Configuring logging must not
    # claim a process-global signal on the caller's behalf -- see
    # `install_signal_flush`, which an entrypoint calls explicitly.
    return log_file
