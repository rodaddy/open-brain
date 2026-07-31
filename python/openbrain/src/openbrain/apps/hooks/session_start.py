"""The ``SessionStart`` hook entrypoint. NOT IMPLEMENTED -- a deliberate stub.

Purpose:
    Fires when a session begins (``source`` is ``startup``/``resume``/``clear``/
    ``compact``/``fork``). Captured as a real fixture
    (``tests/fixtures/captured_hooks/SessionStart.json``); its capability is not
    yet decided for the Python app.

Architecture:
    A stub entrypoint: read stdin, exit 0. It builds no client and starts no
    session. See ``apps.hooks._stub`` for the shared shape and why a stub still
    drains its pipe.

Pattern/Convention:
    OPEN QUESTION -- does capture inject startup context here, and if so what?
    The old adapter's ``qmd-startup.ts`` did, but that file is out of scope to
    read (``_plans/python-port-sequence.md``), and whether the Python app should
    reproduce it is undecided. Recorded in ``_plans/rewrite-gotchas.md``; do not
    invent the answer.

Example:
    >>> import io
    >>> main(io.StringIO('{"hook_event_name":"SessionStart"}'))
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
    """Consume the ``SessionStart`` payload and exit 0 without acting."""
    return stub_main(sys.stdin if stream is None else stream)


if __name__ == "__main__":
    raise SystemExit(main())
