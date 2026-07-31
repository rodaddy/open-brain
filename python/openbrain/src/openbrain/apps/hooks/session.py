"""Build the raw-lane client from settings and run one capture delivery.

Purpose:
    The capability the ``stop`` entrypoint calls. It turns a parsed ``Stop``
    payload plus the settings keystone into a delivered batch: construct the
    ``openbrain_memory`` client, start its session, and hand off to the spine.

Architecture:
    This is where the sibling package is CONSTRUCTED, which the spine
    (``apps.capture.deliver``) deliberately does not do -- its docstring names
    that the entrypoint's job. It lives in its own module rather than in
    ``stop`` so the wiring is testable without a subprocess and so the
    entrypoint stays a parse-and-exit shell with no business logic
    (``_plans/418-prov-9-hook-entrypoints.md``).

    ``openbrain_memory`` is imported inside the factory, not at module top. A
    hook's cost is paid on every turn against a 5-second deadline, and the
    client's import graph is not needed to parse a payload that carries no
    transcript, nor by the injected-lane tests that never build the real client.
    It is a declared dependency (``pyproject.toml``); the lazy import is about
    when the cost is paid, not whether the package is present.

Pattern/Convention:
    NOTHING HERE BOUNDS CONTENT, retries, or times out. Durability is the
    sibling package's spool (``openbrain_memory.spool``); order is the spine's
    watermark rule. This module only composes the two, so a change that reaches
    for a queue or a batch cap belongs to one of those owners, not here.

    This factory transmits NO namespace. The client emits ``X-Namespace`` only
    when built with ``delegate_namespace=True`` (default off), and it passes no
    per-call namespace, so the server writes to the token's own namespace
    (``src/tools/ingest-raw-turn.ts``: ``args.namespace ?? auth.clientId``). A
    ``CaptureSettings.namespace`` field would have been dead config -- declared,
    never sent -- so it is deliberately absent.

Example:
    >>> from openbrain.apps.hooks.session import StopHook
    >>> StopHook.model_fields["transcript_path"].is_required()
    False

See Also:
    - ``openbrain.apps.capture.deliver`` - the spine this runs
    - ``openbrain.config`` - the ``CaptureSettings`` section it reads
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict

from openbrain.apps.capture.deliver import Delivery, RawLane, deliver_new_turns
from openbrain.apps.capture.watermark import WatermarkStore
from openbrain.config import CaptureSettings, ConfigurationError

if TYPE_CHECKING:
    from collections.abc import Callable

#: The Stop harness deadline, in seconds. NOT a content bound -- this is a TIME
#: budget tied to an EXTERNAL limit: Claude Code kills a Stop hook that has not
#: exited within 5 seconds, and a killed process cannot honour the exit-0
#: contract or log why it died. Content is never bounded (``docs/CODING_
#: STANDARDS.md:160``); this bounds only how long we will wait on the network.
STOP_HOOK_DEADLINE_SECONDS = 5.0

#: Per-request network timeout for the capture client, in seconds. A Stop that
#: reaches the lane makes up to four sequential HTTP calls -- ``initialize``,
#: the initialized notification, ``session_start``, and ``ingest_raw_turn`` --
#: so the worst-case wall time is four of these, and 4 * 1.0 = 4.0 s sits safely
#: under STOP_HOOK_DEADLINE_SECONDS with headroom. Retry is pinned to a single
#: attempt (see ``_started_memory``) precisely so no retryable timeout can double
#: a call and blow that budget. When a call times out, ``ingest_raw_turns``
#: raises, ``deliver_new_turns`` never reaches its watermark advance, and the
#: same turns are re-read next Stop -- the unadvanced watermark is the retry, so
#: a timeout leaves the batch durable-by-replay, never half-delivered.
CAPTURE_REQUEST_TIMEOUT_SECONDS = 1.0


class CaptureNotConfiguredError(ConfigurationError):
    """A ``Stop`` fired but capture has no endpoint or token to send to.

    ``base_url`` and ``token`` are optional on ``CaptureSettings`` so a non-hook
    process loads without them; a hook that actually runs needs both. Raised
    here rather than at settings load, and swallowed by the entrypoint -- an
    unconfigured capture must not break the session it observes, only decline to
    record it.
    """

    def __init__(self, missing: str) -> None:
        """Name which capture coordinates were absent."""
        super().__init__(
            f"capture is not configured: {missing} unset. "
            f"ACTION REQUIRED: set OPENBRAIN_CAPTURE_BASE_URL and "
            f"OPENBRAIN_CAPTURE_TOKEN (or the OPENBRAIN_BASE_URL / "
            f"OPENBRAIN_TOKEN aliases) to the Open Brain service this hook "
            f"writes to."
        )


class StopHook(BaseModel):
    """The fields a ``Stop`` payload carries that capture needs.

    Modelled from the captured fixture (``tests/fixtures/captured_hooks/
    Stop.json``): the transcript to read and the session it belongs to. Both are
    optional here -- a hook can fire before either exists, and that is a
    do-nothing outcome, not a parse failure. ``extra="ignore"`` because the real
    payload carries many more fields (``stop_hook_active``, ``effort``, ...)
    that capture has no interest in.
    """

    model_config = ConfigDict(extra="ignore")

    transcript_path: Path | None = None
    session_id: str | None = None


@dataclass(frozen=True)
class StartedLane:
    """A raw lane with its server session started, and how to release it.

    The spine (``deliver``) needs only :class:`RawLane`, one call. But a real
    lane also holds a SERVER session slot, and the server caps those per worker
    (``DEFAULT_MAX_SESSIONS = 100``, ``src/transport.ts``); leaving one
    allocated on every Stop lets a burst exhaust the cap and get 429s. So the
    factory returns the lane the spine writes through PLUS the closer that frees
    the slot -- keeping ``RawLane`` narrow (it does not gain a ``close``) while
    ``run_stop`` still owns the lifecycle, the same shape as ``start_session``
    being called here rather than named on the write Protocol.

    Attributes:
        lane: The write path handed to :func:`deliver_new_turns`.
        close: Releases the server-side session. A no-op for injected test
            recorders, which hold no slot; the real factory wires it to the
            client's ``close``.
    """

    lane: RawLane
    close: Callable[[], None]


async def run_stop(
    payload: StopHook,
    settings: CaptureSettings,
    *,
    lane_factory: Callable[[CaptureSettings, str], StartedLane] | None = None,
) -> Delivery | None:
    """Deliver the turns written since the watermark for one ``Stop`` payload.

    Args:
        payload: The parsed ``Stop`` hook fields.
        settings: The ``capture`` configuration section: endpoint, token,
            identity, and the watermark store path.
        lane_factory: Builds the :class:`StartedLane` for a session key. Injected
            so tests hand in a recorder; defaults to a real ``openbrain_memory``
            client with its session started.

    Returns:
        The :class:`~openbrain.apps.capture.deliver.Delivery`, or ``None`` when
        the payload named no transcript or no session -- there is nothing to
        read then, and no watermark key to advance.

    Raises:
        Whatever the lane or the reader raises. The ENTRYPOINT swallows these;
        this capability surfaces them so its tests can see a failure and so the
        watermark is left unadvanced (the spine's rule), which is the retry.
    """
    if payload.transcript_path is None or payload.session_id is None:
        return None

    build = lane_factory if lane_factory is not None else _started_memory
    started = build(settings, payload.session_id)
    store = WatermarkStore(settings.watermark_path)

    try:
        return await deliver_new_turns(
            payload.transcript_path, payload.session_id, store, started.lane
        )
    finally:
        # Success or failure, the session slot is released here -- the one place
        # that owns the lane's lifecycle. The closer is content-free and swallows
        # its own transport errors (``openbrain_memory.client.close``), so it
        # cannot itself break the delivery's outcome.
        started.close()


def _started_memory(settings: CaptureSettings, session_key: str) -> StartedLane:
    """Construct a real ``openbrain_memory`` client with its session started.

    The one non-test lane factory. The sibling is imported here rather than at
    module top so its import graph is not paid on a payload that carries no
    transcript, and so the injected-lane tests never trigger it.

    Raises:
        CaptureNotConfiguredError: When no endpoint or token is set. The
            entrypoint swallows it -- an unconfigured hook declines to record,
            it does not fail the session.
    """
    if settings.base_url is None or settings.token is None:
        missing = ", ".join(
            name
            for name, value in (
                ("base_url", settings.base_url),
                ("token", settings.token),
            )
            if value is None
        )
        raise CaptureNotConfiguredError(missing)

    from openbrain_memory.agent import AgentMemory
    from openbrain_memory.client import OpenBrainClient
    from openbrain_memory.policy import RetryPolicy

    client = OpenBrainClient(
        base_url=settings.base_url,
        token=settings.token.get_secret_value(),
        # Never transmitted on this path: the client sends X-Namespace only with
        # delegate_namespace=True (default False), and this factory passes no
        # per-call namespace. The server then writes to the token's own namespace
        # (``src/tools/ingest-raw-turn.ts``: ``args.namespace ?? auth.clientId``).
        # This value is required by the constructor but inert here; agent_id is
        # reused so nothing invents a second identity string.
        namespace=settings.agent_id,
        agent_id=settings.agent_id,
        # The structural time budget: bound every request so the worst-case wall
        # time stays under Claude Code's 5 s Stop deadline, and pin retry to one
        # attempt so a retryable timeout cannot double a call past it. See
        # CAPTURE_REQUEST_TIMEOUT_SECONDS.
        timeout=CAPTURE_REQUEST_TIMEOUT_SECONDS,
        retry_policy=RetryPolicy(attempts=1),
    )
    # Annotated to RawLane, the Protocol the spine needs, which AgentMemory
    # structurally satisfies. start_session is not part of that Protocol -- it is
    # session lifecycle, not the write call -- so calling it here needs the
    # ignore; the narrowing is deliberate, not a cast around a missing type.
    memory: RawLane = AgentMemory(client, agent=settings.agent_id)
    memory.start_session(session_key)  # type: ignore[attr-defined]
    return StartedLane(lane=memory, close=client.close)
