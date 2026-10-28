"""Ship captured turns to the observation sink, then advance its own watermark.

Purpose:
    The SECOND destination for captured turns (#523). The same transcript the
    raw lane reads is also emitted to the fleet Langfuse server as content-ful
    session traces, so a session can be replayed and debugged in an observation
    UI. Open Brain remains the memory authority; this lane is the flight
    recorder.

Architecture:
    The same spine shape as ``deliver``, run against the sink's OWN watermark
    key: read forward from the recorded position, hand the turns to the
    emitter, advance only after the emitter returns. The two lanes share the
    reader and the store but NOT a position -- an observation failure must not
    hold back memory, and a memory failure must not hold back observation, so
    each lane retries from its own watermark independently
    (``docs/decisions/capture-never-drops-a-turn.md`` applied per lane; the
    subagent spine already set the precedent of a second key over the same
    store, ``apps.hooks.session.SubagentStopHook.watermark_key``).

    The emitter is a Protocol, like the raw lane's
    (:class:`~openbrain.apps.capture.deliver.RawLane`): tests hand in a
    recorder, the wiring hands in the real Langfuse client.

Pattern/Convention:
    REDACT BEFORE EMITTING. The raw lane sends turns untouched because the
    Open Brain server owns redaction (``apps/capture/__init__.py``); Langfuse
    is a third-party server that redacts nothing, so this module masks
    secret-shaped values client-side with the existing
    :func:`~openbrain.apps.capture.redaction.redact` before anything leaves
    the process. The turn itself is never dropped -- masking, not rejection.

    Nothing here samples or shortens. Every turn the reader returns is
    emitted.

See Also:
    - ``openbrain.apps.capture.deliver`` - the raw-lane spine this mirrors
    - ``openbrain.apps.capture.langfuse_emitter`` - the real emitter
    - ``openbrain.config.ObservationSettings`` - the sink's coordinates
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Protocol

from pydantic import BaseModel, ConfigDict

from openbrain.apps.capture.redaction import redact
from openbrain.apps.capture.transcript import read_since

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path

    from openbrain.apps.capture.watermark import WatermarkStore
    from openbrain.config import ObservationSettings
    from openbrain.models.turn import RawTurn

#: Prefix distinguishing the observation lane's watermark from the raw lane's,
#: over the same store and the same transcript. A colon cannot appear in a
#: Claude Code session id (a UUID), so the prefixed key can never collide with
#: a raw-lane key.
OBSERVE_KEY_PREFIX = "observe:"


class ObservationEmitter(Protocol):
    """The single call this module needs from an observation client.

    Synchronous, like :class:`~openbrain.apps.capture.deliver.RawLane`, and run
    in a worker thread by the spine for the same reason.
    """

    def emit(self, session_key: str, turns: Sequence[RawTurn]) -> None:
        """Send one delivery's turns as a trace; raise on failure.

        A raise is the contract: the spine advances the watermark only when
        this returns, so an exception is what makes the next Stop retry.
        """
        ...


class ObservationDelivery(BaseModel):
    """What one observation delivery did.

    Attributes:
        emitted: Count of turns handed to the emitter. Zero is ordinary -- a
            Stop with nothing new since the observation watermark.
        next_offset: The byte position the observation watermark now holds.
    """

    model_config = ConfigDict(frozen=True)

    emitted: int
    next_offset: int


def observation_active(settings: ObservationSettings) -> bool:
    """Whether the sink is enabled AND has every coordinate it needs.

    Use-time enforcement, the same posture as capture and canon: the settings
    section loads with everything optional, and the decision to decline lives
    here, where the caller can skip the sink without logging an error --
    an unconfigured observer is an ordinary state, not a failure.
    """
    return (
        settings.enabled
        and settings.endpoint is not None
        and settings.public_key is not None
        and settings.secret_key is not None
    )


async def observe_new_turns(
    path: Path,
    session_key: str,
    store: WatermarkStore,
    emitter: ObservationEmitter,
) -> ObservationDelivery:
    """Emit every turn written since the observation watermark, then advance it.

    Args:
        path: The session's transcript file -- the same file the raw lane
            reads.
        session_key: The session's key as the RAW lane knows it. The
            observation position is stored under :data:`OBSERVE_KEY_PREFIX`
            plus this key; the emitter receives the key unprefixed, so the
            trace groups under the real session.
        store: The same watermark store the raw lane uses.
        emitter: The observation client, or a test recorder.

    Returns:
        An :class:`ObservationDelivery`.

    Raises:
        Whatever the emitter or the reader raises. The watermark is NOT
        advanced in that case, so the same turns are re-emitted by the next
        delivery -- the retry is the watermark, exactly as in the raw lane.
    """
    watermark_key = OBSERVE_KEY_PREFIX + session_key
    position = await store.position_for(watermark_key)
    read = await read_since(path, position.offset, position.identity)

    if read.turns:
        # Masked HERE, not in the emitter, so no emitter -- real or future --
        # can forget it. The copy leaves the original turns untouched; the raw
        # lane's delivery reads the transcript independently anyway.
        masked = tuple(
            turn.model_copy(update={"content": redact(turn.content)})
            for turn in read.turns
        )
        # The emitter is synchronous; a thread keeps this coroutine's caller
        # responsive, matching the raw lane's call shape.
        await asyncio.to_thread(emitter.emit, session_key, masked)

    # identity is None only when the file was unreadable; same rule as the raw
    # lane -- overwriting a stored identity with None would disable
    # replaced-file detection for the next read.
    if read.identity is not None:
        await store.advance(watermark_key, read.next_offset, read.identity)

    return ObservationDelivery(emitted=len(read.turns), next_offset=read.next_offset)
