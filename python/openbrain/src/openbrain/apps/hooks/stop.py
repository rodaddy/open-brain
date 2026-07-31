"""The ``Stop`` hook entrypoint: capture the finished turn, and never disrupt it.

Purpose:
    Claude Code runs this on every ``Stop`` and hands it the event as JSON on
    stdin. It reads that payload, hands it to the capture capability, and exits.
    This is the production invoker of the spine -- the one live path that puts a
    real turn in the database.

Architecture:
    A parse-and-exit shell. Reading stdin, loading settings, and choosing a
    capability is all this module does; the capability that builds the client,
    starts the session, and runs the delivery is ``session.run_stop``, so there
    is no business logic here (``_plans/418-prov-9-hook-entrypoints.md``).

Pattern/Convention:
    ALWAYS EXIT 0 WITH EMPTY STDOUT. Capture observes a session; it must never
    block or break one. Every failure -- a malformed payload, an unreadable
    transcript, a lane that cannot be reached -- is logged through the
    configured sinks and swallowed. Nothing is printed, and nothing is re-raised
    to the exit code. Empty stdout with exit 0 is Claude Code's "proceed
    normally", proven against captured runs
    (``tests/fixtures/captured_hooks/README.md``).

    NO retry, queue, or timeout lives here. A failed send leaves the watermark
    unadvanced, and the next ``Stop`` re-reads the same turns -- that is the
    retry, and the sibling package's spool is the durability
    (``apps.capture.deliver``).

Example:
    >>> import io
    >>> capture_stop(io.StringIO("not json"))   # swallowed, no raise
    >>> capture_stop(io.StringIO("{}"))          # no transcript: nothing to do

See Also:
    - ``openbrain.apps.hooks.session`` - the capability this calls
    - ``openbrain.apps.capture.deliver`` - the spine underneath it
"""

from __future__ import annotations

import asyncio
import sys
from typing import TYPE_CHECKING

from loguru import logger

from openbrain.apps.hooks.session import StopHook, run_stop
from openbrain.config import load_settings

if TYPE_CHECKING:
    from typing import TextIO

    from openbrain.config import CaptureSettings


def capture_stop(stream: TextIO) -> None:
    """Read one ``Stop`` payload from ``stream`` and deliver it, swallowing all.

    Args:
        stream: The hook's stdin. Read whole; a ``Stop`` payload is one JSON
            object.

    Loads the ``capture`` settings itself. The signature takes the stream rather
    than reading ``sys.stdin`` directly so a test drives it with an in-memory
    buffer and no monkeypatching. Every exception is caught -- the entrypoint's
    whole contract is that a capture failure is invisible to the session.
    """
    capture_stop_with(stream, None)


def capture_stop_with(stream: TextIO, settings: CaptureSettings | None) -> None:
    """Deliver one ``Stop`` payload with a given (or loaded) capture config.

    Args:
        stream: The hook's stdin.
        settings: The ``capture`` configuration, or ``None`` to load it. Injected
            so a test exercises the swallow with an explicit config -- e.g. an
            unconfigured one -- without reaching ``load_settings`` and the whole
            environment behind it.

    The swallow lives here so BOTH entrypoints and tests get it: any failure,
    including a missing config or an unreachable lane, is logged and eaten.
    """
    try:
        raw = stream.read()
        payload = StopHook.model_validate_json(raw)
        capture = settings if settings is not None else _loaded_capture()
        asyncio.run(run_stop(payload, capture))
    except Exception:  # noqa: BLE001 -- an observer must never break its subject
        # No content on this line: a failing capture path can hold transcript
        # text or a token in the exception, and this log is not the place for
        # either. The class and traceback are enough to find the fault.
        logger.opt(exception=True).warning("Stop capture failed; turn left for retry")


def _loaded_capture() -> CaptureSettings:
    """The ``capture`` section from a full settings load, without touching sinks."""
    return load_settings(configure_logging=False).capture


def main(stream: TextIO | None = None) -> int:
    """Run the ``Stop`` capture over stdin and always report success.

    Args:
        stream: The hook's stdin. Defaults to ``sys.stdin``; the argument keeps
            the signature uniform with the stub entrypoints so ``dispatch`` can
            hold one table of them.

    Returns:
        ``0``, unconditionally. The return value is the exit code, and a hook
        that observes a session may never fail it.
    """
    capture_stop(sys.stdin if stream is None else stream)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
