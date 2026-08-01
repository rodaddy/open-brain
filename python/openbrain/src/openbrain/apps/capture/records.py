"""Turn one transcript record into a ``RawTurn``, or into nothing.

Purpose:
    A Claude Code transcript is JSONL, and most of its lines are not operator
    turns. This module answers one question per line: did the operator say this,
    and if so, what did they say.

Architecture:
    **Pydantic owns the shape; this module owns the meaning.** The record is
    parsed into a declared model, so field presence, types, and null-vs-absent
    are handled by a library thousands of services exercise rather than by a
    chain of ``isinstance`` checks.

    That split matters because the first version of this module hand-wrote the
    validation -- in a package whose first dependency is pydantic, and against
    ``_DOCS/STANDARDS-core.md:208``, which names "schema validator" on the
    do-not-write list. The knowledge below is genuinely ours and no library
    knows it; the *validation* never was.

    Every rule was MEASURED against a live 26.5 MB transcript on 2026-07-31,
    not inferred from the adapter being replaced. Each contradicts the obvious
    assumption:

    ``type == "user"`` DOES NOT MEAN THE OPERATOR.
        2,561 records had ``type == "user"``; only 234 were typed by a person.
        The rest are tool results, which Claude Code replays into the transcript
        as user-role messages. Treating them as operator turns would fill the
        lane with command output.

    ``userType`` IS NOT THE DISCRIMINATOR.
        It read ``"external"`` on all 2,563 user records, including every tool
        result. It looks like an operator marker and separates nothing.

    ``promptSource`` IS the discriminator.
        Three values observed: ``typed`` (206), ``queued`` (28), ``system`` (2).
        The first two are the operator; ``system`` is injected text they never
        wrote. Tool results carry no ``promptSource`` at all.

    ``message.content`` HAS TWO SHAPES.
        A ``str`` on 256 records and a ``list`` on 2,305. Every operator turn was
        a ``str``; the list shape belongs to tool results and structured content
        blocks. A reader assuming one shape silently drops the other.

Pattern/Convention:
    A line that is not an operator turn returns ``None``, and so does a line that
    is malformed. NEITHER IS AN ERROR -- a transcript legitimately contains
    eleven record types, and the first three lines of every file
    (``last-prompt``, ``mode``, ``permission-mode``) carry no ``uuid`` at all.
    Raising on those would mean crashing on line 1 of every session.

    Nothing here bounds, shortens, or samples content. ``content`` is carried
    whole, byte for byte, as
    ``docs/decisions/capture-never-drops-a-turn.md`` requires.

Example:
    >>> line = '{"type":"user","uuid":"u1","promptSource":"typed",'
    >>> line += '"message":{"content":"ok"}}'
    >>> turn = raw_turn_from_line(line)
    >>> turn.content
    'ok'
    >>> raw_turn_from_line('{"type":"assistant","uuid":"a1"}') is None
    True

See Also:
    - ``openbrain.models.turn`` - the ``RawTurn`` shape produced here
    - ``openbrain.apps.capture.transcript`` - the reader that calls this per line
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from openbrain.models.turn import RawTurn, TurnRole

#: The record type carrying a message, whoever authored it.
#:
#: Necessary but nowhere near sufficient: 2,561 records matched this and only
#: 234 were the operator. See :class:`PromptSource`.
USER_RECORD_TYPE = "user"


class PromptSource(StrEnum):
    """Where a prompt-position message came from.

    ``TYPED`` is the operator at the keyboard; ``QUEUED`` is their message
    submitted while a turn was already running. Both are things they chose to
    say. ``SYSTEM`` is text injected into the prompt position that the operator
    never wrote.

    Declared as an enum so an unrecognised value fails validation loudly here,
    rather than being silently mis-typed as operator input somewhere downstream.
    """

    TYPED = "typed"
    QUEUED = "queued"
    SYSTEM = "system"


#: The sources that mean a person chose to say this.
OPERATOR_PROMPT_SOURCES = frozenset({PromptSource.TYPED, PromptSource.QUEUED})


class TranscriptMessage(BaseModel):
    """The ``message`` object on a transcript record.

    ``content`` is typed as ``Any`` deliberately: it is a ``str`` for operator
    turns and a ``list`` of structured blocks for tool results, and BOTH are
    valid records. Narrowing it here would reject tool results as malformed
    rather than declining them as not-the-operator, which is a different thing
    and would hide format changes.
    """

    model_config = ConfigDict(extra="ignore")

    content: Any = None


class TranscriptRecord(BaseModel):
    """One line of a Claude Code transcript, as far as capture cares.

    ``extra="ignore"`` because a transcript record carries up to seventeen
    fields and this module has an interest in six. Ignoring the rest means a new
    field upstream is not a parse failure.
    """

    model_config = ConfigDict(extra="ignore")

    record_type: str | None = Field(default=None, alias="type")
    uuid: str | None = None
    prompt_source: PromptSource | None = Field(default=None, alias="promptSource")
    message: TranscriptMessage | None = None
    parent_uuid: str | None = Field(default=None, alias="parentUuid")
    session_id: str | None = Field(default=None, alias="sessionId")
    cwd: str | None = None
    timestamp: str | None = None

    @property
    def is_operator_turn(self) -> bool:
        """Whether a person chose to say this."""
        return (
            self.record_type == USER_RECORD_TYPE
            and self.prompt_source in OPERATOR_PROMPT_SOURCES
        )

    @property
    def operator_text(self) -> str | None:
        """What the operator typed, or ``None`` if this is not their message.

        Only the ``str`` shape is a person speaking, so the list shape is
        declined rather than flattened -- a flattened tool result reads exactly
        like a very long operator turn.
        """
        if self.message is None:
            return None

        content = self.message.content
        return content if isinstance(content, str) else None


def raw_turn_from_line(line: str) -> RawTurn | None:
    """Build a :class:`~openbrain.models.turn.RawTurn` from one JSONL line.

    Args:
        line: A single line of a Claude Code transcript, with or without its
            trailing newline.

    Returns:
        A ``RawTurn`` when the line is an operator turn, otherwise ``None``.
        ``None`` covers every ordinary non-turn case -- assistant messages, tool
        results, mode markers, blank lines -- and also unparseable lines, which
        a transcript being written concurrently can produce.

    Example:
        >>> raw_turn_from_line("") is None
        True
        >>> raw_turn_from_line("{not json") is None
        True
    """
    stripped = line.strip()
    if not stripped:
        return None

    try:
        record = TranscriptRecord.model_validate_json(stripped)
    except ValidationError:
        return None

    if not record.is_operator_turn:
        return None

    content = record.operator_text
    if content is None or not record.uuid:
        return None

    return RawTurn(
        turn_uuid=record.uuid,
        content=content,
        # Explicit, not the model default: only the typed-shape path reaches
        # here, so USER is a fact about this line, not a fallback.
        role=TurnRole.USER,
        is_human_prompt=True,
        # The transcript's own clock, verbatim. The server orders a session by
        # (session_ref, occurred_at); a backfill that dropped this left 20,535
        # rows unorderable (scripts/backfill-transcripts.ts:256).
        occurred_at=record.timestamp or None,
        parent_turn_uuid=record.parent_uuid or None,
        session_ref=record.session_id or None,
        repo=record.cwd or None,
    )
