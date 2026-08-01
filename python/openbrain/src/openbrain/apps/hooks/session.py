"""Build the raw-lane client from settings and run the lifecycle capabilities.

Purpose:
    The capabilities the ``stop``, ``subagent_stop``, and ``session_end``
    entrypoints call. Each turns a parsed hook payload plus the settings
    keystone into an action against the same ``openbrain_memory`` client that
    this module constructs and starts: ``run_stop`` delivers the main
    transcript's new turns, ``run_subagent_stop`` delivers a subagent
    transcript's new turns under its own watermark key, and ``run_session_end``
    starts and closes a session to release the server slot without delivering.
    All three share one factory (``_started_memory``) so the client, its
    session lifecycle, and the close are wired in exactly one place.

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

from collections.abc import Callable
from pathlib import Path

from pydantic import BaseModel, ConfigDict, SkipValidation

from openbrain.apps.capture.deliver import Delivery, RawLane, deliver_new_turns
from openbrain.apps.capture.watermark import WatermarkStore
from openbrain.config import CaptureSettings, ConfigurationError

#: The Stop harness deadline, in seconds. NOT a content bound -- this is a TIME
#: budget tied to an EXTERNAL limit: Claude Code kills a Stop hook that has not
#: exited within 5 seconds, and a killed process cannot honour the exit-0
#: contract or log why it died. Content is never bounded (``docs/CODING_
#: STANDARDS.md:160``); this bounds only how long we will wait on the network.
STOP_HOOK_DEADLINE_SECONDS = 5.0

#: The number of sequential HTTP requests one live Stop capture makes, counted
#: so the per-request timeout below is derived from the WHOLE lifecycle, not a
#: single call. The full path is FIVE round trips, in order:
#:
#:   1. ``initialize``               (client ``_ensure_session`` on first tool call)
#:   2. ``notifications/initialized`` (same ``_ensure_session``)
#:   3. ``session_start``            (``AgentMemory.start_session`` in the factory)
#:   4. ``ingest_raw_turn``          (the spine's one write through the lane)
#:   5. ``DELETE`` on ``mcp``        (``client.close`` in ``run_stop``'s finally)
#:
#: An earlier count said four and missed the ``DELETE``: ``close`` is called on
#: every path, so the slot-release round trip is part of the worst-case wall
#: time and MUST be in the budget. The prior 4 * 1.0 = 4.0 s arithmetic was
#: therefore wrong twice over -- five requests, not four, and at 1.0 s each that
#: is 5 * 1.0 = 5.0 s, which equals the whole deadline before a single byte of
#: process startup, imports, or the SQLite watermark is paid.
CAPTURE_LIFECYCLE_REQUESTS = 5

#: A conservative reserve, in seconds, for everything that is NOT a network wait:
#: interpreter start, the sibling ``openbrain_memory`` import graph, and the
#: SQLite watermark read. Measured cold on 2026-07-31 at ~0.12-0.16 s for a
#: direct subprocess doing all imports plus the watermark open; 0.5 s is that
#: rounded up several-fold so a slow first run or a cold disk still fits.
CAPTURE_PROCESS_OVERHEAD_SECONDS = 0.5

#: Per-request network timeout for the capture client, in seconds. Derived, not
#: guessed: the five-request lifecycle plus the process-overhead reserve must sit
#: under STOP_HOOK_DEADLINE_SECONDS with real headroom, so
#:
#:   CAPTURE_LIFECYCLE_REQUESTS * timeout + CAPTURE_PROCESS_OVERHEAD_SECONDS
#:       = 5 * 0.7 + 0.5 = 4.0 s  <  5.0 s  (STOP_HOOK_DEADLINE_SECONDS)
#:
#: leaving a full 1.0 s of headroom for scheduling jitter. Retry is pinned to a
#: SINGLE attempt on BOTH the client and ``AgentMemory`` (see ``_started_memory``)
#: precisely so no retryable 429/5xx can add a second call, and a single attempt
#: also means ``with_retry`` never sleeps -- it re-raises on the first failure,
#: so a ``Retry-After`` header can never park the process past this budget. When
#: a call times out, ``ingest_raw_turns`` raises, ``deliver_new_turns`` never
#: reaches its watermark advance, and the same turns are re-read next Stop -- the
#: unadvanced watermark is the retry, so a timeout leaves the batch
#: durable-by-replay, never half-delivered.
CAPTURE_REQUEST_TIMEOUT_SECONDS = 0.7

# The derivation is enforced, not just documented: if a later edit widens the
# per-request timeout or the request count past what the deadline allows, this
# fails at import time rather than in production against the harness's kill.
assert (
    CAPTURE_LIFECYCLE_REQUESTS * CAPTURE_REQUEST_TIMEOUT_SECONDS
    + CAPTURE_PROCESS_OVERHEAD_SECONDS
    < STOP_HOOK_DEADLINE_SECONDS
), "capture lifecycle budget must fit under the Stop deadline with headroom"


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


class SubagentStopHook(BaseModel):
    """The fields a ``SubagentStop`` payload carries that capture needs.

    Modelled from the captured fixture (``tests/fixtures/captured_hooks/
    SubagentStop.json``). A subagent carries its OWN transcript
    (``agent_transcript_path``) and its own ``agent_id`` under the parent's
    ``session_id``; the spine reads that transcript against a watermark keyed to
    that subagent, exactly as ``Stop`` does for the main one. All are optional --
    a hook can fire before a field exists, which is a do-nothing outcome, not a
    parse failure -- and ``extra="ignore"`` drops the payload's many other fields
    (``agent_type``, ``last_assistant_message``, ...) capture has no use for.
    """

    model_config = ConfigDict(extra="ignore")

    agent_transcript_path: Path | None = None
    agent_id: str | None = None
    session_id: str | None = None

    def watermark_key(self) -> str | None:
        """The per-subagent watermark key: parent session plus subagent id.

        A subagent's transcript is its own byte stream, so it needs its own read
        position -- never the parent ``session_id``'s, which the main ``Stop``
        owns. ``session_id:agent_id`` is unique per subagent and stable across
        that subagent's repeated Stops, so a missed hook self-heals on the next
        one exactly as the main path does. ``None`` when either half is absent:
        there is no transcript to resume then, so there is nothing to key.
        """
        if self.session_id is None or self.agent_id is None:
            return None
        return f"{self.session_id}:{self.agent_id}"


class SessionEndHook(BaseModel):
    """The fields a ``SessionEnd`` payload carries that the close needs.

    Modelled from the captured fixture (``tests/fixtures/captured_hooks/
    SessionEnd.json``). Only ``session_id`` matters: it is the key the client's
    session lifecycle is started under so the closing ``DELETE`` releases the
    right server slot. Optional -- a hook can fire with no session, which is a
    do-nothing outcome -- and ``extra="ignore"`` drops ``reason``, ``cwd``, and
    the rest.
    """

    model_config = ConfigDict(extra="ignore")

    session_id: str | None = None


class StartedLane(BaseModel):
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

    # This model is a CARRIER: it moves two already-constructed, already-typed
    # objects from the factory to the spine, not a boundary that parses untrusted
    # input, so there is nothing for pydantic to validate at construction.
    #
    # ``lane`` is a :class:`RawLane`, a bare (non-runtime_checkable) ``Protocol``.
    # pydantic cannot build an isinstance validator for one -- with a plain field
    # it raises ``SchemaError: 'cls' must be valid as the first argument to
    # 'isinstance'`` at class-definition time. Two settings together make it hold
    # the value untouched: ``arbitrary_types_allowed`` lets pydantic accept a type
    # it cannot coerce, and :data:`~pydantic.SkipValidation` drops the isinstance
    # check it would otherwise emit for such a type. The declared type stays
    # ``RawLane``, so mypy and readers still see the exact contract. ``close`` is a
    # plain ``Callable``, which pydantic validates natively, so it needs no wrapper.
    #
    # ``frozen`` preserves the immutability the replaced ``@dataclass(frozen=True)``
    # gave, satisfying the No-bare-dataclasses LAW without a behaviour change.
    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    lane: SkipValidation[RawLane]
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


async def run_subagent_stop(
    payload: SubagentStopHook,
    settings: CaptureSettings,
    *,
    lane_factory: Callable[[CaptureSettings, str], StartedLane] | None = None,
) -> Delivery | None:
    """Deliver the subagent's unread turns, keyed to its own transcript.

    Args:
        payload: The parsed ``SubagentStop`` hook fields.
        settings: The ``capture`` configuration section.
        lane_factory: Builds the :class:`StartedLane`; injected for tests,
            defaults to the real ``openbrain_memory`` client.

    Returns:
        The :class:`~openbrain.apps.capture.deliver.Delivery`, or ``None`` when
        the payload named no subagent transcript or no watermark key.

    This is the SAME spine as :func:`run_stop`, run against
    ``agent_transcript_path`` under a per-subagent watermark key
    (:meth:`SubagentStopHook.watermark_key`) instead of the main transcript and
    session. It adds no lane, no namespace, and no ordering rule of its own: it
    maps the subagent fields onto a :class:`StopHook` and defers entirely to
    ``run_stop``, so the watermark, the close, and the "advance only after the
    lane returns" rule are inherited unchanged. Namespace stays token-derived
    server-side (``src/tools/ingest-raw-turn.ts``); nothing here sets one.
    """
    key = payload.watermark_key()
    if payload.agent_transcript_path is None or key is None:
        return None
    return await run_stop(
        StopHook(transcript_path=payload.agent_transcript_path, session_id=key),
        settings,
        lane_factory=lane_factory,
    )


async def run_session_end(
    payload: SessionEndHook,
    settings: CaptureSettings,
    *,
    lane_factory: Callable[[CaptureSettings, str], StartedLane] | None = None,
) -> bool:
    """Release the server session slot for one ``SessionEnd`` payload.

    Args:
        payload: The parsed ``SessionEnd`` hook fields.
        settings: The ``capture`` configuration section.
        lane_factory: Builds the :class:`StartedLane`; injected for tests,
            defaults to the real ``openbrain_memory`` client.

    Returns:
        ``True`` when a session was started and then closed, ``False`` when the
        payload named no session -- there is no slot to release then.

    There is NO delivery here: capture already made every turn durable on each
    ``Stop`` (``docs/decisions/capture-never-drops-a-turn.md``), so ``SessionEnd``
    only frees the finite per-worker server slot the session held
    (``DEFAULT_MAX_SESSIONS``, ``src/transport.ts``). It reuses the exact
    lifecycle ``run_stop`` owns -- the same factory builds the client, starts the
    session under ``session_id``, and returns the closer -- then closes it in a
    ``finally`` without ever writing. Reusing the factory is deliberate: the
    close only reaches the server slot the ``initialize``/``start_session`` legs
    allocated, so the session must be started before it can be closed.

    Raises:
        Whatever the factory raises (e.g. :class:`CaptureNotConfiguredError`).
        The ENTRYPOINT swallows these; a failed close leaks nothing this process
        can lose -- the slot ages out server-side -- and must never break the
        session it is ending.
    """
    if payload.session_id is None:
        return False
    build = lane_factory if lane_factory is not None else _started_memory
    started = build(settings, payload.session_id)
    started.close()
    return True


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

    # One attempt, everywhere. The client and AgentMemory each carry their OWN
    # retry policy: the client retries session INITIALIZE (initialize + the
    # initialized notification), AgentMemory retries session_START. Pinning only
    # the client would leave AgentMemory on the sibling default of two attempts,
    # so a single 429 on session_start would independently fire a second call --
    # measured by the reviewer -- and blow the five-request budget. The same
    # single attempt is what stops ``with_retry`` from ever sleeping, so a
    # ``Retry-After`` header can never hold the process past the deadline.
    single_attempt = RetryPolicy(attempts=1)

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
        # attempt so a retryable 429/5xx cannot double a call past it. See
        # CAPTURE_REQUEST_TIMEOUT_SECONDS.
        timeout=CAPTURE_REQUEST_TIMEOUT_SECONDS,
        retry_policy=single_attempt,
    )
    # Annotated to RawLane, the Protocol the spine needs, which AgentMemory
    # structurally satisfies. start_session is not part of that Protocol -- it is
    # session lifecycle, not the write call -- so calling it here needs the
    # ignore; the narrowing is deliberate, not a cast around a missing type.
    memory: RawLane = AgentMemory(
        client, agent=settings.agent_id, retry_policy=single_attempt
    )
    # start_session allocates the SERVER session (initialize opens the slot). If
    # it then RAISES -- a 429 on session_start, a timeout -- the slot is already
    # held, and this factory has not yet returned the StartedLane whose ``close``
    # run_stop's finally relies on. So the cleanup owner does not exist yet, and
    # without this the slot would leak on the startup path -- the exact leak the
    # close() fix closed on the delivery path, reopened one step earlier. Close
    # the client and re-raise; ``close`` is content-free and swallows its own
    # transport errors, so it cannot mask the original failure.
    try:
        memory.start_session(session_key)  # type: ignore[attr-defined]
    except BaseException:
        client.close()
        raise
    return StartedLane(lane=memory, close=client.close)
