"""Map a verified hook event name to its entrypoint. The table, nothing else.

Purpose:
    One place that says which module runs for which event. A caller with an
    event name and a stream looks it up here and calls it.

Architecture:
    A dict from ``hook_event_name`` to a ``Callable[[TextIO], int]``, the shape
    ``_DOCS/STANDARDS-python.md`` prefers over a chain of
    ``if event == ...`` branches. It holds no event logic of its own -- each
    value is another module's entrypoint. This is the whole file, so a change
    for one event cannot reach another's code by sharing this namespace, which
    was the failure of the 633-line dispatcher being replaced.

Pattern/Convention:
    THE KEYS ARE THE VERIFIED EVENT SET. Every name here has a captured fixture
    proving the event fires (``tests/fixtures/captured_hooks/README.md``).
    ``PostCompact`` was the last uncaptured event; a real compaction was forced
    on 2026-07-31, it fired, and its fixture now proves its stdin shape -- so it
    has a key like every other verified event.

    Only ``Stop`` runs real work; the rest are stubs that drain stdin and exit
    0. The distinction is in the modules, not here -- this file treats them
    identically, which is the point of a table.

Example:
    >>> import io
    >>> ENTRYPOINTS["Stop"](io.StringIO("{}"))
    0
    >>> sorted(ENTRYPOINTS)[0]
    'PostCompact'

See Also:
    - ``tests/fixtures/captured_hooks/README.md`` - the verified event set
    - ``_plans/418-prov-9-hook-entrypoints.md`` - one module per event
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from openbrain.apps.hooks import (
    post_compact,
    post_tool_use,
    pre_compact,
    pre_tool_use,
    session_end,
    session_start,
    stop,
    subagent_stop,
    user_prompt,
)

if TYPE_CHECKING:
    from collections.abc import Callable
    from typing import TextIO

#: Every verified event name, mapped to the entrypoint that handles it.
#:
#: A ``Callable[[TextIO], int]`` per event: given the hook's stdin, run and
#: return the exit code. ``Stop`` delivers to the raw lane; every other value is
#: a stub. The names match ``hook_event_name`` exactly, as the harness sends it.
ENTRYPOINTS: dict[str, Callable[[TextIO], int]] = {
    "SessionStart": session_start.main,
    "UserPromptSubmit": user_prompt.main,
    "Stop": stop.main,
    "SessionEnd": session_end.main,
    "PreToolUse": pre_tool_use.main,
    "PostToolUse": post_tool_use.main,
    "SubagentStop": subagent_stop.main,
    "PreCompact": pre_compact.main,
    "PostCompact": post_compact.main,
}
