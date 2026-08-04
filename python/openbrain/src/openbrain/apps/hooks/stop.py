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
    configured sinks and swallowed. Nothing is re-raised to the exit code.
    Empty stdout with exit 0 is Claude Code's "proceed normally", proven against
    captured runs (``tests/fixtures/captured_hooks/README.md``).

    THE OUTAGE NOTICE GOES TO STDERR, AND THAT IS WHY. The operator's ruling on
    the fail-open split is "both are fail" (#536): when Open Brain is
    unreachable the session keeps working, but the failure is REPORTED rather
    than silent. Stdout is not available to carry it -- for this hook stdout is
    the verdict channel and empty is the verdict, so one line there is a
    corrupted response, not a message (``openbrain_provider.hook_io``: "STDOUT
    IS THE RETURN CHANNEL", "AN ALLOW IS SILENCE"). Stderr is the surface that
    remains, it is shown to the operator, and it cannot change the verdict. The
    sibling ``openbrain-context-budget-gate --event stop`` runs in the same Stop
    chain and DOES own a stdout banner; this hook does not, and adding one here
    would put two writers on one channel.

    THE NOTICE IS A STATE CHANGE, NOT AN EVENT. One line when an outage begins,
    one when it ends, and nothing on the Stops in between -- the operator
    explicitly forbade per-call nagging. The latch that makes that true across
    hook PROCESSES is ``apps.capture.outage.OutageLatch``; failing to write it
    degrades to silence, never to a nag on every turn.

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
    - ``openbrain.apps.capture.outage`` - the once-per-outage latch and wording
"""

from __future__ import annotations

import asyncio
import sys
from typing import TYPE_CHECKING

from loguru import logger

from openbrain.apps.capture.outage import (
    OutageLatch,
    default_spool_path,
    spool_notice,
    spool_pending,
)
from openbrain.apps.hooks.session import StopHook, run_stop
from openbrain.config import load_capture_settings, load_observation_settings

if TYPE_CHECKING:
    from typing import TextIO

    from openbrain.config import CaptureSettings, ObservationSettings


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


def capture_stop_with(
    stream: TextIO,
    settings: CaptureSettings | None,
    *,
    notices: TextIO | None = None,
) -> None:
    """Deliver one ``Stop`` payload with a given (or loaded) capture config.

    Args:
        stream: The hook's stdin.
        settings: The ``capture`` configuration, or ``None`` to load it. Injected
            so a test exercises the swallow with an explicit config -- e.g. an
            unconfigured one -- without reaching ``load_settings`` and the whole
            environment behind it.
        notices: Where an outage or recovery notice is written. Defaults to
            ``sys.stderr``; injected so a test reads the line out of a buffer
            instead of capturing the process's own stderr. NOT stdout, which is
            this hook's verdict channel -- see the module docstring.

    The swallow lives here so BOTH entrypoints and tests get it: any failure,
    including a missing config or an unreachable lane, is logged and eaten. A
    delivery that RAISED or RETURNED is latched, so the next Stop knows whether
    this session is already degraded and can stay quiet; a delivery that never
    ran is not, because it proves nothing about reachability either way.
    """
    session_key: str | None = None
    capture: CaptureSettings | None = None
    try:
        raw = stream.read()
        payload = StopHook.model_validate_json(raw)
        capture = settings if settings is not None else _loaded_capture()
        session_key = payload.session_id
        delivery = asyncio.run(
            run_stop(payload, capture, observation=loaded_observation())
        )
    except Exception as error:  # noqa: BLE001 -- an observer must never break its subject
        # Content-free BY CONSTRUCTION, not by handler config. The exception can
        # hold transcript text or a token -- a pydantic ValidationError carries
        # its `input_value`, which for a malformed Stop payload IS the hook's raw
        # stdin. `logger.opt(exception=True)` renders that through loguru's
        # diagnose, whose DEFAULT is on for the stderr handler a hook logs to.
        # So only the class name is passed, and no exception object reaches the
        # sink: there are no locals to render, whatever any handler is set to.
        logger.warning(
            "Stop capture failed ({}); turn left for retry", type(error).__name__
        )
        announce_outage_state(session_key, capture, delivered=False, notices=notices)
    else:
        # ``None`` means the payload named no transcript or no session, so NO
        # delivery was attempted and the service was never dialed. That is not
        # evidence of health, and latching it as one would print a false
        # all-clear in the middle of a live outage -- measured before the guard
        # existed: a transcript-less Stop announced recovery while the brain was
        # still down. Only a delivery that RETURNED proves reachability.
        if delivery is not None:
            announce_outage_state(
                session_key, capture, delivered=True, notices=notices
            )


def announce_outage_state(
    session_key: str | None,
    settings: CaptureSettings | None,
    *,
    delivered: bool,
    notices: TextIO | None,
) -> None:
    """Latch this Stop's outcome and print a line only when the state CHANGED.

    Args:
        session_key: The session whose health this is, or ``None`` when the
            payload never parsed far enough to name one.
        settings: The resolved capture config, or ``None`` when it never loaded.
        delivered: Whether the delivery returned.
        notices: The notice stream, or ``None`` for ``sys.stderr``.

    Silent when there is no session or no config to key the latch by: a payload
    that did not parse is a defect in the harness's message, not evidence about
    Open Brain's reachability, and announcing an outage from one would be a
    false alarm on every malformed Stop.

    Wrapped in its own swallow. This function exists to REPORT a failure; it
    must not be able to cause one, so a notice that cannot be latched or written
    is dropped exactly like the receipt in ``apps.hooks.receipts`` is.
    """
    if session_key is None or settings is None:
        return
    try:
        latch = OutageLatch(settings.watermark_path)
        notice = asyncio.run(
            latch.note_delivered(session_key)
            if delivered
            else latch.note_spooled(session_key)
        )
        if notice is None:
            return
        # Only read the spool once there is genuinely a line to print, so the
        # ordinary healthy Stop never pays the stat/read at all.
        line = spool_notice(notice, spool_pending(default_spool_path()))
        target = sys.stderr if notices is None else notices
        target.write(f"{line}\n")
        target.flush()
    except Exception as error:  # noqa: BLE001 -- a notice never breaks a turn
        # Class name only, this module's content-free convention.
        logger.warning(
            "capture outage notice not emitted ({})", type(error).__name__
        )


def _loaded_capture() -> CaptureSettings:
    """The ``capture`` section, resolved without the DB/embedding sections.

    ``load_capture_settings`` builds only :class:`CaptureSettings`; the full
    ``load_settings`` would require ``OPENBRAIN_DB_HOST`` and the embedding
    endpoint, which a hook process does not set -- and that validation failure,
    swallowed here, is a silent zero capture on every ``Stop``.
    """
    return load_capture_settings()


def loaded_observation() -> ObservationSettings | None:
    """The ``observation`` section (#523), or ``None`` when it cannot load.

    Swallowed SEPARATELY from the outer catch, and that is the point: the
    observation sink is best-effort, so a malformed observation variable must
    degrade to "observe nothing" rather than ride the shared exception path
    and take the memory capture down with it.
    """
    try:
        return load_observation_settings()
    except Exception as error:  # noqa: BLE001 -- observation never breaks capture
        # Class name only, the entrypoint's content-free convention.
        logger.warning(
            "observation settings unreadable ({}); observing nothing",
            type(error).__name__,
        )
        return None


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
