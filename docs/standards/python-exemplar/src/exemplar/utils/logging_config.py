"""Logging setup. Called exactly once, by config, at startup.

This module owns every logging sink in the application. Nothing else calls
``logger.add()``, ``logger.remove()``, or configures a handler. Call sites only
ever call ``logger.debug/info/warning/error`` on the imported loguru logger.

WHY ONE OWNER
    Logging configured in two places produces duplicate lines, or a sink that
    silently replaces another, and the symptom (missing logs) shows up far from
    the cause. Concentrating it here means the answer to "where do logs go" is
    one file, and changing it is one edit.

THE THREE SINKS, AND WHY ALL THREE
    Each answers a different question, and dropping any one of them costs you an
    answer you will eventually need:

    - **Console** answers "what is happening right now", while you watch it.
      Colorized, human-shaped, no JSON noise.
    - **Rotating file** answers "what happened an hour ago" on this machine.
      Plain text, greppable, size-rotated so it cannot fill a disk.
    - **JSON** answers "what happened across all instances last Tuesday", by
      being ingestible into a log platform. One object per line.

    The reference repos ship the console and file sinks and treat JSON as
    optional. That is backwards for anything that will ever run on more than one
    host: the moment there are two instances, grepping two plain files is
    guesswork, and the structured sink is the only one that can be aggregated.

WHY loguru AND NOT stdlib logging
    Rotation, retention, JSON serialization, and per-sink levels are constructor
    arguments here. In stdlib logging each is a handler class assembled by hand,
    and the assembly is what gets copied wrong between projects.

Key Components:
    - setup: builds all sinks from LoggingSettings. Idempotent.
    - LogContext: correlation-id binding across await boundaries.

Pattern/Convention:
    Called once from Settings, never from a service or a test. Services import
    the loguru ``logger`` directly and log against it; the sinks are already
    configured by the time any service is constructed.

    Every log line carries a component prefix and the identifiers needed to
    correlate it::

        logger.debug(f"CHECK: starting target={name} url={url}")
        logger.error(f"CHECK: failed target={name}: {exc}", exc_info=True)

    Without identifiers a line proves something happened but not to what, which
    is the same as having nothing when you are debugging one target out of
    fifty.

Example:
    >>> from exemplar.utils.logging_config import setup
    >>> from exemplar.config import LoggingSettings
    >>> setup(LoggingSettings(level="DEBUG"), app_name="exemplar", env="test")
    >>> from loguru import logger
    >>> logger.info("READY: sinks configured")

See Also:
    - exemplar.config: the only caller of setup()
    - _DOCS/STANDARDS-python.md ## Logging
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

if TYPE_CHECKING:
    # Import-time-only. Guarded because config imports THIS module, so an
    # unguarded import here would be a cycle. This is the concrete reason the
    # TYPE_CHECKING rule exists, not a style preference.
    from exemplar.config import LoggingSettings


# Module-level constants, not inline literals. A magic string repeated in three
# sinks is three places to get it wrong.
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

DEFAULT_CORRELATION_ID = "-"


def setup(settings: LoggingSettings, *, app_name: str, env: str) -> None:
    """Configure every logging sink for the process.

    Idempotent: removes existing sinks first, so calling it twice (a test, a
    reload) yields the same three sinks rather than six.

    Args:
        settings: Sink levels, rotation, retention, and which sinks are on.
        app_name: Used in log filenames.
        env: Used in log filenames, so test and prod runs never share a file.

    Raises:
        OSError: If the log directory cannot be created. Deliberately not
            caught -- an application that cannot write logs should fail at
            startup, loudly, rather than run blind.
    """
    # Remove loguru's default stderr sink. Without this, every message is
    # emitted twice: once by the default and once by ours.
    logger.remove()

    # Bind a default so `{extra[correlation_id]}` in the formats never raises a
    # KeyError on a log line emitted outside any request context.
    logger.configure(extra={"correlation_id": DEFAULT_CORRELATION_ID})

    _add_console_sink(settings)

    if settings.file_sink:
        log_dir = Path(settings.directory)
        # parents=True so a fresh clone works with no manual mkdir. exist_ok so
        # a second run is not an error.
        log_dir.mkdir(parents=True, exist_ok=True)
        _add_file_sink(settings, log_dir / f"{app_name}-{env}.log")
        if settings.json_sink:
            _add_json_sink(settings, log_dir / f"{app_name}-{env}.jsonl")

    logger.info(
        f"LOG: sinks ready level={settings.level} "
        f"file={settings.file_sink} json={settings.json_sink} "
        f"dir={settings.directory}"
    )


def _add_console_sink(settings: LoggingSettings) -> None:
    """Human-readable sink on stderr.

    stderr, not stdout: stdout belongs to the program's actual output, and a
    tool that pipes this application's stdout should not receive log lines
    interleaved with data.
    """
    logger.add(
        sys.stderr,
        level=settings.level,
        format=CONSOLE_FORMAT,
        colorize=True,
        # Full tracebacks with local variable values. Excellent locally; a
        # disclosure risk in production, where a frame may hold a token, so it
        # follows the same switch as DEBUG-level logging.
        backtrace=settings.verbose_tracebacks,
        diagnose=settings.verbose_tracebacks,
    )


def _add_file_sink(settings: LoggingSettings, path: Path) -> None:
    """Plain-text rotating sink -- the one a human tails."""
    logger.add(
        path,
        level=settings.level,
        format=FILE_FORMAT,
        rotation=settings.rotation,
        retention=settings.retention,
        # Writes happen on a worker thread, so a slow or full disk cannot block
        # the event loop. Without this, one stalled write stalls every check.
        enqueue=True,
        # Compress rotated files. Log volume is the usual cause of a disk alert
        # nobody expected.
        compression="gz",
        backtrace=settings.verbose_tracebacks,
        diagnose=False,  # never write local variable values to disk
    )


def _add_json_sink(settings: LoggingSettings, path: Path) -> None:
    """Structured sink -- one JSON object per line, for aggregation."""
    logger.add(
        path,
        level=settings.level,
        # serialize=True is the whole feature: loguru emits the record as JSON
        # including extras, so `correlation_id` and any bound fields are real
        # keys rather than text embedded in a message string.
        serialize=True,
        rotation=settings.rotation,
        retention=settings.retention,
        enqueue=True,
        compression="gz",
        diagnose=False,
    )


class LogContext:
    """Bind a correlation id for the duration of a block.

    Every log line emitted inside the block carries the id, including lines from
    functions called several layers down, and including across ``await``
    boundaries. That is what makes it possible to reconstruct one request out of
    interleaved concurrent work.

    A correlation id passed as a function argument gets dropped the first time
    someone adds a helper and forgets to thread it through. Binding it to the
    logger's context means no call site has to know it exists.

    Example:
        >>> with LogContext("req-42"):
        ...     logger.info("CHECK: started")   # carries correlation_id=req-42
    """

    def __init__(self, correlation_id: str) -> None:
        """Store the id; binding happens on __enter__."""
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
