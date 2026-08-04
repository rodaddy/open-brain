"""The ``SubagentStop`` hook entrypoint: capture the subagent's finished turns.

Purpose:
    Claude Code runs this when a spawned ``Task`` subagent stops and hands it the
    event as JSON on stdin, carrying the subagent's own ``agent_transcript_path``
    and ``agent_id``. It reads that payload and runs the SAME capture spine
    ``stop`` runs -- against the subagent transcript, under a per-subagent
    watermark -- then exits.

Non-goals:
    This adds NO namespace logic: namespace is token-derived server-side
    (``src/tools/ingest-raw-turn.ts``), so subagent turns land in the same
    token's namespace as the main ones, no lane of their own. It owns no
    durability, retry, or ordering mechanism -- those belong to the spine and the
    sibling package.

Architecture:
    A parse-and-exit shell. Reading stdin, loading settings, and choosing a
    capability is all this module does; the capability that maps the subagent
    fields onto the spine and runs the delivery is
    ``session.run_subagent_stop``, so there is no business logic here
    (``_plans/418-prov-9-hook-entrypoints.md``).

Pattern/Convention:
    ALWAYS EXIT 0 WITH EMPTY STDOUT. A hook that observes a session must never
    block or break one. Every failure is logged content-free and swallowed, the
    same fail-open contract ``stop`` carries. A failed send leaves the subagent
    watermark unadvanced, so the next ``SubagentStop`` re-reads the same turns --
    that is the retry.

    THE OUTAGE NOTICE IS LATCHED UNDER THE PARENT SESSION, not the subagent.
    An unreachable brain is ONE condition, not one per lane: the delivery here
    and the parent's ``Stop`` delivery fail together and recover together, so
    latching each separately would announce the same outage twice and then
    announce the same recovery twice. The subagent's turns still get their OWN
    watermark key (that is durability, and it is per transcript); only the
    "has anyone been told yet" flag is shared. Notice text and surface are
    ``stop``'s (#536) -- stderr, state-change only.

Example:
    >>> import io
    >>> capture_subagent_stop(io.StringIO("not json"))   # swallowed, no raise
    >>> capture_subagent_stop(io.StringIO("{}"))          # no transcript: no-op

See Also:
    - ``openbrain.apps.hooks.session`` - the capability this calls
    - ``openbrain.apps.capture.deliver`` - the spine underneath it
    - ``_plans/rewrite-gotchas.md`` - the ruling that made this real
"""

from __future__ import annotations

import asyncio
import sys
from typing import TYPE_CHECKING

from loguru import logger

from openbrain.apps.hooks.session import SubagentStopHook, run_subagent_stop

# ``announce_outage_state`` is imported rather than reimplemented: both
# entrypoints must print the same words on the same stream under the same
# latch, and two copies of that is how they drift into announcing one outage
# twice with two different wordings.
from openbrain.apps.hooks.stop import announce_outage_state, loaded_observation
from openbrain.config import load_capture_settings

if TYPE_CHECKING:
    from typing import TextIO

    from openbrain.config import CaptureSettings


def capture_subagent_stop(stream: TextIO) -> None:
    """Read one ``SubagentStop`` payload from ``stream`` and deliver it, swallowing all.

    Args:
        stream: The hook's stdin. Read whole; a ``SubagentStop`` payload is one
            JSON object.

    Loads the ``capture`` settings itself. Takes the stream rather than reading
    ``sys.stdin`` directly so a test drives it with an in-memory buffer. Every
    exception is caught -- an observer must never break its subject.
    """
    capture_subagent_stop_with(stream, None)


def capture_subagent_stop_with(
    stream: TextIO,
    settings: CaptureSettings | None,
    *,
    notices: TextIO | None = None,
) -> None:
    """Deliver one ``SubagentStop`` payload with a given (or loaded) capture config.

    Args:
        stream: The hook's stdin.
        settings: The ``capture`` configuration, or ``None`` to load it. Injected
            so a test exercises the swallow with an explicit config -- e.g. an
            unconfigured one -- without reaching ``load_settings``.
        notices: Where an outage or recovery notice is written. Defaults to
            ``sys.stderr``; injected for tests, exactly as ``stop`` takes it.

    The swallow lives here so BOTH the entrypoint and tests get it: any failure,
    including a missing config or an unreachable lane, is logged and eaten.
    """
    session_key: str | None = None
    capture: CaptureSettings | None = None
    try:
        raw = stream.read()
        payload = SubagentStopHook.model_validate_json(raw)
        capture = settings if settings is not None else load_capture_settings()
        # The PARENT session id, never ``watermark_key()``. The watermark key is
        # per subagent because durability is per transcript; the latch is per
        # session because the outage is.
        session_key = payload.session_id
        delivery = asyncio.run(
            run_subagent_stop(
                payload, capture, observation=loaded_observation()
            )
        )
    except Exception as error:  # noqa: BLE001 -- an observer must never break its subject
        # Content-free BY CONSTRUCTION: only the exception class name is passed,
        # never the exception object, so no transcript text or token reaches the
        # sink even under loguru's diagnose (see ``stop.capture_stop_with``).
        logger.warning(
            "SubagentStop capture failed ({}); turns left for retry",
            type(error).__name__,
        )
        announce_outage_state(session_key, capture, delivered=False, notices=notices)
    else:
        # ``None`` means no subagent transcript or no watermark key, so nothing
        # was dialed and health is unknown. See ``stop.capture_stop_with`` for
        # why a no-op must not present as recovery.
        if delivery is not None:
            announce_outage_state(
                session_key, capture, delivered=True, notices=notices
            )


def main(stream: TextIO | None = None) -> int:
    """Run the ``SubagentStop`` capture over stdin and always report success.

    Args:
        stream: The hook's stdin. Defaults to ``sys.stdin``; the argument keeps
            the signature uniform with the other entrypoints so ``dispatch``
            holds one table of them.

    Returns:
        ``0``, unconditionally. The return value is the exit code, and a hook
        that observes a session may never fail it.
    """
    capture_subagent_stop(sys.stdin if stream is None else stream)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
