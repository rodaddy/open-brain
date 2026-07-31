"""Reference implementation of the Development Python standard.

This package is not a library to depend on. It is a worked example of every rule
in ``_DOCS/STANDARDS-python.md``, written so the rules can be read as code rather
than prose -- and, more importantly, so the enforcement can be OBSERVED rejecting
a violation instead of merely described.

Layout:
    - ``config``: the keystone. Settings sources, precedence, and validation.
    - ``models``: Pydantic shapes only, no behaviour.
    - ``utils``: the shared floor every app builds on.
    - ``db``: SQLAlchemy 2.x typed ORM, for history rather than current state.
    - ``apps``: the runnable surfaces, each with its own entry point.

The enforcement lives in ``_githooks/`` and ``.github/workflows/ci.yml``, running
the same commands so neither can drift from the other.
``scripts/dev/demo-hooks.sh`` proves each hook still blocks what it claims to; a
hook that has never been observed failing is a file, not a gate.

See Also:
    - _DOCS/STANDARDS-python.md: the standard this implements
    - README.md: reading order, and why each mechanism exists
"""
