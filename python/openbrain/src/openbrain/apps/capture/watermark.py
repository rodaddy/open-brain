"""Remember how far into a transcript a session has already been read.

Purpose:
    The capture path reads a transcript forward, from where it stopped last time
    to the end of the file. That "where it stopped" is a byte offset per session,
    and this module is the only thing that holds it.

Architecture:
    One job: store and retrieve an integer per session key. Nothing here opens a
    transcript, parses a record, or decides what a turn is.

    It is a SEPARATE module because it is the only part of capture holding
    STATE. ``_plans/python-port-sequence.md:385``:

        *"Mixing a cursor into the reader is how 'read the last N entries'
        became untestable without a real transcript, and why the `8` was never
        noticed."*

    Kept apart, the reader takes an offset as an argument and returns a new one,
    so it can be tested with no store at all, and this can be tested with no
    transcript at all.

Pattern/Convention:
    The offset only ever moves FORWARD. A watermark that could move backward
    would re-ingest turns already stored; one that could be skipped forward past
    unread bytes would lose them permanently, which is the failure this whole
    design exists to end. :meth:`WatermarkStore.advance` enforces the direction
    rather than trusting callers.

    An unknown session reads as ``0`` -- the beginning of the file -- not as an
    error and not as "the end". A session seen for the first time must have its
    WHOLE transcript ingested, so the safe default is to read everything.

    Storage is JSON on disk, written atomically. A hook process is short-lived
    and may be killed at any moment; a half-written watermark file that failed
    to parse would send the next read back to ``0`` and duplicate the session.

Example:
    >>> import tempfile, pathlib
    >>> with tempfile.TemporaryDirectory() as directory:
    ...     store = WatermarkStore(pathlib.Path(directory) / "marks.json")
    ...     store.offset_for("session-a")
    ...     store.advance("session-a", 4096)
    ...     store.offset_for("session-a")
    0
    4096

See Also:
    - ``openbrain.apps.capture.transcript`` - the reader that consumes an offset
    - ``_plans/418-prov-9-hook-entrypoints.md:73`` - why a watermark replaces a
      window
"""

from __future__ import annotations

import json
import os
from pathlib import Path

#: Where a session that has never been read starts: the beginning of the file.
#:
#: NOT the end. A first-time session must have its whole transcript ingested,
#: so the default has to be the position that reads everything.
BEGINNING_OF_FILE = 0


class WatermarkRegressionError(ValueError):
    """An offset was advanced to a position behind where it already stood.

    Moving a watermark backward re-reads bytes already ingested, storing every
    turn in them a second time. The caller passed a stale offset -- usually by
    reading the store once, then advancing after another process had already
    moved it.
    """

    def __init__(self, session_key: str, current: int, proposed: int) -> None:
        """Name the session and both positions, so the stale one is visible."""
        super().__init__(
            f"watermark for {session_key!r} cannot move backward: "
            f"stands at {current}, was given {proposed}"
        )


class NegativeOffsetError(ValueError):
    """An offset was given as a negative number.

    A byte offset into a file is never negative. This usually means a length was
    subtracted from a position somewhere upstream.
    """

    def __init__(self, offset: int) -> None:
        """Report the offending value, which is usually a subtraction result."""
        super().__init__(f"byte offset must not be negative, got {offset}")


class WatermarkStore:
    """A per-session byte offset, persisted as JSON.

    Args:
        path: The JSON file holding every session's offset. Its parent directory
            is created on first write.

    Example:
        >>> import tempfile, pathlib
        >>> with tempfile.TemporaryDirectory() as directory:
        ...     store = WatermarkStore(pathlib.Path(directory) / "w.json")
        ...     store.advance("s", 10)
        ...     store.advance("s", 25)
        ...     store.offset_for("s")
        25
    """

    def __init__(self, path: Path) -> None:
        """Bind the store to a file, without touching it until a read or write."""
        self._path = path

    def offset_for(self, session_key: str) -> int:
        """Return the byte offset already read for a session.

        Args:
            session_key: Identifies the session, normally its transcript path or
                session id.

        Returns:
            The stored offset, or :data:`BEGINNING_OF_FILE` for a session never
            seen -- and also for a store that is missing or unreadable, because
            re-reading a transcript duplicates turns while skipping one loses
            them, and only one of those is recoverable.
        """
        return self._load().get(session_key, BEGINNING_OF_FILE)

    def advance(self, session_key: str, offset: int) -> None:
        """Move a session's watermark forward to ``offset``.

        Args:
            session_key: Identifies the session.
            offset: The new position, at or beyond the current one.

        Raises:
            NegativeOffsetError: ``offset`` is below zero.
            WatermarkRegressionError: ``offset`` is behind the stored position.
        """
        if offset < BEGINNING_OF_FILE:
            raise NegativeOffsetError(offset)

        marks = self._load()
        current = marks.get(session_key, BEGINNING_OF_FILE)
        if offset < current:
            raise WatermarkRegressionError(session_key, current, offset)

        marks[session_key] = offset
        self._save(marks)

    def _load(self) -> dict[str, int]:
        """Read every stored offset, treating an unreadable store as empty."""
        try:
            raw = self._path.read_text(encoding="utf-8")
        except (FileNotFoundError, OSError):
            return {}

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {}

        if not isinstance(parsed, dict):
            return {}

        return {
            key: value
            for key, value in parsed.items()
            if isinstance(key, str) and isinstance(value, int)
        }

    def _save(self, marks: dict[str, int]) -> None:
        """Write every offset, atomically.

        A hook process can be killed mid-write. Writing to a temporary file
        beside the target and renaming it means a reader sees either the old
        contents or the new ones, never a truncated file that parses as empty
        and sends the next read back to the beginning.
        """
        self._path.parent.mkdir(parents=True, exist_ok=True)
        staging = self._path.with_suffix(f"{self._path.suffix}.staging")
        staging.write_text(json.dumps(marks, indent=2), encoding="utf-8")
        os.replace(staging, self._path)
