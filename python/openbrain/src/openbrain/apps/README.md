# apps

<!-- generated from __init__.py -- do not edit by hand -->

The callable capabilities. One package per thing Open Brain does.

Purpose:
    Each subpackage here is one capability with one job. A capability owns its
    own logic and imports downward -- into ``models``, ``utils``, ``db`` -- never
    sideways into another capability.

Key Components:
    - capture: turn an operator message into a durable signal, and deliver it
    - hooks: the harness entrypoints -- one module per event, parse stdin and
      exit; ``stop`` invokes the capture spine

Architecture:
    Capabilities do not import each other SIDEWAYS. When two need the same
    helper, it moves to ``utils/``; it does not get borrowed across a peer
    boundary, because that is how a set of independent apps becomes one tangled
    one.

    ``hooks`` is not a peer of ``capture`` -- it is the entrypoint layer ABOVE
    it. An entrypoint's whole job is to parse stdin and call a capability, so
    ``hooks.stop`` importing ``capture.deliver`` is the intended direction (down
    into a capability), not a sideways borrow. The rule it must still obey: no
    business logic lives in ``hooks`` (``_plans/418-prov-9-hook-entrypoints.md``).

Pattern/Convention:
    A capability exposes one entry point per job it performs, and states in its
    docstring what it does NOT do. Writing the non-goal down is what stops the
    next edit quietly adding it.

Example:
    >>> from openbrain.apps.capture.signal import signal_from
    >>> signal_from("ok").event_type
    <EventType.FACT: 'fact'>

See Also:
    - ``_DOCS/STANDARDS-python.md`` - the apps/ layout

---

Generated from the module docstring in `__init__.py`. To change this
file, edit that docstring and run
`python scripts/pytools/generate_package_docs.py --write`.
