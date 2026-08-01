"""The format factory: turn one input line into a ``RawTurn``, by input type.

Purpose:
    A giant session file arrives in one of several shapes -- a Claude transcript
    first, later Claude Code (base64 images) and Hermes (no fixed shape). This
    module is the factory keyed on that input type, and it lives HERE by ruling:
    *"The factory keyed on input type belongs THERE"* -- in the bulk app, never
    on the live adapter's deadline-critical hook path
    (`_plans/python-port-sequence.md` §TWO APPLICATIONS).

Architecture:
    A format adapter is a PURE function ``(str) -> RawTurn | None`` over one line
    of the input, exactly the shape ``records.raw_turn_from_line`` already has.
    The Claude adapter IS ``records.raw_turn_from_line``, imported -- not copied
    -- because it is a pure function over a line with no I/O and no state, and
    the reuse ruling is explicit (operator: *"reuse already working code,
    good."*). Adding a format is adding one function to :data:`_ADAPTERS`, not
    editing a chain of ``if`` branches.

Pattern/Convention:
    An UNBUILT format fails LOUD, never silent. Code and Hermes are follow-on
    tickets (#454 names them), so their adapters raise
    :class:`FormatNotImplementedError` the moment they are selected -- an
    operator running the bulk app must see "that format is not built yet", not a
    silently empty ingest. This is the bulk app's loud-failure contract, the
    opposite of the live adapter's swallow.

    Nothing here bounds, shortens, or samples content. An adapter either yields
    a whole ``RawTurn`` or declines the line as not-a-turn (``None``), the same
    two outcomes ``records`` has -- it never truncates.

Example:
    >>> line = (
    ...     '{"type":"user","uuid":"u1","promptSource":"typed",'
    ...     '"message":{"content":"hello"}}'
    ... )
    >>> adapter = adapter_for(InputFormat.CLAUDE)
    >>> adapter(line).content
    'hello'
    >>> adapter('{"type":"assistant"}') is None
    True

See Also:
    - `openbrain.apps.capture.records.raw_turn_from_line` - the reused Claude adapter
    - `_plans/python-port-sequence.md` §TWO APPLICATIONS - why the factory is here
"""

from __future__ import annotations

from collections.abc import Callable
from enum import StrEnum

from openbrain.apps.capture.records import raw_turn_from_line
from openbrain.models.turn import RawTurn

#: A format adapter: one input line in, one whole ``RawTurn`` or ``None`` out.
#:
#: The exact signature ``records.raw_turn_from_line`` already has, which is why
#: the Claude adapter needs no wrapper -- it is that function, imported.
LineAdapter = Callable[[str], RawTurn | None]


class InputFormat(StrEnum):
    """The input shapes the bulk ingester knows how to key on.

    ``StrEnum`` so an unrecognised format string fails validation loudly at the
    boundary rather than travelling as a bare string. Declared as a closed set
    for the same reason the turn vocabularies are: a typo'd format is a startup
    error, not a silent no-op.

    ``CLAUDE`` is built (it reuses ``records``); ``CODE`` and ``HERMES`` are
    named here so the follow-on work has a place to land, and selecting either
    today raises :class:`FormatNotImplementedError`.
    """

    CLAUDE = "claude"
    CODE = "code"
    HERMES = "hermes"


class FormatNotImplementedError(NotImplementedError):
    """A recognised input format has no adapter built yet.

    Raised the instant an unbuilt format is selected, so an operator sees the
    gap immediately rather than watching a silently empty ingest. Code (base64
    images) and Hermes (no fixed shape) are the follow-on tickets #454 names;
    their adapters are absent by design, not by accident.
    """

    def __init__(self, input_format: InputFormat) -> None:
        """Name the format and point at where the follow-on work is tracked."""
        super().__init__(
            f"the {input_format.value!r} input format is recognised but its "
            f"adapter is not built yet. Only {InputFormat.CLAUDE.value!r} is "
            f"implemented; Code (base64 images) and Hermes (no fixed shape) are "
            f"follow-on tickets under #454. "
            f"ACTION REQUIRED: ingest a Claude transcript, or build the adapter."
        )


def _unbuilt(input_format: InputFormat) -> LineAdapter:
    """A placeholder adapter that raises the moment it is called.

    Registered for a recognised-but-unbuilt format so selection is loud: the
    factory returns a real callable, and the failure surfaces on the first line
    with the format named, not as an empty result.
    """

    def adapter(_line: str) -> RawTurn | None:
        raise FormatNotImplementedError(input_format)

    return adapter


#: The one place a format maps to its adapter. Adding a format is adding a row
#: here, not editing a branch -- the same star topology the capture modules keep.
#: The Claude row IS ``records.raw_turn_from_line`` by reference; the two unbuilt
#: rows are loud placeholders so a missing adapter can never read as a clean run.
_ADAPTERS: dict[InputFormat, LineAdapter] = {
    InputFormat.CLAUDE: raw_turn_from_line,
    InputFormat.CODE: _unbuilt(InputFormat.CODE),
    InputFormat.HERMES: _unbuilt(InputFormat.HERMES),
}


def adapter_for(input_format: InputFormat) -> LineAdapter:
    """Return the line adapter for one input format.

    Args:
        input_format: The shape of the file being ingested.

    Returns:
        A pure ``(str) -> RawTurn | None`` adapter. For a recognised-but-unbuilt
        format the returned adapter raises :class:`FormatNotImplementedError`
        when first called, so the caller can stage lazily and still fail loud.

    Example:
        >>> adapter_for(InputFormat.CLAUDE) is raw_turn_from_line
        True
    """
    return _ADAPTERS[input_format]
