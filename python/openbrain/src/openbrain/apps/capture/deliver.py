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

#: How many turns the server accepts in one ``ingest_raw_turn`` call. The
#: request schema declares ``turns`` as an array whose length the server's Zod
#: validator refuses above this count (``MAX_BATCH`` in
#: ``src/tools/ingest-raw-turn.ts``). A single call carrying more is refused
#: before any row is written -- and EVERY turn in it is refused, not just the
#: excess.
#:
#: This is NOT a bound on what gets remembered: the spine sends ALL unread
#: turns, in as many successive full-send calls as it takes. It is the number
#: the server's own protocol accepts per round trip, so a delivery is broken
#: into runs of this many and each run is a call the server takes. One live
#: transcript held 234 operator turns on 2026-07-31; reading the whole file
#: forward (a first Stop, or after a replaced file resets the read position)
#: routinely produces more than a single call carries. Handing all of them to
#: the server at once would make the server refuse the whole batch, and because
#: the watermark only advances after a call returns, the same region would be
#: re-read and re-refused on every subsequent Stop -- a session wedged forever,
#: every new turn lost. Sending in runs is what keeps that from happening.
SERVER_BATCH = 100


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
        # The server takes SERVER_BATCH turns per call, so an unread region
        # larger than that goes as several successive full-send calls rather
        # than one the server would refuse whole. Every turn still lands; the
        # split is a protocol detail of the round trip, not a decision about
        # what to keep. If any call raises, it propagates and the watermark
        # below is not reached, so the whole region re-reads next Stop -- a
        # re-sent call the server already took is a no-op on
        # UNIQUE(namespace, turn_uuid), which is the same dedupe that makes an
        # ordinary hook double-fire safe.
        #
        # The client is synchronous; a thread keeps this coroutine's caller
        # responsive, matching how the reader and the watermark do their I/O.
        for start in range(0, len(payload), SERVER_BATCH):
            chunk = payload[start : start + SERVER_BATCH]
            await asyncio.to_thread(lane.ingest_raw_turns, chunk)

    # identity is None only when the file was unreadable; there is nothing to
    # record then, and overwriting a stored identity with None would disable
    # replaced-file detection for the next read.
    if read.identity is not None:
        await store.advance(session_key, read.next_offset, read.identity)

    return Delivery(delivered=len(read.turns), next_offset=read.next_offset)
