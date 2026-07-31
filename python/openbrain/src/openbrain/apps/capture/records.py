"""Turn one transcript record into a ``RawTurn``, or into nothing.

Purpose:
    A Claude Code transcript is JSONL, and most of its lines are not operator
    turns. This module answers one question per line: did the operator say this,
    and if so, what did they say.

Architecture:
    One job. It does not open files, hold an offset, strip wrappers, redact, or
    classify -- those are :mod:`~openbrain.apps.capture.transcript`,
    :mod:`~openbrain.apps.capture.watermark`, and the four modules composed by
    :mod:`~openbrain.apps.capture.signal`.

    Every rule below was MEASURED against a live 26.5 MB transcript on
    2026-07-31, not inferred from the adapter being replaced. The measurements
    are recorded beside each rule because each one contradicts the obvious
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

import json
from typing import Any

from openbrain.models.turn import RawTurn

#: The record type carrying a message, whoever authored it.
#:
#: Necessary but nowhere near sufficient: 2,561 records matched this and only
#: 234 were the operator. See OPERATOR_PROMPT_SOURCES.
USER_RECORD_TYPE = "user"

#: ``promptSource`` values meaning a person typed this.
#:
#: ``typed`` is the operator at the keyboard; ``queued`` is the operator's
#: message submitted while a turn was already running. Both are things they
#: chose to say.
#:
#: ``system`` is EXCLUDED deliberately: it is text injected into the prompt
#: position that the operator never wrote. Two such records were observed in the
#: measured transcript.
OPERATOR_PROMPT_SOURCES = frozenset({"typed", "queued"})


def _operator_text(message: Any) -> str | None:
    """Return what the operator typed, or ``None`` if this is not their message.

    ``message.content`` is a ``str`` for operator turns and a ``list`` of
    structured blocks for tool results. Only the ``str`` shape is a person
    speaking, so the list shape is declined here rather than flattened -- a
    flattened tool result reads exactly like a very long operator turn.
    """
    if not isinstance(message, dict):
        return None

    content = message.get("content")
    if isinstance(content, str):
        return content

    return None


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
        record = json.loads(stripped)
    except json.JSONDecodeError:
        return None

    if not isinstance(record, dict):
        return None

    if record.get("type") != USER_RECORD_TYPE:
        return None

    if record.get("promptSource") not in OPERATOR_PROMPT_SOURCES:
        return None

    content = _operator_text(record.get("message"))
    if content is None:
        return None

    turn_uuid = record.get("uuid")
    if not isinstance(turn_uuid, str) or not turn_uuid:
        return None

    return RawTurn(
        turn_uuid=turn_uuid,
        content=content,
        is_human_prompt=True,
        parent_turn_uuid=_optional_str(record.get("parentUuid")),
        session_ref=_optional_str(record.get("sessionId")),
        repo=_optional_str(record.get("cwd")),
    )


def _optional_str(value: Any) -> str | None:
    """Return ``value`` when it is a non-empty string, otherwise ``None``.

    Transcript records carry ``null`` for absent fields -- ``parentUuid`` is
    ``null`` on the first turn of every session -- so an absent value and a
    present-but-null one must reach the model identically.
    """
    return value if isinstance(value, str) and value else None
