"""The ``ob-guard`` console script: the ``PreToolUse`` guard entrypoint.

Purpose:
    Read one hook payload from stdin, ask ``guard`` for a verdict, write it to
    stdout, exit 0. Replaces ``bun _ob/scripts/ob-memory-provider/guard.ts``
    with a stable command name, per the epic's "Home and shape" section
    (``_plans/issues/409-*.md``), which names ``ob-guard`` as one of the four
    console scripts that retire the hardcoded paths.

Architecture:
    An entrypoint and nothing else -- parse stdin, call one capability, write
    stdout. No business logic here; the decision is entirely ``guard.py``'s.

Pattern/Convention:
    ALWAYS EXIT 0, ALWAYS FAIL OPEN. The block is expressed in the stdout
    payload, never in the exit code, and any unexpected failure writes nothing
    rather than taking out unrelated tool use. ``guard.ts:487-493`` swallows
    its own errors for exactly this reason and says so in a comment; that is a
    documented intentional fail-open, not a bare except by accident.

    Reads at most ``MAX_INPUT_BYTES + 1`` bytes: one byte past the threshold is
    all the verdict needs, and it means a huge payload cannot make the hook sit
    reading inside the operator's 5-second timeout. ``guard.ts:471-485``.

    Not registered in ``openbrain.apps.hooks``. The capture app's
    ``PreToolUse`` module is a deliberate stub whose docstring says not to
    conflate observation with enforcement; this guard is the separate
    enforcement tool that stub refers to. Keeping them apart is what leaves
    open-brain#451 open.

Example:
    >>> import io
    >>> main(io.BytesIO(b'{"tool_name":"Read"}'), io.StringIO())
    0

See Also:
    - ``guard`` - the verdict
    - open-brain#451 - the OPEN observation-vs-enforcement decision
"""

from __future__ import annotations

import sys
from typing import IO, TextIO

from openbrain_provider.guard import MAX_INPUT_BYTES, guard_claude_command


def read_bounded_stdin(stream: IO[bytes]) -> bytes:
    """Read up to one byte past the parse threshold from ``stream``.

    Args:
        stream: The binary stream to read, normally ``sys.stdin.buffer``.

    Returns:
        The bytes read. Never more than ``MAX_INPUT_BYTES + 1``, which is
        enough for the verdict because the guard only needs to know that the
        payload exceeded the threshold, not by how much.
    """
    return stream.read(MAX_INPUT_BYTES + 1) or b""


def main(stream: IO[bytes] | None = None, out: TextIO | None = None) -> int:
    """Run the guard over one hook payload.

    Args:
        stream: Binary input; defaults to ``sys.stdin.buffer``.
        out: Text output; defaults to ``sys.stdout``.

    Returns:
        Always 0. A blocked call is expressed in stdout, and any failure is
        swallowed so the guard cannot break unrelated tool use.
    """
    try:
        source = sys.stdin.buffer if stream is None else stream
        sink = sys.stdout if out is None else out
        sink.write(guard_claude_command(read_bounded_stdin(source)))
        sink.flush()
    except Exception:  # noqa: BLE001 - intentional: see the module docstring.
        # The guard is deliberately narrow and does not break unrelated tool
        # use. Mirrors `guard.ts:487-493`, which swallows for the same reason.
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
