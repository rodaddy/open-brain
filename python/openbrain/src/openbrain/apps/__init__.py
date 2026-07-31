"""The callable capabilities. One package per thing Open Brain does.

Purpose:
    Each subpackage here is one capability with one job. A capability owns its
    own logic and imports downward -- into ``models``, ``utils``, ``db`` -- never
    sideways into another capability.

Key Components:
    - capture: turn an operator message into a durable signal

Architecture:
    Capabilities do not import each other. When two need the same helper, it
    moves to ``utils/``; it does not get borrowed across a capability boundary,
    because that is how a set of independent apps becomes one tangled one.

Pattern/Convention:
    A capability exposes one entry point per job it performs, and states in its
    docstring what it does NOT do. Writing the non-goal down is what stops the
    next edit quietly adding it.

Example:
    >>> from openbrain.apps.capture.signal import signal_from
    >>> signal_from("ok").event_type
    <EventType.FACT: 'fact'>

See Also:
    - ``docs/standards/STANDARDS-python.md`` - the apps/ layout
"""
