"""Deliver unread transcript turns to the raw lane, then advance the watermark.

THE SPINE. This module is composition only: the reader reads, the parser
parses, the watermark remembers, and the sibling package
(``openbrain_memory``) writes. If a change here seems to need a retry loop, a
queue, or a batch manager, it belongs to one of those owners instead -- most
likely ``openbrain_memory``, whose spool already makes a failed send durable.

The one rule this module owns is ORDER: the watermark advances only after the
lane call returns. A returned call is a kept turn -- the spool replays what
could not be sent -- so advancing afterwards never walks past an unwritten
turn. Advancing first would be dropping
(``docs/decisions/capture-never-drops-a-turn.md``).

Non-goals: this module does not parse records, judge content, construct
clients, or manage sessions. Building the ``AgentMemory`` and starting its
session is the entrypoint's job (``_plans/python-port-sequence.md``, step 8).
"""

import asyncio
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict

from openbrain.apps.capture.transcript import read_since
from openbrain.apps.capture.watermark import WatermarkStore


class RawLane(Protocol):
    """The single call this module needs from ``openbrain_memory.AgentMemory``.

    A Protocol rather than the class itself, so tests hand in a recorder and
    the entrypoint hands in the real thing, with mypy holding both to the same
    shape. This is a TYPE of the existing write path, not a second
    implementation of it.
    """

    def ingest_raw_turns(self, turns: Sequence[Mapping[str, Any]]) -> object:
        """Full-send a batch of raw turns; the server owns every judgment."""
        ...


class Delivery(BaseModel):
    """What one delivery did: the turns moved, and where reading resumes.

    Attributes:
        delivered: Count of operator turns handed to the lane. Zero is an
            ordinary outcome -- a turn with no operator message in it, or a
            hook firing twice.
        next_offset: The byte position the session's watermark now holds.
    """

    model_config = ConfigDict(frozen=True)

    delivered: int
    next_offset: int


async def deliver_new_turns(
    path: Path,
    session_key: str,
    store: WatermarkStore,
    lane: RawLane,
) -> Delivery:
    """Send every operator turn written since the watermark to the raw lane.

    Args:
        path: The session's transcript file.
        session_key: Identifies the session in the watermark store.
        store: Where this session's read position lives.
        lane: An ``openbrain_memory.AgentMemory`` (or anything matching
            :class:`RawLane`) with its session already started.

    Returns:
        A :class:`Delivery`.

    Raises:
        Whatever ``lane.ingest_raw_turns`` raises. The watermark is NOT
        advanced in that case, so the same turns are re-sent by the next
        delivery and the server's dedupe makes the overlap a no-op.
    """
    position = await store.position_for(session_key)
    read = await read_since(path, position.offset, position.identity)

    if read.turns:
        # turn_index is assigned HERE, not on the model, because the server
        # treats it as a per-invocation counter and recomputes real order from
        # (session_ref, occurred_at) itself (src/tools/ingest-raw-turn.ts,
        # migration 036). It is a fact about this send, not about the turn.
        payload = [
            {**turn.model_dump(exclude_none=True), "turn_index": index}
            for index, turn in enumerate(read.turns)
        ]
        # The client is synchronous; a thread keeps this coroutine's caller
        # responsive, matching how the reader and the watermark do their I/O.
        await asyncio.to_thread(lane.ingest_raw_turns, payload)

    # identity is None only when the file was unreadable; there is nothing to
    # record then, and overwriting a stored identity with None would disable
    # replaced-file detection for the next read.
    if read.identity is not None:
        await store.advance(session_key, read.next_offset, read.identity)

    return Delivery(delivered=len(read.turns), next_offset=read.next_offset)
