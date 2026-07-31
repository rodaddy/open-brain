# utils

<!-- generated from __init__.py -- do not edit by hand -->

Shared, dependency-free helpers used across every Open Brain capability.

Purpose:
    The bottom of the import graph. Anything here may be imported by any app,
    model, or db module; nothing here imports from those, so this package can
    never participate in a cycle.

Key Components:
    - logging_config: every logging sink, and the correlation-id context. The
      only consumer of ``config.LogSettings``, and it is called exactly once,
      by ``config.load_settings``.

Architecture:
    ``utils/`` is the shared floor, not a junk drawer. A module earns a place
    here by being needed in two or more capabilities AND having no dependency
    on any of them. A helper used by exactly one app belongs in that app.

    The distinction matters because the failure it prevents is real: a
    "shared" module that imports from one capability quietly couples every
    other caller to that capability, and the coupling is invisible until the
    import graph is drawn.

Pattern/Convention:
    Import concrete names from the submodule, not from this package::

        from openbrain.utils.logging_config import LogContext, setup_logging

    Re-exporting through this ``__init__`` would make every ``utils`` import
    pull in every submodule, which is how an import cycle is built by accident.

Example:
    >>> from openbrain.utils.logging_config import LogContext
    >>> with LogContext("session-42"):
    ...     pass

See Also:
    - ``openbrain.config`` - the keystone that calls into logging_config
    - ``docs/standards/STANDARDS-python.md`` - the utils/ contract

---

Generated from the module docstring in `__init__.py`. To change this
file, edit that docstring and run
`python scripts/pytools/generate_package_docs.py --write`.
