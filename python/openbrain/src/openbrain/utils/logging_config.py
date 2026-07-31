"""Logging setup. Called exactly once, by config, at process start.

Purpose:
    This module owns every logging sink in the process. Nothing else calls
    ``logger.add()``, ``logger.remove()``, or configures a handler. Call sites
    only ever call ``logger.debug/info/warning/error`` on the imported loguru
    logger.

Architecture:
    Logging configured in two places produces duplicate lines, or a sink that
    silently replaces another, and the symptom -- missing logs -- shows up far
    from the cause. Concentrating it here means the answer to "where do logs go"
    is one file, and changing it is one edit.

    THE THREE SINKS, AND WHY ALL THREE. Each answers a different question, and
    dropping one costs an answer that is eventually needed:

    - **Console** answers "what is happening right now", while someone watches.
      Human-shaped, on stderr.
    - **Rotating file** answers "what happened an hour ago" on this machine.
      Plain text, searchable, size-rotated.
    - **JSON** answers "what happened across all instances last Tuesday", by
      being ingestible into a log platform. One object per line.

    core01 runs two Open Brain workers behind one port (``AGENTS.md``), so the
    third sink is not hypothetical here: with two instances, reading two plain
    text files is guesswork, and the structured sink is the only one that
    aggregates. ``worker_name`` is bound onto every record for exactly that.

Key Components:
    - setup_logging: builds all sinks from LogSettings. Idempotent.
    - LogContext: correlation-id binding, including across await boundaries.

Pattern/Convention:
    Called once from :func:`openbrain.config.load_settings`, never from a
    module, a service, or a test body. Modules import the loguru ``logger``
    directly; the sinks are already configured by the time anything is
    constructed.

    Every log line carries a component prefix and the identifiers needed to
    correlate it::

        logger.info(f"CAPTURE: stored session={session_id} kind={kind}")

    Without identifiers a line proves something happened but not to what, which
    is the same as having nothing when debugging one session out of fifty.

    Sink failures are not caught. A process that cannot write its logs should
    fail at start, loudly, rather than run blind -- silent log loss is how a
    capture-loss bug goes unnoticed for three days.

Example:
    >>> from openbrain.config import LogSettings
    >>> from openbrain.utils.logging_config import setup_logging
    >>> setup_logging(LogSettings(level="DEBUG"))
    >>> from loguru import logger
    >>> logger.info("READY: sinks configured")

See Also:
    - ``openbrain.config`` - the only caller of setup_logging
    - ``docs/standards/STANDARDS-python.md`` - the logging section
    - ``docs/CODING_STANDARDS.md`` - the shared log envelope
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

if TYPE_CHECKING:
    # Import-time-only, and the guard is load-bearing rather than stylistic:
    # openbrain.config imports THIS module, so an unguarded import back into
    # config would be a circular import at interpreter start.
    from openbrain.config import LogSettings


#: Module-level constants rather than inline literals. A format string repeated
#: across three sinks is three places to get it wrong.
CONSOLE_FORMAT = (
    "<green>{time:HH:mm:ss.SSS}</green> "
    "<level>{level: <8}</level> "
    "<cyan>{extra[correlation_id]}</cyan> "
    "<level>{message}</level>"
)

FILE_FORMAT = (
    "{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | "
    "{extra[correlation_id]} | {name}:{function}:{line} | {message}"
)

#: Bound so ``{extra[correlation_id]}`` never raises KeyError on a line emitted
#: outside any request context.
DEFAULT_CORRELATION_ID = "-"


def setup_logging(settings: LogSettings) -> None:
    """Configure every logging sink for the process.

    Idempotent: existing sinks are removed first, so calling this twice -- a
    test, a reload -- yields the same sinks rather than double the lines.

    Args:
        settings: Level, sink paths, rotation, and service identity.

    Raises:
        OSError: If a log directory cannot be created. Deliberately not caught.
    """
    # Remove loguru's default stderr sink. Without this every message is emitted
    # twice: once by the default, once by ours.
    logger.remove()

    logger.configure(
        extra={
            "correlation_id": DEFAULT_CORRELATION_ID,
            "service": settings.service_name,
            "worker": settings.worker_name or "-",
        }
    )

    _add_console_sink(settings)

    if settings.file is not None:
        _add_rotating_file_sink(settings, Path(settings.file))

    if settings.json_file is not None:
        _add_json_sink(settings, Path(settings.json_file))

    logger.info(
        f"LOG: sinks ready level={settings.level} "
        f"file={settings.file} json={settings.json_file} "
        f"service={settings.service_name} worker={settings.worker_name or '-'}"
    )


def _add_console_sink(settings: LogSettings) -> None:
    """Human-readable sink on stderr.

    stderr, not stdout: stdout carries a hook's actual response payload, and
    Claude Code parses it. A log line interleaved into that stream corrupts the
    response -- which is a real failure mode for the hook entrypoints this
    package is being built to host, not a hypothetical one.
    """
    if settings.serialize:
        # serialize=True emits the record as JSON and ignores `format`; passing
        # a format here would be misleading rather than merely redundant.
        logger.add(sys.stderr, level=settings.level, serialize=True)
        return

    logger.add(
        sys.stderr,
        level=settings.level,
        format=CONSOLE_FORMAT,
        colorize=True,
    )


def _prepare_directory(path: Path) -> None:
    """Create the parent directory for a file sink.

    ``parents=True`` so a fresh clone works with no manual mkdir; ``exist_ok``
    so a second run is not an error.
    """
    path.parent.mkdir(parents=True, exist_ok=True)


def _add_rotating_file_sink(settings: LogSettings, path: Path) -> None:
    """Plain-text rotating sink -- the one a human reads."""
    _prepare_directory(path)
    logger.add(
        path,
        level=settings.level,
        format=FILE_FORMAT,
        rotation=settings.max_bytes,
        retention=settings.max_files,
        # Writes happen on a worker thread, so a slow or full disk cannot block
        # the caller. Without this, one stalled write stalls the hook that is
        # holding up an interactive turn.
        enqueue=True,
        compression="gz",
        # Never write local variable values to disk: a frame may hold a token.
        diagnose=False,
    )


def _add_json_sink(settings: LogSettings, path: Path) -> None:
    """Structured sink -- one JSON object per line, for aggregation."""
    _prepare_directory(path)
    logger.add(
        path,
        level=settings.level,
        # serialize=True is the whole feature: loguru emits the record as JSON
        # including extras, so `service`, `worker`, and `correlation_id` are
        # real keys rather than text embedded in a message string.
        serialize=True,
        rotation=settings.max_bytes,
        retention=settings.max_files,
        enqueue=True,
        compression="gz",
        diagnose=False,
    )


class LogContext:
    """Bind a correlation id for the duration of a block.

    Every log line emitted inside the block carries the id, including lines from
    functions several layers down and lines emitted across ``await`` boundaries.
    That is what makes it possible to reconstruct one session's capture out of
    interleaved concurrent work.

    A correlation id passed as a function argument gets dropped the first time
    someone adds a helper and forgets to thread it through. Binding it to the
    logger's context means no call site has to know it exists.

    Example:
        >>> with LogContext("session-42"):
        ...     logger.info("CAPTURE: started")  # carries correlation_id
    """

    def __init__(self, correlation_id: str) -> None:
        """Store the id; binding happens on ``__enter__``."""
        self._correlation_id = correlation_id
        self._token: Any = None

    def __enter__(self) -> str:
        """Bind the id and return it."""
        self._token = logger.contextualize(correlation_id=self._correlation_id)
        self._token.__enter__()
        return self._correlation_id

    def __exit__(self, *exc_info: object) -> None:
        """Unbind, restoring whatever context was active before."""
        if self._token is not None:
            self._token.__exit__(*exc_info)
