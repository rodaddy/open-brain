"""The shapes Open Brain passes between its layers, declared once.

Purpose:
    Every value crossing a boundary is one of these, validated at construction.
    A layer that receives a model knows what it holds; a layer that receives a
    dict knows only what the code that built it happened to put there.

Key Components:
    - turn: EventType, TurnSignal, RawTurn -- the capture path's vocabulary and
      the two records it produces

Architecture:
    Models hold shape and the invariants of that shape. They do not hold
    behaviour that needs the outside world: no database access, no HTTP, no
    file reads. That keeps them importable from anywhere without pulling a
    connection pool along, and testable without fixtures.

    A model may REJECT a value for being structurally unusable. It may never
    reject one for its size, and it may never shorten one --
    ``docs/CODING_STANDARDS.md:160``.

Pattern/Convention:
    Import from the submodule, not from this package::

        from openbrain.models.turn import EventType, TurnSignal

    Re-exporting through this ``__init__`` would make every ``models`` import
    pull in every submodule, which is how an import cycle gets built by
    accident.

Example:
    >>> from openbrain.models.turn import EventType, TurnSignal
    >>> TurnSignal(event_type=EventType.DECISION, content="use postgres").content
    'use postgres'

See Also:
    - ``docs/decisions/capture-never-drops-a-turn.md`` - what capture may not do
    - ``_DOCS/STANDARDS-python.md`` - the models/ contract
"""
