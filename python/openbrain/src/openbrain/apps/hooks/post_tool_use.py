"""The ``PostToolUse`` hook entrypoint. NOT IMPLEMENTED -- a deliberate stub.

Purpose:
    Fires after a tool runs, carrying ``tool_name``, ``tool_input``,
    ``tool_response``, ``tool_use_id``, and ``duration_ms``. Captured as a real
    fixture (``tests/fixtures/captured_hooks/PostToolUse.json``); its capability
    is not yet decided for the Python app.

Architecture:
    A stub entrypoint: read stdin, exit 0. See ``apps.hooks._stub`` for the
    shared shape.

Pattern/Convention:
    OPEN QUESTION -- tool input and output are the ~96% of ``ob_raw_turns`` that
    ``capture-never-drops-a-turn.md`` explicitly leaves UNDECIDED (memory versus
    observability). Whether ``PostToolUse`` should capture that stream, and
    where it should land, is exactly that open decision -- do not resolve it by
    accident here. Recorded in ``_plans/rewrite-gotchas.md``.

Example:
    >>> import io
    >>> main(io.StringIO('{"hook_event_name":"PostToolUse"}'))
    0

See Also:
    - ``_plans/rewrite-gotchas.md`` - the open question
    - ``docs/decisions/capture-never-drops-a-turn.md`` - "what counts as the
      conversation", still open
"""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from openbrain.apps.hooks._stub import stub_main

if TYPE_CHECKING:
    from typing import TextIO


def main(stream: TextIO | None = None) -> int:
    """Consume the ``PostToolUse`` payload and exit 0 without acting."""
    return stub_main(sys.stdin if stream is None else stream)


if __name__ == "__main__":
    raise SystemExit(main())
