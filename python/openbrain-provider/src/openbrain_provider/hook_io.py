"""The hook wire protocol: stdin JSON in, verdict JSON out, exit code.

Purpose:
    Both gates speak one protocol, so it is defined once here instead of twice.
    A hook is handed its event as JSON on stdin and answers on stdout; this
    module is the only place in the package that touches either.

Architecture:
    No decisions live here. It reads, it writes, it returns. The gates decide.
    The shape follows ``openbrain.apps.hooks`` in the sibling package -- a
    ``main(stream) -> int`` entrypoint taking its stream so tests drive it with
    an in-memory buffer -- so the two packages' hooks read the same way.

Pattern/Convention:
    Three rules, each of which has already cost a session when broken.

    STDIN IS FAIL-OPEN. Absent, empty, or malformed stdin yields an empty
    event. A hook that raised on bad stdin would take the turn down with it,
    and a gate exists to shape a turn, not to end one.

    STDOUT IS THE RETURN CHANNEL. Nothing but the verdict goes there. Log
    records go to a file or stderr (``observability``); one stray line on
    stdout is a corrupted response, not noise.

    AN ALLOW IS SILENCE. Both runtimes treat empty stdout as allow, and a
    top-level ``decision: "allow"`` is INVALID and makes the hook report a JSON
    failure (``policy-refresh-gate.ts:502-505``). So an allowance emits nothing.

Example:
    >>> import io
    >>> read_hook_event(io.StringIO('{"session_id":"s1"}')).session_id
    's1'
    >>> read_hook_event(io.StringIO("not json")).session_id
    ''

See Also:
    - ``python/openbrain/tests/fixtures/captured_hooks/README.md`` - the
      captured proof that empty stdout with exit 0 is the accepted response
"""

from __future__ import annotations

import json
import sys
from typing import TYPE_CHECKING, Any, Final

if TYPE_CHECKING:
    from typing import TextIO

__all__ = [
    "HookEvent",
    "emit",
    "emit_json",
    "read_hook_event",
]

#: Compact separators, matching ``JSON.stringify`` with no spacing. The verdicts
#: are compared byte-for-byte against recordings of the TypeScript gates, so the
#: spelling is part of the contract, not a formatting preference.
_COMPACT: Final[tuple[str, str]] = (",", ":")


class HookEvent(dict[str, Any]):
    """One hook invocation's parsed stdin.

    A dict subclass rather than a model: the harness adds fields between
    releases, and a strict model would reject an event the gate could otherwise
    handle. The accessors read the fields this package uses and coerce
    defensively, so a field arriving with the wrong type reads as absent rather
    than raising.
    """

    @property
    def session_id(self) -> str:
        """Return the session id, or an empty string."""
        value = self.get("session_id")
        return value if isinstance(value, str) else ""

    @property
    def transcript_path(self) -> str:
        """Return the transcript path, or an empty string."""
        value = self.get("transcript_path")
        return value if isinstance(value, str) else ""

    @property
    def cwd(self) -> str:
        """Return the working directory, or an empty string."""
        value = self.get("cwd")
        return value if isinstance(value, str) else ""

    @property
    def source(self) -> str:
        """Return the SessionStart source, or an empty string."""
        value = self.get("source")
        return value if isinstance(value, str) else ""

    @property
    def tool_name(self) -> str:
        """Return the tool name, accepting either spelling the runtimes send."""
        for key in ("tool_name", "toolName"):
            value = self.get(key)
            if isinstance(value, str) and value:
                return value
        return ""

    @property
    def tool_input(self) -> dict[str, Any]:
        """Return the tool arguments, accepting either spelling."""
        for key in ("tool_input", "toolInput"):
            value = self.get(key)
            if isinstance(value, dict):
                return value
        return {}


def read_hook_event(stream: TextIO | None = None) -> HookEvent:
    """Read and parse the hook's stdin.

    Args:
        stream: Text stream to read. Defaults to ``sys.stdin``.

    Returns:
        The parsed event, or an empty one. Every failure -- no stdin, a closed
        pipe, empty input, malformed JSON, or a JSON scalar where an object was
        expected -- is the same answer, because in all of them the gate has no
        event to act on and must not break the turn.
    """
    source = sys.stdin if stream is None else stream
    try:
        text = source.read()
    except (OSError, ValueError):
        return HookEvent()
    if not isinstance(text, str) or not text.strip():
        return HookEvent()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return HookEvent()
    return HookEvent(parsed) if isinstance(parsed, dict) else HookEvent()


def emit(text: str, stream: TextIO | None = None) -> None:
    """Write one line to the hook's return channel.

    Args:
        text: The line. An empty string writes NOTHING -- an allowance is
            silence, and a bare newline is not silence.
        stream: Text stream to write to. Defaults to ``sys.stdout``.
    """
    if not text:
        return
    target = sys.stdout if stream is None else stream
    target.write(f"{text}\n")
    target.flush()


def emit_json(payload: dict[str, Any], stream: TextIO | None = None) -> None:
    """Write one compact JSON verdict to the return channel.

    Args:
        payload: The verdict object.
        stream: Text stream to write to. Defaults to ``sys.stdout``.
    """
    emit(json.dumps(payload, separators=_COMPACT, ensure_ascii=False), stream)
