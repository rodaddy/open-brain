"""Domain vocabulary, imported from `openbrain-memory` rather than redeclared.

There is no vocabulary defined in this module and there must never be one. The
provider validates the same event types the memory package does, so it consumes
that package's definition through the workspace dependency; a second literal
here would be a fourth copy of a set that has already drifted once in this
codebase.

That drift is the reason this module exists. `question` was valid in the Python
package and missing from the TypeScript adapter, and the mismatch surfaced as
nothing at all: sending an event type the other side did not know about
produced exit 0, no output, and no row. For a memory write that is the worst
available failure, because the caller has every reason to believe it worked.

`openbrain_memory.EVENT_TYPES` is the definition. Six surfaces necessarily
restate it -- Python, the TS client, the TS server, the MCP tool schema, the
tiering union, the SQL CHECK constraint -- because no single literal can be
shared across those languages. Those are held together by
`test_event_vocabulary.py` in the memory package, which fails if any one of
them adds or drops a value. This module is the one place that does NOT need
that guard, because it does not restate anything.
"""

from __future__ import annotations

from typing import Final

from openbrain_memory import EVENT_TYPES as _MEMORY_EVENT_TYPES

#: Accepted session-event types.
#:
#: Re-exported, not redefined: this name is an alias for
#: `openbrain_memory.EVENT_TYPES` and is `frozenset` only to make the provider's
#: copy immutable at the boundary. Adding a value means editing the memory
#: package (and the CHECK constraint alongside it), never editing this file.
EVENT_TYPES: Final[frozenset[str]] = frozenset(_MEMORY_EVENT_TYPES)


def is_valid_event_type(value: str) -> bool:
    """True when `value` is an accepted session-event type.

    A predicate rather than a bare set membership check at each call site, so
    the rejection path has one place to grow a named reason (#413) instead of
    nine scattered `in` tests.
    """
    return value in EVENT_TYPES


__all__ = ["EVENT_TYPES", "is_valid_event_type"]
