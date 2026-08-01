"""The ``SessionEnd`` hook entrypoint: release the server session slot.

Purpose:
    Claude Code runs this on ``SessionEnd`` and hands it the event as JSON on
    stdin. It reads that payload and closes the session through the same client
    lifecycle ``stop`` uses, freeing the finite per-worker server session slot
    (``DEFAULT_MAX_SESSIONS``, ``src/transport.ts``) that the session held.

Non-goals:
    This does NOT deliver turns, flush a watermark, or capture the session's end
    reason. Capture already made every turn durable on each ``Stop``
    (``docs/decisions/capture-never-drops-a-turn.md``); releasing the slot is the
    whole capability here. It adds no namespace logic (token-derived server-side)
    and owns no durability or retry mechanism -- the sibling package does.

Architecture:
    A parse-and-exit shell. Reading stdin, loading settings, and choosing a
    capability is all this module does; the capability that builds the client,
    starts the session, and closes it is ``session.run_session_end``, so there is
    no business logic here (``_plans/418-prov-9-hook-entrypoints.md``).

Pattern/Convention:
    ALWAYS EXIT 0 WITH EMPTY STDOUT. A hook that observes a session must never
    block or break one. Every failure -- a malformed payload, an unconfigured
    capture, an unreachable server -- is logged content-free and swallowed, the
    same fail-open contract ``stop`` carries. An unreleased slot ages out
    server-side; a crashed hook does not.

Example:
    >>> import io
    >>> close_session(io.StringIO("not json"))   # swallowed, no raise
    >>> close_session(io.StringIO("{}"))          # no session: nothing to close

See Also:
    - ``openbrain.apps.hooks.session`` - the capability this calls
    - ``_plans/rewrite-gotchas.md`` - the ruling that made this real
"""

from __future__ import annotations

import asyncio
import sys
from typing import TYPE_CHECKING

from loguru import logger

from openbrain.apps.hooks.session import SessionEndHook, run_session_end
from openbrain.config import load_capture_settings

if TYPE_CHECKING:
    from typing import TextIO

    from openbrain.config import CaptureSettings


def close_session(stream: TextIO) -> None:
    """Read one ``SessionEnd`` payload from ``stream`` and close it, swallowing all.

    Args:
        stream: The hook's stdin. Read whole; a ``SessionEnd`` payload is one
            JSON object.

    Loads the ``capture`` settings itself. Takes the stream rather than reading
    ``sys.stdin`` directly so a test drives it with an in-memory buffer. Every
    exception is caught -- an observer must never break its subject.
    """
    close_session_with(stream, None)


def close_session_with(stream: TextIO, settings: CaptureSettings | None) -> None:
    """Close one ``SessionEnd`` payload's session with a given (or loaded) config.

    Args:
        stream: The hook's stdin.
        settings: The ``capture`` configuration, or ``None`` to load it. Injected
            so a test exercises the swallow with an explicit config -- e.g. an
            unconfigured one -- without reaching ``load_settings``.

    The swallow lives here so BOTH the entrypoint and tests get it: any failure,
    including a missing config or an unreachable server, is logged and eaten.
    """
    try:
        raw = stream.read()
        payload = SessionEndHook.model_validate_json(raw)
        capture = settings if settings is not None else load_capture_settings()
        asyncio.run(run_session_end(payload, capture))
    except Exception as error:  # noqa: BLE001 -- an observer must never break its subject
        # Content-free BY CONSTRUCTION: only the exception class name is passed,
        # never the exception object, so no payload text or token reaches the
        # sink even under loguru's diagnose (see ``stop.capture_stop_with``).
        logger.warning(
            "SessionEnd close failed ({}); server slot left to age out",
            type(error).__name__,
        )


def main(stream: TextIO | None = None) -> int:
    """Run the ``SessionEnd`` close over stdin and always report success.

    Args:
        stream: The hook's stdin. Defaults to ``sys.stdin``; the argument keeps
            the signature uniform with the other entrypoints so ``dispatch``
            holds one table of them.

    Returns:
        ``0``, unconditionally. The return value is the exit code, and a hook
        that observes a session may never fail it.
    """
    close_session(sys.stdin if stream is None else stream)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
