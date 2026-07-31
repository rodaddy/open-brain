"""Turn what the operator said into something durable, losing none of it.

Purpose:
    The capture path. One message in, one signal or nothing out.

Key Components:
    - signal: the entry point, composing the four below
    - wrappers: remove system-injected text
    - paste: recognise machine output by its shape
    - redaction: mask secret values, keep the statement
    - classify: assign an event type

Architecture:
    FOUR single-purpose modules plus one that composes them. The old
    implementation did all four jobs in one 423-line file, and that is exactly
    how one filter came to hide another: removing a length floor did not make
    "ok" capture, because a separate phrasing allowlist was independently
    dropping it. Two mechanisms, one effect, one namespace.

    Only ``signal`` imports the others. They import nothing from each other.

Pattern/Convention:
    THIS PACKAGE NEVER DROPS A TURN FOR ITS SIZE OR ITS PHRASING. A message is
    refused only when there is nothing left after wrappers are removed, or when
    it is machine output. See ``docs/decisions/capture-never-drops-a-turn.md``.

    Nothing here shortens text. ``docs/CODING_STANDARDS.md:160``.

Example:
    >>> from openbrain.apps.capture.signal import signal_from
    >>> signal_from("use postgres not sqlite").event_type
    <EventType.DECISION: 'decision'>

See Also:
    - ``docs/decisions/capture-never-drops-a-turn.md`` - the governing decision
"""
