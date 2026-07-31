"""The three applications. Each is independently callable; all share one floor.

WHY THREE APPLICATIONS IN ONE PACKAGE
    A shared ``config.py`` and a shared ``utils/`` are trivially "correct" when
    exactly one caller uses them -- any layout works when there is nothing to
    share with. Three independent consumers is where the design is actually
    tested. If ``utils/`` is the wrong shape, if config assumed one app's needs,
    or if a helper really belonged to one app rather than the floor, three
    callers expose it immediately and one never will.

    ``utils/http.py`` is the worked case: monitor uses it to check targets, hook
    uses it to forward events downstream. Written inside either app it would
    have been duplicated, and the two copies would have drifted -- one gaining a
    jitter fix the other did not.

Key Components:
    - monitor: async HTTP, retry, scheduling, persistence, an HTTP surface.
    - watch: filesystem polling, validation, batch transform. No network.
    - hook: an HTTP receiver -- schema validation, dispatch, idempotency.

Pattern/Convention:
    Every app has the same three files, and the split is the point:

        __main__.py   argument parsing, config load, signal wiring, run
        service.py    the orchestration loop for that app
        <domain>.py   the actual work, in units small enough to test alone

    ``__main__.py`` never contains logic. It builds objects and starts them, so
    everything below it can be constructed in a test without a process, a
    signal handler, or a parsed command line.

    Adding a fourth app means a new subpackage and a new ``[project.scripts]``
    entry. It must not mean editing the other three.

Example:
    >>> # Each app runs standalone, sharing one settings object:
    >>> # uv run python -m exemplar.apps.monitor --env test
    >>> # uv run python -m exemplar.apps.watch   --env test
    >>> # uv run python -m exemplar.apps.hook    --env test

See Also:
    - exemplar.config: the one settings object all three build
    - _DOCS/python-exemplar/README.md ## Why three applications
"""

from __future__ import annotations
