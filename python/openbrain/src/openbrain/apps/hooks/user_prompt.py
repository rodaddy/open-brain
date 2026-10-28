"""The ``UserPromptSubmit`` hook entrypoint. NOT IMPLEMENTED -- a deliberate stub.

Purpose:
    Fires when the operator submits a prompt, carrying ``prompt``, ``prompt_id``,
    and ``permission_mode``. Captured as a real fixture
    (``tests/fixtures/captured_hooks/UserPromptSubmit.json``); its capability is
    not yet decided for the Python app.

Architecture:
    A stub entrypoint: read stdin, exit 0. See ``apps.hooks._stub`` for the
    shared shape.

Pattern/Convention:
    OPEN QUESTION -- capture already stores operator turns from the transcript on
    ``Stop``, so whether this event should ALSO capture the prompt (and risk
    double-storing it) or serve some other purpose is undecided. Recorded in
    ``_plans/rewrite-gotchas.md``; do not resolve it by inference.

Example:
    >>> import io
    >>> main(io.StringIO('{"hook_event_name":"UserPromptSubmit"}'))
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
    """Consume the ``UserPromptSubmit`` payload and exit 0 without acting."""
    return stub_main(sys.stdin if stream is None else stream)


if __name__ == "__main__":
    raise SystemExit(main())
