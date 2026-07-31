"""The ``SessionEnd`` hook entrypoint. NOT IMPLEMENTED -- a deliberate stub.

Purpose:
    Fires when a session ends, carrying ``reason``. Captured as a real fixture
    (``tests/fixtures/captured_hooks/SessionEnd.json``); its capability is not
    yet decided for the Python app.

Architecture:
    A stub entrypoint: read stdin, exit 0. See ``apps.hooks._stub`` for the
    shared shape.

Pattern/Convention:
    OPEN QUESTION -- capture advances a per-session watermark on every ``Stop``,
    so whether ``SessionEnd`` needs a final flush, a session close, or nothing
    is undecided. The sibling client's ``close`` releases the server session,
    but whether a hook should call it is a separate decision. Recorded in
    ``_plans/rewrite-gotchas.md``.

Example:
    >>> import io
    >>> main(io.StringIO('{"hook_event_name":"SessionEnd"}'))
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
    """Consume the ``SessionEnd`` payload and exit 0 without acting."""
    return stub_main(sys.stdin if stream is None else stream)


if __name__ == "__main__":
    raise SystemExit(main())
