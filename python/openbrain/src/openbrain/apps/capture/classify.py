"""Assign an event type to a turn. Never decide whether to keep it.

Purpose:
    A turn's text suggests what kind of turn it is -- a decision, a correction,
    a blocker. This module makes that call and nothing else.

Architecture:
    One function, one job, and the direction of the rules is the whole point.

    ``docs/decisions/capture-never-drops-a-turn.md:12``:

        *"A filter on the capture path may TYPE a turn. It may never decide
        whether to keep one."*

    So the rules here are a DENYLIST-shaped match that falls through to a
    default, never an allowlist that returns nothing. A phrasing nobody wrote a
    pattern for is still captured -- as ``fact`` -- because the set of
    capturable phrasings must never equal the set someone thought to write a
    regex for.

    That inversion is not hypothetical. The old ``SIGNALS`` list returned
    ``null`` on no match, so a turn phrased a new way vanished with no trace,
    and the same defect was found independently in ``src/distill-window.ts``:

        *"a role no one had heard of yielded NO CANDIDATE AT ALL -- the silent,
        permanent drop the governing decision forbids."*

Pattern/Convention:
    A pattern table, checked in order, with a default. Adding a type means
    adding a row; it can never mean adding a way to return nothing.

    This module DOES NOT read the transcript, strip wrappers, redact, or reject
    pasted output. It receives text and returns a type.

Example:
    >>> classify("use postgres not sqlite")
    <EventType.DECISION: 'decision'>
    >>> classify("ok")
    <EventType.FACT: 'fact'>

See Also:
    - ``docs/decisions/capture-never-drops-a-turn.md`` - the governing rule
    - ``openbrain.models.turn`` - EventType and the default
"""

from __future__ import annotations

import re

from openbrain.models.turn import DEFAULT_EVENT_TYPE, EventType

#: Phrasings that indicate a type, checked in order.
#:
#: Ordered most-specific first: a turn saying "no, use postgres instead" is a
#: correction that also contains a decision, and the correction is the more
#: informative label.
#:
#: These TYPE a turn. They never gate one -- a turn matching nothing falls
#: through to DEFAULT_EVENT_TYPE below.
SIGNALS: tuple[tuple[re.Pattern[str], EventType], ...] = (
    (
        # `\bno,` with no trailing \b: a comma is already a non-word character,
        # so `no,\b` can never match anything. Verified 2026-07-30 -- the
        # pattern silently matched nothing and every correction fell through to
        # `decision`. Caught by test_a_correction_outranks_the_decision_inside_it.
        re.compile(
            r"(\bno,|\bnot that\b|\bwrong\b|\bincorrect\b|\bactually\b|"
            r"\binstead of that\b|"
            r"\byou (?:got|have) (?:it|that) (?:wrong|backwards)\b|"
            r"\bthe other way (?:a)?round\b)",
            re.IGNORECASE,
        ),
        EventType.CORRECTION,
    ),
    (
        re.compile(
            r"\b(blocked|blocker|can'?t proceed|stuck on|waiting on|"
            r"broken|failing|does ?n'?t work)\b",
            re.IGNORECASE,
        ),
        EventType.BLOCKER,
    ),
    (
        re.compile(
            r"\b(use|we'?ll use|going with|decided|decision|let'?s go with|"
            r"switch to|stick with|rather than)\b",
            re.IGNORECASE,
        ),
        EventType.DECISION,
    ),
    (
        re.compile(r"\?\s*$|^\s*(?:why|how|what|when|where|which|who|can we|should we)\b",
                   re.IGNORECASE),
        EventType.QUESTION,
    ),
    (
        # Anchored to the start of a line, because an instruction LEADS with its
        # verb. Unanchored, this matched the bare word "do" anywhere and typed
        # "no do it" -- an acknowledgement -- as an action. Caught by the ported
        # nine cases, which pin that turn as `fact`.
        #
        # A missed action is cheap: it stores as `fact`, which claims nothing
        # false. A wrongly-typed one is not.
        re.compile(
            r"^\s*(?:please\s+)?"
            r"(run|make|build|add|remove|fix|write|create|deploy|commit)\b",
            re.IGNORECASE | re.MULTILINE,
        ),
        EventType.ACTION,
    ),
)


def classify(text: str) -> EventType:
    """Return the event type a turn's phrasing indicates.

    Args:
        text: The turn, after wrappers are removed and values are redacted.

    Returns:
        The matching type, or :data:`~openbrain.models.turn.DEFAULT_EVENT_TYPE`
        when nothing matches. NEVER ``None``: no-match is a typing outcome, not
        a drop.

    Example:
        >>> classify("blocked on the migration")
        <EventType.BLOCKER: 'blocker'>
        >>> classify("a phrasing nobody anticipated")
        <EventType.FACT: 'fact'>
    """
    for pattern, event_type in SIGNALS:
        if pattern.search(text):
            return event_type

    return DEFAULT_EVENT_TYPE
