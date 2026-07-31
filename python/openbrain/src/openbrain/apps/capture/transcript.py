r"""Read a transcript forward, from a byte offset to the end of the file.

Purpose:
    Given where a session was last read to, return every operator turn written
    since, and the position to resume from next time.

Architecture:
    One job: move forward through bytes. It holds no state -- the offset arrives
    as an argument and leaves as a return value -- and it does not decide what a
    turn means. :mod:`~openbrain.apps.capture.records` parses each line;
    :mod:`~openbrain.apps.capture.watermark` remembers the position between runs.

    This is the module that RETIRES the window. The adapter being replaced read
    the last eight entries of a transcript (``raw-turns.ts:188``) after seeking
    back a fixed distance from the end (``raw-turns.ts:31``). Both exist to guess
    how far back to look; reading forward from a known point needs no guess, so
    neither idea appears here.

    Measured on this repo's own session transcript, 2026-07-31: 225 of 234
    operator turns produced more entries than that window read, and one turn
    produced 1,646. The window was not failing at the edges -- it was failing
    almost every time.

Pattern/Convention:
    THE OFFSET ONLY ADVANCES TO A NEWLINE. A hook can fire while Claude Code is
    still writing a record, so the bytes at the end of a file may be half a JSON
    object. Committing that position would park the next read inside a record and
    corrupt every read after it. The tail is left unconsumed instead, and the
    next read picks it up whole.

    A shortened file is treated as a NEW file and read from the beginning. A
    transcript that got smaller was replaced, so the stored offset points into
    unrelated content -- re-reading duplicates turns, which is recoverable, while
    trusting the stale offset loses them, which is not.

    Nothing here samples, caps, or shortens. Every byte between the offset and
    the last newline is parsed.

Example:
    >>> import asyncio, tempfile, pathlib
    >>> async def demo() -> tuple[int, str]:
    ...     with tempfile.TemporaryDirectory() as directory:
    ...         path = pathlib.Path(directory) / "t.jsonl"
    ...         record = (
    ...             '{"type":"user","uuid":"u1","promptSource":"typed",'
    ...             '"message":{"content":"ok"}}'
    ...         )
    ...         _ = path.write_text(record + chr(10))
    ...         result = await read_since(path, 0)
    ...         return len(result.turns), result.turns[0].content
    >>> asyncio.run(demo())
    (1, 'ok')

See Also:
    - ``openbrain.apps.capture.watermark`` - where ``next_offset`` is kept
    - ``_plans/418-prov-9-hook-entrypoints.md:73`` - the watermark decision
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

from openbrain.apps.capture.records import raw_turn_from_line
from openbrain.apps.capture.watermark import BEGINNING_OF_FILE, FileIdentity
from openbrain.models.turn import RawTurn

#: The byte that ends a complete record.
RECORD_TERMINATOR = b"\n"


@dataclass(frozen=True)
class TranscriptRead:
    """Everything one read produced: the turns, and where to resume.

    Attributes:
        turns: Every operator turn between the requested offset and
            ``next_offset``, in the order written.
        next_offset: The byte position to read from next time -- the end of the
            last COMPLETE record, which is at or before the end of the file.
        identity: Which file was read, so the caller stores the offset against
            it. ``None`` when the file does not exist.
    """

    turns: tuple[RawTurn, ...]
    next_offset: int
    identity: FileIdentity | None = None


async def read_since(
    path: Path, offset: int, identity: FileIdentity | None = None
) -> TranscriptRead:
    """Read every operator turn written to ``path`` since ``offset``.

    Args:
        path: The transcript file.
        offset: The byte position already consumed. ``0`` reads the whole file.
        identity: Which file ``offset`` was recorded against. When it does not
            match the file now at ``path``, the file was REPLACED and the whole
            of the new one is read. Omit it to fall back to the size check
            alone, which catches a shortened file but NOT a replaced one.

    Returns:
        A :class:`TranscriptRead`. For a missing file, an empty result whose
        ``next_offset`` is the offset given -- a transcript can be read before it
        exists, and that is not a failure.

    Example:
        >>> import asyncio, pathlib
        >>> result = asyncio.run(
        ...     read_since(pathlib.Path("/nonexistent/t.jsonl"), 7)
        ... )
        >>> result.turns, result.next_offset
        ((), 7)
    """
    try:
        size = path.stat().st_size
    except OSError:
        return TranscriptRead(turns=(), next_offset=offset)

    current = FileIdentity.of(path)
    start = _start_position(offset, size, identity, current)

    try:
        payload = await asyncio.to_thread(_read_from, path, start)
    except OSError:
        return TranscriptRead(turns=(), next_offset=offset)

    complete, consumed = _complete_records(payload)
    turns = tuple(
        turn
        for line in complete.split(RECORD_TERMINATOR)
        if (turn := raw_turn_from_line(line.decode("utf-8", errors="replace")))
        is not None
    )

    return TranscriptRead(
        turns=turns, next_offset=start + consumed, identity=current
    )


def _read_from(path: Path, start: int) -> bytes:
    """Read ``path`` from ``start`` to the end, blocking.

    Separated so the blocking call is one named thing handed to a worker
    thread. There is no true async file I/O in Python: ``aiofiles`` and
    ``anyio`` both run this same blocking read in a thread pool, so a
    dependency would buy syntax rather than concurrency. ``asyncio.to_thread``
    is the stdlib form of exactly what they do.
    """
    with path.open("rb") as handle:
        handle.seek(start)
        return handle.read()


def _start_position(
    offset: int,
    size: int,
    recorded: FileIdentity | None,
    current: FileIdentity | None,
) -> int:
    """Decide where to begin reading, given what the offset was recorded against.

    Two ways a stored offset can be meaningless, and they need different checks:

    **rename/create** -- the file was replaced by a different one, so the inode
    changes and the size can be anything. Only the identity check catches this.
    Measured 2026-07-31: without it, replacing a 3-turn transcript with a 9-turn
    one silently skipped the new file's first 3 turns.

    **copytruncate** -- the same file was emptied and rewritten, so the identity
    is unchanged and only the size reveals it.

    Either way the answer is to read the whole file. Re-reading duplicates turns,
    which is recoverable downstream; skipping them loses them permanently, which
    is not. Design follows ``ponytail`` and the OpenTelemetry filelog receiver --
    see ``docs/prior-art/ATTRIBUTION.md``.
    """
    replaced = recorded is not None and current is not None and recorded != current
    if replaced or offset > size:
        return BEGINNING_OF_FILE

    return offset


def _complete_records(payload: bytes) -> tuple[bytes, int]:
    """Split off the records that are fully written.

    Args:
        payload: Bytes read from the transcript.

    Returns:
        The complete portion, and its length. A trailing partial record is
        excluded from both, so the next read begins at its first byte and sees
        it whole.
    """
    end = payload.rfind(RECORD_TERMINATOR)
    if end == -1:
        return b"", 0

    return payload[:end], end + len(RECORD_TERMINATOR)
