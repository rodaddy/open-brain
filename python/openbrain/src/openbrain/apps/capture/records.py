"""Turn one transcript record into a ``RawTurn``, or into nothing.

Purpose:
    A Claude Code transcript is JSONL, and most of its lines are neither half of
    the conversation. This module answers one question per line: is this
    something a participant SAID -- the operator typing, or the assistant
    replying on screen -- and if so, what were the words.

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

    THE ASSISTANT SIDE IS ALWAYS THE LIST SHAPE (#447).
        Measured 2026-08-03 on a live open-brain session transcript: all 134
        ``type == "assistant"`` records carried a ``list``, none a ``str``, and
        those lists held ``text`` (75) and ``tool_use`` (59) blocks. So the
        operator's ``str``-only rule is exactly wrong for the assistant, and
        reading its words needs the block walk in :func:`_assistant_text`.

Both Sides (#447):
    An earlier version of this module read the OPERATOR ONLY, and that was a
    PORT REGRESSION, not an original gap. The governing decision already settled
    the scope -- ``docs/decisions/capture-never-drops-a-turn.md:215``:

        *"Settled: everything on screen goes in. The operator's words and the
        assistant's replies, in full, no length test, no phrasing allowlist."*

    The TypeScript adapter this package replaced honoured that
    (``scripts/backfill-transcripts.ts:125``); the port carried the operator half
    across and left the assistant half behind. Measured on the dogfood database,
    ``ob_raw_turns`` in namespace ``rico``:

    ==========  =========  ====  =====  ===================================
    Day         assistant  tool  user   Path
    ==========  =========  ====  =====  ===================================
    2026-07-27  5,773      3,022 495    TypeScript adapter
    2026-07-30  3,332      1,877 255    TypeScript adapter
    2026-08-02  13         0     365    Python port -- and all 13 are
                                        ``PostCompact`` summaries
    ==========  =========  ====  =====  ===================================

    So the corpus REM grades held one side of every conversation: the questions
    and none of the answers. That is the defect #447 names, and restoring it here
    -- at the parser that decides what a line WAS -- is the owning boundary. It
    is not a distillation step: the raw lane is the corpus, distillation is a
    later and reversible stage, and a filter on this path "may TYPE a turn, it
    may never decide whether to keep one" (the same decision, line 12).

    TWO BLOCK KINDS ARE ROUTED ELSEWHERE, each by a rule someone already made:

    ``thinking`` blocks -- chain-of-thought.
        Never stored. Not on screen, not something either participant said, and
        the standing hard rule across every runtime is distilled events only,
        never raw reasoning. The TypeScript reference skipped these for the same
        stated reason (``backfill-transcripts.ts:148``), so this preserves the
        settled behaviour rather than introducing anything new.

    ``tool_use`` blocks -- the machinery underneath.
        Left to the open question rather than answered here. The decision doc
        parks it explicitly (``capture-never-drops-a-turn.md:213``) in terms that
        bind this change: *"Do not resolve this by inference, and do not let it
        be resolved by accident. The failure mode is a stage quietly starting to
        filter on role."* Reading text now and leaving tool calls to that
        question is the reversible order -- bringing tool volume in afterwards is
        purely additive, whereas asserting here that it belongs would resolve by
        accident exactly what the operator parked. Nothing is dropped from
        anywhere: these records stay in the transcript, which remains their
        source, and #417 tracks where execution traces land.

Pattern/Convention:
    A line that neither participant spoke returns ``None``, and so does a line
    that is malformed. NEITHER IS AN ERROR -- a transcript legitimately contains
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
    >>> reply = '{"type":"assistant","uuid":"a1","message":{"content":'
    >>> reply += '[{"type":"text","text":"the index was empty"}]}}'
    >>> raw_turn_from_line(reply).content
    'the index was empty'

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

#: The record type carrying the assistant's reply -- the agent side (#447).
#:
#: Unlike ``user``, this type needs no second discriminator: a record is either
#: the assistant speaking or it is not. What it DOES need is the block walk, and
#: for the same reason ``promptSource`` matters above -- the type alone says who
#: authored the record, never which parts of it were on screen.
ASSISTANT_RECORD_TYPE = "assistant"

#: The content block holding words that appeared on screen.
#:
#: The ONLY block kind read off an assistant record. ``thinking`` is
#: chain-of-thought and is never stored, and ``tool_use`` belongs to the open
#: memory-versus-observability question -- both covered in the module docstring.
TEXT_BLOCK_TYPE = "text"

#: Separator between an assistant record's text blocks when it carries several.
#:
#: One record can hold prose, then a tool call, then more prose; the reply is the
#: prose in order, and a newline is how it rendered on screen. Matches the
#: TypeScript reference (``scripts/backfill-transcripts.ts:159``).
BLOCK_JOINER = "\n"


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
    def is_assistant_turn(self) -> bool:
        """Whether the assistant produced this record (#447).

        No ``promptSource`` analogue is needed or available: that field
        discriminates operator typing from injected text in the PROMPT position,
        and nothing is injected into the assistant position. The narrowing that
        matters for the assistant is which blocks it spoke, which is
        :attr:`assistant_text`'s job, not this one's.
        """
        return self.record_type == ASSISTANT_RECORD_TYPE

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

    @property
    def assistant_text(self) -> str | None:
        """What the assistant said on screen, or ``None`` when it said nothing.

        Returns:
            The record's ``text`` blocks joined in order, or ``None`` when the
            record carries none -- a reply that was purely tool calls, which is
            a real and ordinary record, not a malformed one.

        Mirrors :attr:`operator_text` in contract and inverts it in mechanism:
        the operator speaks in the ``str`` shape and the assistant in the
        ``list`` shape (all 134 assistant records on a live transcript, measured
        2026-08-03). A ``str`` is therefore NOT accepted here -- it has never
        been observed on an assistant record, and quietly accepting one would
        make an unmeasured shape look like a verified one.

        Text is joined, never shortened, and never sampled: the whole reply is
        the record of what was said (``capture-never-drops-a-turn.md``).
        """
        if self.message is None:
            return None

        content = self.message.content
        if not isinstance(content, list):
            return None

        return _assistant_text(content)


def _assistant_text(content: list[Any]) -> str | None:
    """Join the ``text`` blocks of one assistant record, in order.

    Args:
        content: The record's ``message.content`` list, straight off the
            transcript and therefore untrusted in shape.

    Returns:
        The spoken text, or ``None`` when the record held no usable text block.

    Every block that is not :data:`TEXT_BLOCK_TYPE` is passed over rather than
    rejected: a reply that interleaves prose with tool calls is the NORMAL shape
    (59 of the 134 measured records carried a ``tool_use``), so treating an
    unread block as malformed would decline the very records that carry the most
    reasoning. Malformed entries -- a bare string, a null -- are passed over for
    the same reason: this walk reports what it could read, never what it wished
    the transcript looked like.
    """
    spoken = [
        text
        for block in content
        if isinstance(block, dict)
        and block.get("type") == TEXT_BLOCK_TYPE
        and isinstance(text := block.get("text"), str)
        and text.strip()
    ]
    if not spoken:
        return None
    return BLOCK_JOINER.join(spoken)


def raw_turn_from_line(line: str) -> RawTurn | None:
    """Build a :class:`~openbrain.models.turn.RawTurn` from one JSONL line.

    Args:
        line: A single line of a Claude Code transcript, with or without its
            trailing newline.

    Returns:
        A ``RawTurn`` when the line is something a participant SAID -- the
        operator typing or the assistant replying (#447) -- otherwise ``None``.
        ``None`` covers every ordinary non-turn case -- tool results, mode
        markers, an assistant record that was only tool calls, blank lines --
        and also unparseable lines, which a transcript being written
        concurrently can produce.

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

    if not record.uuid:
        return None

    # BOTH SIDES, and the branch order is not arbitrary: the operator test is
    # the narrower one (a type AND a promptSource), so it is asked first and the
    # assistant test never sees a record the operator test already claimed.
    if record.is_operator_turn:
        content = record.operator_text
        role = TurnRole.USER
        # The load-bearing flag: what a PERSON typed. It is what the health
        # check in capture-never-drops-a-turn.md compares against the transcript,
        # so an assistant turn must never set it -- doing so would make the agent
        # side look like operator volume and hide a future operator-side loss.
        is_human_prompt = True
    elif record.is_assistant_turn:
        content = record.assistant_text
        role = TurnRole.ASSISTANT
        is_human_prompt = False
    else:
        return None

    if content is None:
        return None

    return RawTurn(
        turn_uuid=record.uuid,
        content=content,
        # Explicit per branch, never the model default: the role is a FACT about
        # which side of the conversation this line was, and defaulting it is how
        # the port came to record every turn as the operator's.
        role=role,
        is_human_prompt=is_human_prompt,
        # The transcript's own clock, verbatim. The server orders a session by
        # (session_ref, occurred_at); a backfill that dropped this left 20,535
        # rows unorderable (scripts/backfill-transcripts.ts:256).
        occurred_at=record.timestamp or None,
        parent_turn_uuid=record.parent_uuid or None,
        session_ref=record.session_id or None,
        repo=record.cwd or None,
    )
