"""The ``PostCompact`` hook entrypoint: record the compaction summary.

Purpose:
    Claude Code runs this after a compaction COMPLETES and hands it the event as
    JSON on stdin, carrying ``trigger`` (``manual``/``auto``) and
    ``compact_summary`` -- the generated summary that replaces the discarded
    context. It reads that payload and records the summary as a raw turn through
    the same client lifecycle ``stop`` uses.

Non-goals:
    This does NOT run the Stop spine, read a transcript, or advance a watermark.
    The summary is a payload field, not a resumable byte stream. It adds no
    namespace logic (token-derived server-side) and owns no durability or retry
    mechanism -- the sibling package does.

Architecture:
    A parse-and-exit shell. Reading stdin, loading settings, and choosing a
    capability is all this module does; the capability that builds the client,
    starts the session, and sends the summary is ``session.run_post_compact``, so
    there is no business logic here (``_plans/418-prov-9-hook-entrypoints.md``).

Pattern/Convention:
    THE ONE SUMMARY THE STOP SPINE DROPS. The compaction summary's transcript
    record carries ``isCompactSummary:true`` and no ``promptSource``, so the
    reader's operator filter returns None (``apps/capture/records.py``) and the
    Stop spine walks past it. ``PostCompact`` is the only place it can be
    recorded (``_plans/rewrite-gotchas.md`` rulings table).

    ALWAYS EXIT 0 WITH EMPTY STDOUT. A hook that observes a session must never
    block or break one. Every failure -- a malformed payload, an unconfigured
    capture, an unreachable server -- is logged content-free and swallowed, the
    same fail-open contract ``stop`` carries. A missed summary is not re-read from
    a watermark; a re-fired ``PostCompact`` de-duplicates server-side on the
    reused ``prompt_id``.

Example:
    >>> import io
    >>> close_compact(io.StringIO("not json"))   # swallowed, no raise
    >>> close_compact(io.StringIO("{}"))          # no summary: nothing to record

See Also:
    - ``openbrain.apps.hooks.session`` - the capability this calls
    - ``_plans/rewrite-gotchas.md`` - the ruling that made this real
    - ``tests/fixtures/captured_hooks/README.md`` - how PostCompact was captured
"""

from __future__ import annotations

import asyncio
import sys
from typing import TYPE_CHECKING

from loguru import logger

from openbrain.apps.hooks.session import PostCompactHook, run_post_compact
from openbrain.config import load_capture_settings

if TYPE_CHECKING:
    from typing import TextIO

    from openbrain.config import CaptureSettings


def record_compact_summary(stream: TextIO) -> None:
    """Read one ``PostCompact`` payload from ``stream`` and record it, swallowing all.

    Args:
        stream: The hook's stdin. Read whole; a ``PostCompact`` payload is one
            JSON object.

    Loads the ``capture`` settings itself. Takes the stream rather than reading
    ``sys.stdin`` directly so a test drives it with an in-memory buffer. Every
    exception is caught -- an observer must never break its subject.
    """
    record_compact_summary_with(stream, None)


def record_compact_summary_with(
    stream: TextIO, settings: CaptureSettings | None
) -> None:
    """Record one ``PostCompact`` payload's summary with a given (or loaded) config.

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
        payload = PostCompactHook.model_validate_json(raw)
        capture = settings if settings is not None else load_capture_settings()
        asyncio.run(run_post_compact(payload, capture))
    except Exception as error:  # noqa: BLE001 -- an observer must never break its subject
        # Content-free BY CONSTRUCTION: only the exception class name is passed,
        # never the exception object, so no summary text or token reaches the
        # sink even under loguru's diagnose (see ``stop.capture_stop_with``).
        logger.warning(
            "PostCompact record failed ({}); summary not stored",
            type(error).__name__,
        )


def main(stream: TextIO | None = None) -> int:
    """Run the ``PostCompact`` record over stdin and always report success.

    Args:
        stream: The hook's stdin. Defaults to ``sys.stdin``; the argument keeps
            the signature uniform with the other entrypoints so ``dispatch``
            holds one table of them.

    Returns:
        ``0``, unconditionally. The return value is the exit code, and a hook
        that observes a session may never fail it.
    """
    record_compact_summary(sys.stdin if stream is None else stream)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
