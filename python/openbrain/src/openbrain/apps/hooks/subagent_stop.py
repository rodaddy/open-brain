"""The ``SubagentStop`` hook entrypoint. NOT IMPLEMENTED -- a deliberate stub.

Purpose:
    Fires when a spawned ``Task`` subagent stops, carrying ``agent_id``,
    ``agent_type``, ``agent_transcript_path``, and ``last_assistant_message``.
    Captured as a real fixture
    (``tests/fixtures/captured_hooks/SubagentStop.json``); its capability is not
    yet decided for the Python app.

Architecture:
    A stub entrypoint: read stdin, exit 0. See ``apps.hooks._stub`` for the
    shared shape.

Pattern/Convention:
    OPEN QUESTION -- a subagent has its OWN ``agent_transcript_path``, so this
    could in principle drive the same spine as ``Stop`` against that transcript.
    Whether subagent turns belong in the same lane, a different namespace, or
    nowhere is undecided, and the old adapter's ``takeover.ts`` is out of scope
    to read (``_plans/python-port-sequence.md``). Recorded in
    ``_plans/rewrite-gotchas.md``.

Example:
    >>> import io
    >>> main(io.StringIO('{"hook_event_name":"SubagentStop"}'))
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
    """Consume the ``SubagentStop`` payload and exit 0 without acting."""
    return stub_main(sys.stdin if stream is None else stream)


if __name__ == "__main__":
    raise SystemExit(main())
