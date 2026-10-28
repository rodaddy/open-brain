"""The shape every not-yet-implemented hook entrypoint shares.

Purpose:
    Seven verified events have a module but no capability yet. Each must still
    behave like a hook: read stdin, do nothing, exit 0. This is that behaviour,
    named once, so a stub is its docstring plus one call rather than a copied
    body that could drift.

Architecture:
    Not a capability and not on the public surface -- the leading underscore
    says so. It is a within-package helper the stub entrypoints call downward,
    which is allowed; it is not a sibling capability being borrowed across a
    boundary (``apps/__init__``).

Pattern/Convention:
    A stub reads stdin so it consumes the payload the harness sent (an unread
    pipe can wedge the writer) and exits 0 with empty stdout -- the accepted
    "proceed normally" response. It decides nothing about the event, because
    what these events should DO for the Python app is not decided
    (``_plans/rewrite-gotchas.md``).

Example:
    >>> import io
    >>> stub_main(io.StringIO('{"hook_event_name":"SessionStart"}'))
    0

See Also:
    - ``_plans/rewrite-gotchas.md`` - the open question behind each stub
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from typing import TextIO


def stub_main(stream: TextIO) -> int:
    """Consume the payload and report success without acting on it.

    Args:
        stream: The hook's stdin. Read whole and discarded -- a stub draining
            its pipe is the whole behaviour.

    Returns:
        ``0``. Empty stdout with exit 0 is Claude Code's "proceed normally".
    """
    stream.read()
    return 0
