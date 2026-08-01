"""The ``PreCompact`` hook entrypoint. NOT IMPLEMENTED -- a deliberate stub.

Purpose:
    Fires before a compaction, carrying ``trigger`` (``manual``/``auto``) and
    ``custom_instructions``. Captured as a real fixture
    (``tests/fixtures/captured_hooks/PreCompact.json``); its capability is not
    yet decided for the Python app.

Architecture:
    A stub entrypoint: read stdin, exit 0. See ``apps.hooks._stub`` for the
    shared shape.

Pattern/Convention:
    OPEN QUESTION -- compaction discards context, so a flush before it might be
    wanted; but the spine already captures every ``Stop``, so the turns are
    durable independently of the window being compacted. Whether ``PreCompact``
    needs to do anything is undecided. Its sibling ``PostCompact`` now has a
    module too: a real compaction was forced on 2026-07-31 and it fired, so its
    stdin shape is captured (``tests/fixtures/captured_hooks/PostCompact.json``)
    rather than invented.

Example:
    >>> import io
    >>> main(io.StringIO('{"hook_event_name":"PreCompact"}'))
    0

See Also:
    - ``_plans/rewrite-gotchas.md`` - the open questions, including PostCompact
    - ``tests/fixtures/captured_hooks/README.md`` - why PostCompact is uncaptured
"""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from openbrain.apps.hooks._stub import stub_main

if TYPE_CHECKING:
    from typing import TextIO


def main(stream: TextIO | None = None) -> int:
    """Consume the ``PreCompact`` payload and exit 0 without acting."""
    return stub_main(sys.stdin if stream is None else stream)


if __name__ == "__main__":
    raise SystemExit(main())
