"""What a conversational turn is, and what a capture decided about it.

Purpose:
    The two shapes the capture path produces, declared once and validated at the
    boundary. Everything downstream receives one of these rather than a dict
    whose keys are discovered by reading the code that built it.

Architecture:
    Three types, and keeping them separate is the design:

        EventType    vocabulary  -- the closed set a signal may be typed as
        TurnSignal   judgement   -- what a capture concluded about one turn
        RawTurn      observation -- one transcript record, as it was written

    ``RawTurn`` and ``TurnSignal`` are deliberately not one model. A raw turn is
    what happened; a signal is what a classifier decided it means. Collapsing
    them puts a judgement field on an observation, and then nothing can express
    "this turn was stored but never classified" -- which is the normal state of
    every turn in the raw lane.

Key Components:
    - EventType: the nine accepted event types
    - TurnSignal: an event type plus the content it was derived from
    - RawTurn: a transcript record bound for the raw lane

Pattern/Convention:
    NOTHING HERE BOUNDS CONTENT. There is no length field, no truncation, and no
    validator comparing text against a number. ``docs/CODING_STANDARDS.md:160``:
    never shorten anything on a read or write path. The deployed TypeScript
    adapter shortens captures at 1,500 characters
    (``turn-capture.ts:386``); that behaviour is a defect being removed, not a
    contract being reproduced.

    A model here may REJECT a turn only for being structurally unusable -- an
    empty string is not a turn. It may never reject one for its size or its
    phrasing. ``docs/decisions/capture-never-drops-a-turn.md``: *"A filter on
    the capture path may TYPE a turn. It may never decide whether to keep one."*

Example:
    >>> signal = TurnSignal(event_type=EventType.FACT, content="ok")
    >>> signal.event_type
    <EventType.FACT: 'fact'>

See Also:
    - ``docs/decisions/capture-never-drops-a-turn.md`` - what capture may not do
    - ``python/openbrain-memory/src/openbrain_memory/agent.py`` - EVENT_TYPES,
      the authoritative vocabulary this mirrors
    - ``docs/CODING_STANDARDS.md`` - section 6, recall is total
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator


class EmptyTurnContentError(ValueError):
    """A signal was constructed with content that is empty or only whitespace.

    Inherits ``ValueError`` so pydantic wraps it into a ``ValidationError``
    naming the field. Any other exception type escapes unwrapped and loses the
    field name, which is the difference between a usable error and a stack
    trace.
    """

    def __init__(self) -> None:
        """State the rule, since the caller's next question is "why"."""
        super().__init__(
            "turn content is empty or only whitespace, so there is nothing to "
            "store. This is the ONLY content test on the capture path: there is "
            "no length floor, and a one-character turn is valid. "
            "ACTION REQUIRED: pass the turn's text, or pass no signal at all."
        )


class EventType(StrEnum):
    """The event types Open Brain accepts for a captured turn.

    ``StrEnum`` rather than a bare ``str``: the member set is closed, so an
    unaccepted type is a validation error at the boundary instead of a value
    that travels. It still serialises as a plain string, so the wire format is
    unchanged.

    THE CLOSED SET IS LOAD-BEARING, not stylistic. Issue #431: an event type the
    server does not accept writes NO ROW and returns NO RECEIPT -- silently. So
    a typo'd type is indistinguishable from a successful capture at the call
    site, which is the failure mode this whole rewrite exists to remove.

    Mirrors ``EVENT_TYPES`` in ``openbrain_memory.agent``. Two hand-maintained
    copies of one vocabulary is exactly how the TypeScript adapter came to
    declare EIGHT types while the Python client declared nine -- missing
    ``question`` (#409). ``tests/test_turn_models.py`` reads that list from its
    source file and fails if these drift apart, so the copy cannot rot quietly.
    """

    FACT = "fact"
    DECISION = "decision"
    BLOCKER = "blocker"
    ACTION = "action"
    ARTIFACT = "artifact"
    RECEIPT = "receipt"
    QUESTION = "question"
    CORRECTION = "correction"
    HANDOFF = "handoff"


#: The type a turn gets when no classifier matched it.
#:
#: NOT a fallback in the sense of "we gave up". ``fact`` asserts that the turn
#: happened and claims nothing about what kind of turn it was -- classification
#: is a judgement, storage is not.
#:
#: It is also the only safe choice mechanically: it is a member of the accepted
#: set, so it cannot hit the silent no-op path an unaccepted type takes (#431).
#: See ``docs/decisions/capture-never-drops-a-turn.md`` on why the classifier
#: is a denylist that types, never an allowlist that drops.
DEFAULT_EVENT_TYPE = EventType.FACT


class TurnSignal(BaseModel):
    """What a capture concluded about one turn.

    A signal always carries content. There is no "classified but empty" state:
    if there is nothing to store, no signal is produced at all, and the caller
    gets ``None`` rather than a hollow object that later fails a NOT NULL.

    Attributes:
        event_type: The classification. Defaults to ``fact`` -- see
            :data:`DEFAULT_EVENT_TYPE`.
        content: The turn's text, WHOLE. Never shortened, never sampled.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    event_type: EventType = DEFAULT_EVENT_TYPE
    # A plain str. An earlier draft declared `Field(min_length=1)`, which was
    # both redundant with the validator below and actively harmful: a Field
    # rule runs FIRST, so an empty turn reported pydantic's "String should have
    # at least 1 character" -- wording that reads exactly like a length floor.
    # The next person to meet it would reasonably try to lower the number, and
    # MIN_SIGNAL_CHARS is back.
    #
    # Caught by test_the_error_says_there_is_no_length_floor, which asserts the
    # message a caller actually sees.
    content: str

    @field_validator("content")
    @classmethod
    def _content_is_not_only_whitespace(cls, value: str) -> str:
        """Reject content that is structurally empty, and nothing else.

        ``min_length=1`` alone accepts a single space, which is not a turn. This
        is the ONLY content test in this model and it is deliberately the
        weakest possible one: it asks "is there anything here", never "is there
        enough here".

        The removed length floor (``MIN_SIGNAL_CHARS = 24``) discarded 73% of
        the operator's turns before anything could read them. Any floor
        re-introduces that loss at a different number, so there is no floor --
        the string is returned unchanged, not stripped, because leading and
        trailing whitespace is part of what was said.
        """
        if not value.strip():
            raise EmptyTurnContentError
        return value


class RawTurn(BaseModel):
    """One transcript record, bound for the raw lane.

    The raw lane is the corpus everything downstream reads, so this model is
    permissive by design: it records what a transcript line WAS, without
    deciding whether it was interesting.

    Attributes:
        turn_uuid: The transcript's own identifier for this record.
        content: The record's text, WHOLE.
        is_human_prompt: Whether a person typed this, as opposed to the
            assistant or a tool. Used for the health check that compares typed
            turns against stored ones.
        parent_turn_uuid: The preceding record, when the transcript names one.
        session_ref: The session this belongs to.
        repo: The repository the turn happened in, when derivable.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    turn_uuid: str = Field(min_length=1)
    content: str
    is_human_prompt: bool = False
    parent_turn_uuid: str | None = None
    session_ref: str | None = None
    repo: str | None = None
