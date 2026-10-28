"""The ``PreToolUse`` hook entrypoint. NOT IMPLEMENTED -- a deliberate stub.

Purpose:
    Fires before a tool runs, carrying ``tool_name``, ``tool_input``, and
    ``tool_use_id``. Captured as a real fixture
    (``tests/fixtures/captured_hooks/PreToolUse.json``); its capability is not
    yet decided for the Python app.

Architecture:
    A stub entrypoint: read stdin, exit 0. See ``apps.hooks._stub`` for the
    shared shape.

Pattern/Convention:
    OPEN QUESTION -- this event can gate a tool call (a policy hook), which is a
    different job from capture entirely. Whether the Python capture app owns any
    ``PreToolUse`` behaviour, or whether that belongs to a separate guard, is
    undecided. Recorded in ``_plans/rewrite-gotchas.md``; do not conflate
    observation with enforcement here.

Example:
    >>> import io
    >>> main(io.StringIO('{"hook_event_name":"PreToolUse"}'))
    0

See Also:
    - ``_plans/rewrite-gotchas.md`` - the open question
"""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from openbrain.apps.hooks._stub import stub_main

if TYPE_CHECKING:
    from typing import TextIO


def main(stream: TextIO | None = None) -> int:
    """Consume the ``PreToolUse`` payload and exit 0 without acting."""
    return stub_main(sys.stdin if stream is None else stream)


if __name__ == "__main__":
    raise SystemExit(main())
