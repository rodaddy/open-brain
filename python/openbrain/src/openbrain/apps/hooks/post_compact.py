"""The ``PostCompact`` hook entrypoint. NOT IMPLEMENTED -- a deliberate stub.

Purpose:
    Fires after a compaction COMPLETES, carrying ``trigger``
    (``manual``/``auto``) and ``compact_summary`` -- the generated summary that
    replaces the discarded context. Captured as a real fixture
    (``tests/fixtures/captured_hooks/PostCompact.json``) on 2026-07-31 by forcing
    a real compaction; its capability is not yet decided for the Python app.

Architecture:
    A stub entrypoint: read stdin, exit 0. See ``apps.hooks._stub`` for the
    shared shape.

Pattern/Convention:
    OPEN QUESTION -- compaction has already discarded the window by the time this
    fires, but the spine already captures every ``Stop``, so the turns are
    durable independently of the window being compacted. Whether ``PostCompact``
    needs to do anything -- e.g. record the ``compact_summary`` -- is undecided
    (``_plans/rewrite-gotchas.md``). Its sibling ``SessionStart`` fires a second
    time here with ``source":"compact"``; that is the same event and entrypoint,
    not a new one.

Example:
    >>> import io
    >>> main(io.StringIO('{"hook_event_name":"PostCompact"}'))
    0

See Also:
    - ``_plans/rewrite-gotchas.md`` - the open question
    - ``tests/fixtures/captured_hooks/README.md`` - how PostCompact was captured
"""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from openbrain.apps.hooks._stub import stub_main

if TYPE_CHECKING:
    from typing import TextIO


def main(stream: TextIO | None = None) -> int:
    """Consume the ``PostCompact`` payload and exit 0 without acting."""
    return stub_main(sys.stdin if stream is None else stream)


if __name__ == "__main__":
    raise SystemExit(main())
