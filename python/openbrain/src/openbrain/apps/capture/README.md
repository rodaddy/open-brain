# capture

<!-- generated from __init__.py -- do not edit by hand -->

Turn what the operator said into something durable, losing none of it.

Purpose:
    The capture path. One message in, one signal or nothing out.

Key Components:
    - deliver: THE SPINE -- read since the watermark, send to the raw lane
      through ``openbrain_memory``, advance only after the send returns
    - watermark: remember and advance a per-session byte offset
    - transcript: read records from an offset to EOF
    - records: turn one transcript line into a ``RawTurn``
    - signal: the distilled lane's entry point, composing the four below
    - wrappers: remove system-injected text
    - paste: recognise machine output by its shape
    - redaction: mask secret values, keep the statement
    - classify: assign an event type

Architecture:
    Two lanes, single-purpose modules, and composition at the edges. The RAW
    lane (``deliver`` composing ``watermark``/``transcript``/``records``)
    sends turns whole and untouched -- the server owns redaction, scaffolding
    drop, and dedupe. The DISTILLED lane (``signal`` composing the four
    below it) types what the operator said. The old implementation did the
    distilled lane's four jobs in one 423-line file, and that is exactly how
    one filter came to hide another: removing a length floor did not make
    "ok" capture, because a separate phrasing allowlist was independently
    dropping it. Two mechanisms, one effect, one namespace.

    Only the two composers import their parts. Parts import nothing from each
    other, and nothing here writes anywhere except through ``deliver``'s lane.

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

---

Generated from the module docstring in `__init__.py`. To change this
file, edit that docstring and run
`python scripts/pytools/generate_package_docs.py --write`.
