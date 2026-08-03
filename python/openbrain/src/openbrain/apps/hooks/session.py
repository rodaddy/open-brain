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

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, SkipValidation

from openbrain.apps.capture.deliver import Delivery, RawLane, deliver_new_turns
from openbrain.apps.capture.watermark import WatermarkStore
from openbrain.apps.hooks.receipts import (
    note_capture,
    note_compaction,
    note_verified_recall_for_current_cycle,
)
from openbrain.config import CanonSettings, CaptureSettings, ConfigurationError
from openbrain.models.turn import RawTurn, TurnRole

#: The ``SessionStart`` ``source`` value that means "a compaction just finished".
#:
#: The one start that is a post-compaction read-back. A ``startup``, ``resume``,
#: ``clear``, or ``fork`` start reads canon too, but it is not what the
#: context-budget gate armed its block against, and recording a ``compact`` recall
#: receipt for one would clear a block a real compaction had every right to hold.
#: Observed on the captured ``compact`` variant of the fixture, which carries
#: ``prompt_id`` and ``model`` the ``startup`` variant lacks
#: (``tests/fixtures/captured_hooks/README.md``).
COMPACT_SESSION_SOURCE = "compact"

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


class CanonNotConfiguredError(ConfigurationError):
    """A ``SessionStart`` fired but canon has no endpoint or token to read from.

    ``base_url`` and ``token`` are optional on ``CanonSettings`` so a non-hook
    process loads without them; a session-start hook that actually injects needs
    both. Raised here rather than at settings load, and swallowed by the
    entrypoint -- an unconfigured canon must not break the session it opens, only
    decline to inject.
    """

    def __init__(self, missing: str) -> None:
        """Name which canon coordinates were absent."""
        super().__init__(
            f"canon is not configured: {missing} unset. "
            f"ACTION REQUIRED: set OPENBRAIN_CANON_BASE_URL and "
            f"OPENBRAIN_CANON_TOKEN (or the OPENBRAIN_BASE_URL / "
            f"OPENBRAIN_TOKEN aliases) to the Open Brain service this hook "
            f"reads canon from."
        )


class SessionStartHook(BaseModel):
    """The fields a ``SessionStart`` payload carries that canon injection needs.

    Modelled from the captured fixture (``tests/fixtures/captured_hooks/
    SessionStart.json``): ``source`` is the trigger
    (``startup``/``resume``/``clear``/``compact``/``fork``) and ``session_id``
    keys the server session the pack is read under. Both optional -- a hook can
    fire before either exists, a do-nothing-special outcome, not a parse failure
    -- and ``extra="ignore"`` drops the payload's other fields
    (``transcript_path``, ``cwd``, and, on the ``compact`` variant, ``prompt_id``
    and ``model``) canon has no interest in.

    ``source`` is READ but does not gate injection: the ruling is that canon --
    the always-known layer -- loads on every session start regardless of trigger.
    Back-history is what varies by source, and back-history is explicit-on-request
    (the resume flow), never auto-loaded here. It DOES gate the receipt: only a
    ``compact`` start is the post-compaction read-back the gate is waiting for.

    ``cwd`` is carried for the receipt alone. Canon does not use it -- its scope is
    configured -- but the context-budget gate files every receipt under a project
    slug derived from this directory, so a receipt written without it is filed
    where the gate never looks.
    """

    model_config = ConfigDict(extra="ignore")

    session_id: str | None = None
    source: str | None = None
    cwd: Path | None = None


class StopHook(BaseModel):
    """The fields a ``Stop`` payload carries that capture needs.

    Modelled from the captured fixture (``tests/fixtures/captured_hooks/
    Stop.json``): the transcript to read and the session it belongs to. Both are
    optional here -- a hook can fire before either exists, and that is a
    do-nothing outcome, not a parse failure. ``extra="ignore"`` because the real
    payload carries many more fields (``stop_hook_active``, ``effort``, ...)
    that capture has no interest in.

    ``cwd`` is carried for the capture receipt alone -- the context-budget gate
    files receipts under a project slug derived from it, so a receipt written
    without it is filed where the gate never looks. Delivery itself does not use
    it; the namespace stays token-derived server-side.
    """

    model_config = ConfigDict(extra="ignore")

    transcript_path: Path | None = None
    session_id: str | None = None
    cwd: Path | None = None


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


class PostCompactHook(BaseModel):
    """The fields a ``PostCompact`` payload carries that capture needs.

    Modelled from the captured fixture (``tests/fixtures/captured_hooks/
    PostCompact.json``). ``compact_summary`` is the generated summary that
    replaces the discarded context; ``session_id`` keys the server session the
    write goes through; ``prompt_id`` is this compaction's own identifier, reused
    as the turn's uuid so a re-fired hook de-duplicates on the server's
    ``UNIQUE(namespace, turn_uuid)`` instead of writing the same summary twice.

    THE COMPACTION SUMMARY IS THE ONE TRANSCRIPT RECORD THE STOP SPINE DROPS. Its
    transcript line carries ``isCompactSummary:true`` and NO ``promptSource``, so
    ``records.is_operator_turn`` is False and ``raw_turn_from_line`` returns None
    (``_plans/rewrite-gotchas.md`` rulings table); the Stop spine reads forward
    over it. ``PostCompact`` is therefore the only place the summary can be
    recorded, and it takes it straight from this payload rather than the
    transcript. All fields optional -- a hook can fire before one exists, a
    do-nothing outcome, not a parse failure -- and ``extra="ignore"`` drops
    ``trigger`` and the rest.

    ``cwd`` is carried for the compaction-cycle receipt alone. Recording the
    summary does not need it, but the context-budget gate keys the cycle this hook
    opens on a project slug derived from this directory, and that cycle is what
    the following ``SessionStart`` recall must name to release the gate.
    """

    model_config = ConfigDict(extra="ignore")

    compact_summary: str | None = None
    session_id: str | None = None
    prompt_id: str | None = None
    timestamp: str | None = None
    cwd: Path | None = None


class PostToolUseHook(BaseModel):
    """The fields a ``PostToolUse`` payload carries that usage telemetry needs.

    Modelled from the captured fixture (``tests/fixtures/captured_hooks/
    PostToolUse.json``): ``tool_name`` says which tool ran, ``tool_input`` carries
    its arguments, ``session_id`` keys the session, and ``cwd`` is the directory
    the invocation happened in, which is how the repo is derived.

    ``tool_input`` IS PARSED FOR ONE FIELD AND NOTHING ELSE. Only the skill name
    is read out of it (:meth:`skill_slug`); no other key is touched and none is
    stored. The rest of ``tool_input`` -- and the whole of ``tool_response``,
    which this model does not even declare -- is the content stream that
    ``docs/decisions/capture-never-drops-a-turn.md`` leaves explicitly UNDECIDED
    between memory and observability, and which ``post_tool_use``'s docstring
    warns against resolving by accident. Counting invocations does not need it,
    so this does not carry it: ``extra="ignore"`` drops ``tool_response``,
    ``tool_use_id``, ``duration_ms``, ``transcript_path``, and the rest at the
    parse boundary, where they cannot be picked up later by mistake.

    All fields optional -- a hook can fire before one exists, a do-nothing
    outcome, not a parse failure.
    """

    model_config = ConfigDict(extra="ignore")

    tool_name: str | None = None
    tool_input: dict[str, Any] | None = None
    session_id: str | None = None
    cwd: str | None = None

    def skill_slug(self) -> str | None:
        """Return the invoked skill's slug, or ``None`` when this is not a Skill call.

        Returns:
            The ``skill`` argument of a ``Skill`` tool call, stripped; ``None``
            for every other tool and for a Skill call carrying no usable name.

        ``PostToolUse`` fires for EVERY tool -- Bash, Read, Edit, and the rest --
        and #469 counts skills, so this is the filter. Only ``tool_name ==
        "Skill"`` proceeds, which is why the other tools' inputs are never read.
        """
        if self.tool_name != "Skill" or self.tool_input is None:
            return None
        raw = self.tool_input.get("skill")
        if not isinstance(raw, str):
            return None
        slug = raw.strip()
        return slug or None

    def repo(self) -> str | None:
        """Return the repository name derived from ``cwd``.

        Returns:
            The final path segment of ``cwd``, or ``None`` when absent. #469 asks
            for counts "per repo", and the directory basename is the name every
            other surface in this repo uses for one.
        """
        if self.cwd is None or not self.cwd.strip():
            return None
        return Path(self.cwd).name or None


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
        delivery = await deliver_new_turns(
            payload.transcript_path, payload.session_id, store, started.lane
        )
    finally:
        # Success or failure, the session slot is released here -- the one place
        # that owns the lane's lifecycle. The closer is content-free and swallows
        # its own transport errors (``openbrain_memory.client.close``), so it
        # cannot itself break the delivery's outcome.
        started.close()

    # Only reached when the delivery RETURNED, so the receipt is evidence rather
    # than a claim: a raised delivery leaves the watermark unadvanced and skips
    # this, which correctly leaves the gate's capture block standing. Written for
    # a delivery of zero turns too -- the gate's question is "did this session
    # reach Open Brain", and a turn with nothing new to send did.
    note_capture(payload.session_id, payload.cwd)
    return delivery


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


async def run_post_compact(
    payload: PostCompactHook,
    settings: CaptureSettings,
    *,
    lane_factory: Callable[[CaptureSettings, str], StartedLane] | None = None,
) -> bool:
    """Record one ``PostCompact`` payload's compaction summary as a raw turn.

    Args:
        payload: The parsed ``PostCompact`` hook fields.
        settings: The ``capture`` configuration section: endpoint, token, and
            identity.
        lane_factory: Builds the :class:`StartedLane`; injected for tests,
            defaults to the real ``openbrain_memory`` client with its session
            started.

    Returns:
        ``True`` when a summary was sent, ``False`` when the payload carried no
        summary or no session -- there is nothing to record then.

    This does NOT run the Stop spine. The compaction summary is not read back
    from a transcript: its transcript record carries ``isCompactSummary:true``
    and no ``promptSource``, so the reader's operator filter drops it
    (``apps/capture/records.py``) and the Stop spine walks past it. The summary
    lives ONLY on this payload, so this capability builds one :class:`RawTurn`
    from ``compact_summary`` and hands it to the SAME lane the Stop spine writes
    through (``RawLane.ingest_raw_turns``), reusing the one factory
    (:func:`_started_memory`) that ``run_stop`` and ``run_session_end`` reuse --
    no second client, no second lifecycle.

    There is no watermark. A watermark remembers a read position in a growing
    byte stream; a summary is a single payload field with no stream to resume, so
    the replay-safety a watermark gives is provided instead by the server's
    dedupe: ``prompt_id`` is reused as the turn uuid, and the server drops a
    replayed ``UNIQUE(namespace, turn_uuid)``, so a re-fired ``PostCompact`` is a
    no-op. The content is carried WHOLE -- no bound, no shortening -- exactly as
    ``capture-never-drops-a-turn.md`` requires.

    Namespace stays token-derived server-side (``src/tools/ingest-raw-turn.ts``);
    nothing here sets one. ``turn_index`` is assigned per send, matching the
    spine's rule that the server recomputes real order from ``occurred_at``.

    Raises:
        Whatever the factory or the lane raises. The ENTRYPOINT swallows these; a
        failed record must never break the session it observes.
    """
    if payload.session_id is None or payload.prompt_id is None:
        return False
    if payload.compact_summary is None or not payload.compact_summary.strip():
        return False

    turn = RawTurn(
        turn_uuid=payload.prompt_id,
        content=payload.compact_summary,
        role=TurnRole.ASSISTANT,
        is_human_prompt=False,
        occurred_at=payload.timestamp or None,
        session_ref=payload.session_id,
    )

    build = lane_factory if lane_factory is not None else _started_memory
    started = build(settings, payload.session_id)
    try:
        await asyncio.to_thread(
            started.lane.ingest_raw_turns,
            [{**turn.model_dump(exclude_none=True), "turn_index": 0}],
        )
    finally:
        # The lane holds a server session slot; release it on every path, the
        # same lifecycle rule run_stop and run_session_end own. The closer
        # swallows its own transport errors, so it cannot mask a send failure.
        started.close()

    # AFTER the summary is stored, never before: this opens the compaction cycle
    # the context-budget gate then blocks on, and arming that block for a
    # compaction whose summary was never recorded would block the session over
    # work that did not happen. It writes nothing and raises nothing when the cwd
    # is out of scope or the receipt file is unwritable.
    note_compaction(payload.session_id, payload.cwd)
    return True


async def run_post_tool_use(
    payload: PostToolUseHook,
    settings: CaptureSettings,
    *,
    recorder: Callable[[CaptureSettings, str, dict[str, Any]], None] | None = None,
) -> bool:
    """Record one skill invocation from a ``PostToolUse`` payload as a usage metric.

    Args:
        payload: The parsed ``PostToolUse`` hook fields.
        settings: The ``capture`` configuration section: endpoint, token, and
            identity.
        recorder: Sends the metric; injected for tests, defaults to the real
            ``openbrain_memory`` client calling ``record_skill_usage``.

    Returns:
        ``True`` when a metric was sent, ``False`` when the payload was not a
        Skill invocation or carried no session -- there is nothing to count then.

    METRICS ONLY (#469). What goes over the wire is the skill slug, the agent,
    the repo, the session, and the runtime -- who invoked what, where, and how
    often. NOT ``tool_input`` beyond the skill name, and NOT ``tool_response`` at
    all: that content stream is the open memory-versus-observability question in
    ``docs/decisions/capture-never-drops-a-turn.md``, and counting invocations
    does not require answering it. :class:`PostToolUseHook` drops those fields at
    the parse boundary so they cannot reach this function to be sent by mistake.

    ``PostToolUse`` fires on EVERY tool call, so the filter matters more here
    than in the other capabilities: everything that is not a ``Skill`` call
    returns ``False`` before any client is built, which means the common case
    costs one dict lookup and no network at all.

    Namespace stays token-derived server-side; nothing here sets one.

    Raises:
        Whatever the recorder raises. The ENTRYPOINT swallows these; a failed
        metric must never break the session it observes.
    """
    slug = payload.skill_slug()
    if slug is None or payload.session_id is None:
        return False

    arguments: dict[str, Any] = {
        "skill_slug": slug,
        "usage_kind": "skill",
        "session_id": payload.session_id,
        "runtime": "claude-code",
        # `agent_id` is a required non-empty field on CaptureSettings, so this
        # dimension is always present rather than conditionally attached.
        "agent": settings.agent_id,
    }
    repo = payload.repo()
    if repo is not None:
        arguments["repo"] = repo

    send = recorder if recorder is not None else _record_skill_usage
    await asyncio.to_thread(send, settings, payload.session_id, arguments)
    return True


def _record_skill_usage(
    settings: CaptureSettings, session_key: str, arguments: dict[str, Any]
) -> None:
    """Call ``record_skill_usage`` on a real client, releasing the slot after.

    The one non-test recorder. The sibling is imported here rather than at module
    top for the same reason :func:`_started_memory` does it: a ``PostToolUse``
    that is not a Skill call never reaches this function, so the client's import
    graph is not paid on the overwhelmingly common path.

    Raises:
        CaptureNotConfiguredError: When no endpoint or token is set. The
            entrypoint swallows it -- an unconfigured hook declines to record, it
            does not fail the session.
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

    from openbrain_memory.client import OpenBrainClient
    from openbrain_memory.policy import RetryPolicy

    # One attempt, matching the pinned retry every other hook path uses: a
    # retryable 429 must not turn one metric into two calls against the same
    # deadline the capture lifecycle budget is derived from.
    client = OpenBrainClient(
        base_url=settings.base_url,
        token=settings.token.get_secret_value(),
        # Inert on this path for the same reason `_started_memory` documents:
        # the client sends X-Namespace only with delegate_namespace=True
        # (default False), so the server writes to the token's own namespace.
        # agent_id is reused so nothing invents a second identity string.
        namespace=settings.agent_id,
        agent_id=settings.agent_id,
        timeout=CAPTURE_REQUEST_TIMEOUT_SECONDS,
        retry_policy=RetryPolicy(attempts=1),
    )
    try:
        client.call_tool("record_skill_usage", arguments)
    finally:
        # The client holds a server session slot; release it on every path, the
        # same lifecycle rule run_stop and run_session_end own.
        client.close()


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


#: The per-request network timeout for the canon read, in seconds. Unlike the
#: capture path this is NOT tied to the 5-second Stop deadline -- SessionStart
#: has a far larger harness allowance -- but a session start must not hang on an
#: unreachable brain, so the read is still bounded and retry is pinned to one
#: attempt. On timeout the entrypoint swallows and the session opens with no
#: injection, exactly the fail-open contract every hook carries.
CANON_REQUEST_TIMEOUT_SECONDS = 5.0


#: A canon read against ``agent_context_pack``, and how to release its slot. The
#: pack payload is the server's assembled canon (schema
#: ``openbrain.agent_context_pack.v1``: ``scope``, ``sections``, ``warnings``);
#: ``close`` frees the MCP session the read opened.
class CanonContext(BaseModel):
    """The canon pack a session-start read produced, plus its slot closer.

    Attributes:
        pack: The decoded ``agent_context_pack`` payload -- the canon sections
            the server assembled. Whatever the server returned, carried WHOLE:
            nothing here bounds, shortens, or reshapes it.
        close: Releases the server-side MCP session the read allocated. A no-op
            for an injected test recorder; the real factory wires it to the
            client's ``close``.
    """

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    pack: SkipValidation[Any]
    close: Callable[[], None]


def _derive_repo_slug(cwd: str | Path | None) -> str | None:
    """Resolve the ``repo_facts`` binding from the session's working directory.

    Walks up from ``cwd`` to the nearest directory containing ``.git`` (the
    repository root -- a plain directory for a checkout, a file for a worktree)
    and returns its basename, lowercased. That is the slug convention the
    existing fact rows already use (``open-brain``, ``king-core``); rows bound
    under other shapes are rebind work, not a fallback here.

    Returns ``None`` when no repository contains ``cwd``. The server then
    serves the defined empty state for ``repo_facts`` -- never another repo's
    facts (``src/tools/agent-context-pack-repo-facts.ts``).
    """
    if not cwd:
        return None
    try:
        path = Path(cwd).resolve()
    except OSError:
        return None
    for candidate in (path, *path.parents):
        if (candidate / ".git").exists():
            return candidate.name.lower()
    return None


async def run_session_start(
    payload: SessionStartHook,
    settings: CanonSettings,
    *,
    canon_factory: Callable[[CanonSettings], CanonContext] | None = None,
) -> Any | None:
    """Read the CANON-tier context pack for one ``SessionStart`` payload.

    Args:
        payload: The parsed ``SessionStart`` hook fields. ``source`` is read but
            does not gate the read -- canon loads on every session start.
        settings: The ``canon`` configuration: endpoint, token, and the scope and
            section list the pack is requested under.
        canon_factory: Reads the pack for the given settings and returns it with
            its slot closer. Injected so tests hand in a recorder; defaults to a
            real ``openbrain_memory`` client issuing ``agent_context_pack``.

    Returns:
        The decoded ``agent_context_pack`` payload -- the assembled canon
        sections -- carried WHOLE, or ``None`` when canon is configured to
        request no sections (an explicit empty override, nothing to inject).

    Canon is the ALWAYS-KNOWN layer and NOTHING episodic: the default
    ``settings.sections`` is exactly ``profile_guidance`` (who Rico is, the User
    layer), ``process_guidance`` (the rules, LAWs, coding/git standards, persona
    -- the Soul layer), and ``repo_facts`` (this repo's truths, scope-bound). No
    lane events, working set, durable recall, recovery, or pointers are requested
    by default, because auto-loading back-history poisons a fresh start; that
    history is explicit-on-request via the resume flow
    (``_ob/skills/brain/workflows/canon.md`` "Default: canon only";
    ``_plans/canon-always-known.md`` "The three lanes already exist"). An
    operator may widen or narrow the sections via ``OPENBRAIN_CANON_SECTIONS``,
    but the DEFAULT is canon-only.

    Raises:
        Whatever the factory raises (e.g. :class:`CanonNotConfiguredError`). The
        ENTRYPOINT swallows these; a failed read leaves the session opening with
        no injection and must never break it.
    """
    if not settings.sections:
        return None
    # Bind repo_facts to the repo the session is ACTUALLY in. An explicit
    # OPENBRAIN_CANON_REPO always wins; otherwise the literal default served
    # open-brain's facts to every repo on the machine (#517).
    if "repo" not in settings.model_fields_set:
        settings = settings.model_copy(update={"repo": _derive_repo_slug(payload.cwd)})
    build = canon_factory if canon_factory is not None else _canon_context
    context = build(settings)
    try:
        pack = context.pack
    finally:
        # The read holds a server session slot; release it on every path, the
        # same lifecycle rule the capture capabilities own. The closer is
        # content-free and swallows its own transport errors.
        context.close()

    # THE UNBLOCK, and only on a compaction restart. A ``startup`` or ``resume``
    # start is not what the gate armed its read-back against, and writing a
    # ``compact`` recall receipt for one would clear a block that a real
    # compaction had every right to hold. Reached only after the read RETURNED,
    # so the receipt is evidence the session really read canon back.
    if payload.source == COMPACT_SESSION_SOURCE:
        note_verified_recall_for_current_cycle(payload.session_id, payload.cwd)
    return pack


def _canon_context(settings: CanonSettings) -> CanonContext:
    """Read the canon pack from a real ``openbrain_memory`` client.

    The one non-test canon factory. Requests exactly ``settings.sections`` from
    ``agent_context_pack`` under the configured scope, binding ``repo_facts`` to
    ``settings.repo`` exactly (the server never falls back to another repo). The
    sibling is imported here, not at module top, so its import graph is not paid
    by a test that injects the pack, matching ``_started_memory``.

    Raises:
        CanonNotConfiguredError: When no endpoint or token is set. The entrypoint
            swallows it -- an unconfigured hook declines to inject, it does not
            fail the session.
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
        raise CanonNotConfiguredError(missing)

    from openbrain_memory.client import OpenBrainClient
    from openbrain_memory.policy import RetryPolicy

    # One attempt: a session start must not be parked by a retryable 429/5xx or a
    # Retry-After sleep. A failed read simply opens the session without injection.
    client = OpenBrainClient(
        base_url=settings.base_url,
        token=settings.token.get_secret_value(),
        # Read-only: the client sends X-Namespace only under
        # delegate_namespace=True (default off), and this passes no per-call
        # namespace, so the server scopes the pack to the token's own namespace.
        # agent is reused as the required-but-inert client namespace so nothing
        # invents a second identity string.
        namespace=settings.agent,
        agent_id=settings.agent,
        timeout=CANON_REQUEST_TIMEOUT_SECONDS,
        retry_policy=RetryPolicy(attempts=1),
    )
    try:
        pack = client.agent_context_pack(
            agent=settings.agent,
            platform=settings.platform,
            server_id=settings.server_id,
            channel_id=settings.channel_id,
            session_key=settings.session_key,
            repo=settings.repo,
            requested_sections=list(settings.sections),
        )
    except BaseException:
        # agent_context_pack lazily opens the MCP session (``_ensure_session``);
        # if the call then raises after the slot was allocated, close it so the
        # read path does not leak a slot -- the same leak the capture factory
        # guards on its startup path.
        client.close()
        raise
    return CanonContext(pack=pack, close=client.close)
