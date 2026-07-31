"""Turn one operator message into a signal, or into nothing at all.

Purpose:
    The capture path's single entry point. Composes the four single-purpose
    modules beside it into the one decision a caller actually wants: is there
    something to store here, and what kind of thing is it.

Architecture:
    This is the ONLY module in the package that imports its siblings. They import
    nothing from each other, so each is testable alone and none can quietly
    change another's behaviour -- the same star topology the modules being
    replaced had, kept deliberately.

    The order is fixed and each step earns its place:

        1. strip wrappers    remove text the operator never typed
        2. reject pasted     machine output is not something they said
        3. redact            mask values, keep the statement
        4. classify          type it; never drop it

    Redaction runs BEFORE classification so a token's characters cannot
    influence the type, and AFTER the paste check so the check sees the text as
    it was pasted.

Pattern/Convention:
    Returns ``None`` for exactly two reasons, and both are structural:
    there is nothing left after wrappers are removed, or the text is machine
    output. NEVER for being short, and never for being phrased unusually --
    ``docs/decisions/capture-never-drops-a-turn.md``.

    ``None`` here means "no signal", not "failure". A caller that receives it
    has nothing to store, which is a normal outcome for an empty prompt.

Example:
    >>> signal_from("use postgres not sqlite").event_type
    <EventType.DECISION: 'decision'>
    >>> signal_from("   ") is None
    True

See Also:
    - ``docs/decisions/capture-never-drops-a-turn.md`` - the governing decision
    - ``openbrain.apps.capture.wrappers`` / ``paste`` / ``redaction`` /
      ``classify`` - the four jobs this composes
"""

from __future__ import annotations

from openbrain.apps.capture.classify import classify
from openbrain.apps.capture.paste import looks_pasted
from openbrain.apps.capture.redaction import redact
from openbrain.apps.capture.wrappers import strip_system_wrappers
from openbrain.models.turn import TurnSignal


def signal_from(text: str | None) -> TurnSignal | None:
    """Produce a signal for one operator message, or ``None`` if there is none.

    Args:
        text: The message as it appeared in the transcript. ``None`` is accepted
            so a caller with no message need not special-case it.

    Returns:
        A :class:`~openbrain.models.turn.TurnSignal` carrying the WHOLE redacted
        text, or ``None`` when there is nothing to store.

    Example:
        >>> signal_from("k").content
        'k'
        >>> signal_from(None) is None
        True
    """
    if text is None:
        return None

    cleaned = strip_system_wrappers(text)
    if not cleaned.strip():
        return None

    if looks_pasted(cleaned):
        return None

    redacted = redact(cleaned)
    return TurnSignal(event_type=classify(redacted), content=redacted)
