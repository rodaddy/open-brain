"""Loguru setup, and nothing else.

One configuration function, called once at process start. No other module in
this package calls ``logger.add()``; they import ``logger`` from loguru and
log. That keeps the sink set answerable from one file.

Two rules the observability contract makes non-negotiable, both easy to break
by accident:

* **Never stdout.** These processes are agent hooks. stdout is the hook's
  machine-readable return channel, so a log line written there is not a stray
  message, it is a corrupted response. Loguru's default sink IS stderr, but it
  is added implicitly at import; we remove it and add our own so the choice is
  explicit and visible.
* **Structured, not formatted.** ``serialize=True`` emits one JSON object per
  line. A human-formatted line has to be re-parsed by a regex in the log
  pipeline, and that regex breaks the first time a message contains a bracket.
"""

from __future__ import annotations

import sys
from typing import Any

from loguru import logger

from .config import LogConfig

#: Bound to every record so a line identifies its own origin without the reader
#: needing to know which process wrote it.
_SERVICE_NAME = "openbrain-provider"


def configure_logging(config: LogConfig, *, service: str = _SERVICE_NAME) -> None:
    """Install the process's log sinks.

    Idempotent: it removes all existing sinks first, so calling it twice
    reconfigures rather than duplicating output. That matters because a
    duplicated sink is silent -- the process still works, it just writes every
    line twice, and nobody notices until a log-volume alarm fires.

    Args:
        config: Validated logging configuration.
        service: Value bound to the ``service`` field on every record.
    """
    logger.remove()

    logger.configure(extra={"service": service})

    logger.add(
        sys.stderr,
        level=config.level,
        serialize=True,
        enqueue=True,
        backtrace=False,
        diagnose=False,
    )

    if config.log_file is not None:
        config.log_file.parent.mkdir(parents=True, exist_ok=True)
        logger.add(
            config.log_file,
            level=config.level,
            serialize=True,
            enqueue=True,
            backtrace=False,
            diagnose=False,
        )


def bind(**fields: Any) -> Any:
    """Return a logger with additional structured fields bound.

    Args:
        **fields: Structured fields to attach to every record from the returned
            logger. Values must be JSON-serializable; ``serialize=True`` fails
            at write time otherwise.

    Returns:
        A bound loguru logger.
    """
    return logger.bind(**fields)
