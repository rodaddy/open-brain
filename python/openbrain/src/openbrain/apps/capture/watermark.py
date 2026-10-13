"""Remember how far into a transcript a session has already been read.

Purpose:
    The capture path reads a transcript forward, from where it stopped last time
    to the end of the file. That position is this module's only concern.

Architecture:
    **SQLite stores it; pydantic shapes it.** Neither job is hand-rolled:

        sqlite3 (stdlib)   durability, atomicity, cross-process serialization
        pydantic           the shape of a position, validated at the boundary

    The first version of this module stored JSON and hand-wrote an atomic write
    (staging file + ``os.replace``) with a corrupt-file fallback -- ~60 lines of
    storage mechanics owned by us to keep one integer per session. SQLite is
    stdlib, typed, durable, and inspectable with the `sqlite3` CLI, and it
    deletes all of it.

    **How this is actually invoked, verified 2026-07-31:** a `Stop` hook is a
    per-session command with a 5-second timeout in `~/.claude/settings.json`.
    One process, one session, fired when that session's turn ends. Two
    concurrent sessions have DIFFERENT transcripts and DIFFERENT session keys,
    so they write different rows. Read one turn's worth, write, exit.

    An earlier version of this docstring justified SQLite by citing production-host's two
    workers. That was WRONG and is corrected here: those workers
    (`open-brain-worker-1`/`-2`, `src/transport.ts`) are the TypeScript HTTP
    service holding MCP sessions -- a different process on a different host from
    a hook running beside a developer's transcript. ``AGENTS.md:105`` warns in
    that exact line not to size concurrency for one against the other, and this
    module did precisely that.

    Same-key contention is therefore not the expected case. The store is still
    written to survive it, because being wrong about that costs a lost turn and
    the correctness is free -- but nothing here should be read as "this is a
    contention point".

    Chosen over ``diskcache`` deliberately, on evidence rather than taste:
    diskcache pickles values and manages a filesystem directory beside the
    database, has had no release since 2023, and its only typed helpers
    (``diskcache-stubs``, ``typed-diskcache``) come from a single author with no
    production signal -- ``typed-diskcache``'s own documentation says it "hasn't
    been tested". Two dependencies and a pickle layer to store one integer per
    session is not the cheaper choice. SQLite is the most widely deployed
    database in existence, ships with Python, and is typed.

Pattern/Convention:
    The offset only ever moves FORWARD. A watermark that moved backward would
    re-ingest turns already stored; one skipped forward past unread bytes would
    lose them permanently, which is the failure this design exists to end.
    :meth:`WatermarkStore.advance` enforces direction rather than trusting
    callers.

    An unknown session reads as ``0`` -- the beginning of the file -- not as an
    error and not as "the end". A session seen for the first time must have its
    WHOLE transcript ingested, so the safe default reads everything.

    A session's identity is ``(device, inode)`` alongside the path, not the path
    alone. See :class:`FileIdentity`.

Example:
    >>> import asyncio, tempfile, pathlib
    >>> async def demo() -> tuple[int, int]:
    ...     with tempfile.TemporaryDirectory() as directory:
    ...         store = WatermarkStore(pathlib.Path(directory) / "marks.db")
    ...         before = await store.offset_for("session-a")
    ...         await store.advance("session-a", 4096)
    ...         return before, await store.offset_for("session-a")
    >>> asyncio.run(demo())
    (0, 4096)

See Also:
    - ``openbrain.apps.capture.transcript`` - the reader that consumes an offset
    - ``_plans/418-prov-9-hook-entrypoints.md:73`` - why a watermark replaces a
      window
"""

from __future__ import annotations

import asyncio
import sqlite3
from contextlib import closing
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

#: Where a session that has never been read starts: the beginning of the file.
#:
#: NOT the end. A first-time session must have its whole transcript ingested,
#: so the default has to be the position that reads everything.
BEGINNING_OF_FILE = 0

#: How long a writer is willing to wait for another process's lock.
#:
#: SQLite allows ONE writer at a time even in WAL mode -- WAL lets readers run
#: alongside a writer, it does not make writes concurrent. The busy timeout is
#: what prevents `database is locked` when two processes do write at once.
#:
#: IT ONLY APPLIES IF THE TRANSACTION IS OPENED CORRECTLY. A deferred
#: read-then-write transaction fails in 0ms no matter what this value is -- see
#: :meth:`WatermarkStore._advance`. Setting this number is not the same as being
#: protected by it, which is why a test holds a real lock from a real second
#: process rather than trusting the constant.
#:
#: Generous on purpose, and it is not a delay: the wait ends the instant the
#: lock frees, SQLite hands it to the OS scheduler rather than polling, CPython
#: releases the GIL around it, and it runs inside `asyncio.to_thread`. A hook
#: writing one integer holds its lock for microseconds, so this duration is
#: almost never approached.
LOCK_WAIT_SECONDS = 30.0

_SCHEMA = """
CREATE TABLE IF NOT EXISTS watermark (
    session_key TEXT PRIMARY KEY,
    offset      INTEGER NOT NULL,
    device      INTEGER,
    inode       INTEGER
)
"""

_PENDING_SCHEMA = """
CREATE TABLE IF NOT EXISTS pending_capture (
    origin TEXT NOT NULL,
    session_key TEXT NOT NULL,
    transcript_path TEXT NOT NULL,
    device INTEGER,
    inode INTEGER,
    source_size INTEGER,
    state TEXT NOT NULL DEFAULT 'pending',
    failure_category TEXT,
    generation INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (origin, session_key)
)
"""


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


class FileIdentity(BaseModel):
    """Which file on disk a stored offset belongs to.

    A path is not an identity. A transcript can be replaced by a DIFFERENT file
    at the same path -- rename/create rotation -- and an offset into the old one
    means nothing in the new one. ``(device, inode)`` is the identity the
    operating system itself uses, and is what log-shipping tools track for
    exactly this reason.

    Measured 2026-07-31: with identity checked by SIZE alone, replacing a
    3-turn transcript with a 9-turn one silently skipped the first 3 turns of
    the new file -- the reader resumed mid-file because the new file was merely
    bigger than the old offset.
    """

    model_config = ConfigDict(frozen=True)

    device: int = Field(ge=0)
    inode: int = Field(ge=0)

    @classmethod
    def of(cls, path: Path) -> FileIdentity | None:
        """Read the identity of ``path``, or ``None`` when it does not exist."""
        try:
            status = path.stat()
        except OSError:
            return None

        return cls(device=status.st_dev, inode=status.st_ino)


class Position(BaseModel):
    """A stored reading position: how far, and into which file.

    Both halves are required to resume safely. The offset alone answers "how
    far", and answering only that is the defect this model exists to prevent.
    """

    model_config = ConfigDict(frozen=True)

    offset: int = Field(ge=0)
    identity: FileIdentity | None = None

    def belongs_to(self, current: FileIdentity | None) -> bool:
        """Whether this position was recorded against ``current``.

        An unknown identity on either side answers ``True``: a store written
        before identities were recorded, or a file that cannot be stat'd, must
        not silently discard a valid position. The reader still verifies size,
        so the weaker check remains in front of it.
        """
        if self.identity is None or current is None:
            return True

        return self.identity == current


class PendingCapture(BaseModel):
    """A closed session's transcript locator, bound to its capture origin."""

    model_config = ConfigDict(frozen=True)

    session_key: str
    path: Path
    identity: FileIdentity | None
    source_size: int | None
    generation: int
    state: str = "pending"


class WatermarkStore:
    """Per-session reading positions, persisted in SQLite.

    Args:
        path: The database file. Its parent directory is created on first use.

    Example:
        >>> import asyncio, tempfile, pathlib
        >>> async def demo() -> int:
        ...     with tempfile.TemporaryDirectory() as directory:
        ...         store = WatermarkStore(pathlib.Path(directory) / "w.db")
        ...         await store.advance("s", 10)
        ...         await store.advance("s", 25)
        ...         return await store.offset_for("s")
        >>> asyncio.run(demo())
        25
    """

    def __init__(self, path: Path) -> None:
        """Bind the store to a database file, creating it on first use."""
        self._path = path
        self._ready = False

    async def register_pending(
        self, origin: str, session_key: str, path: Path,
        *, watermark_key: str | None = None,
    ) -> PendingCapture:
        """Persist a source locator before any network operation can fail."""
        try:
            status = path.stat()
        except OSError:
            identity = None
            source_size = None
        else:
            identity = FileIdentity(device=status.st_dev, inode=status.st_ino)
            source_size = status.st_size
        return await asyncio.to_thread(
            self._register_pending, origin, session_key, path, (identity, source_size),
            watermark_key,
        )

    async def bind_missing_pending(
        self, origin: str, pending: PendingCapture
    ) -> PendingCapture | None:
        """Bind a previously missing older source once it becomes readable."""
        try:
            status = pending.path.stat()
        except OSError:
            return None
        identity = FileIdentity(device=status.st_dev, inode=status.st_ino)
        return await asyncio.to_thread(
            self._bind_missing_pending, origin, pending, identity, status.st_size
        )

    async def oldest_pending(
        self, origin: str, *, except_session: str
    ) -> PendingCapture | None:
        """Return one retryable older source from exactly this origin."""
        return await asyncio.to_thread(self._oldest_pending, origin, except_session)

    async def complete_pending(
        self, origin: str, session_key: str, generation: int
    ) -> None:
        """Forget a locator only after its delivery has acknowledged."""
        await asyncio.to_thread(self._complete_pending, origin, session_key, generation)

    async def source_changed(
        self, origin: str, session_key: str, generation: int
    ) -> None:
        """Park a missing or replaced source without rebinding its identity."""
        await asyncio.to_thread(self._source_changed, origin, session_key, generation)

    async def has_position(self, session_key: str) -> bool:
        """Check for a legacy unscoped watermark without trusting it."""
        return await asyncio.to_thread(self._has_position, session_key)

    def _register_pending(
        self, origin: str, session_key: str, path: Path,
        source: tuple[FileIdentity | None, int | None],
        watermark_key: str | None,
    ) -> PendingCapture:
        identity, source_size = source
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            prior = connection.execute(
                "SELECT transcript_path, device, inode, source_size, state, generation "
                "FROM pending_capture WHERE origin = ? AND session_key = ?",
                (origin, session_key),
            ).fetchone()
            if identity is None and prior is not None:
                connection.execute("COMMIT")
                saved_path, device, inode, saved_size, _, generation = prior
                saved_identity = (
                    FileIdentity(device=device, inode=inode)
                    if device is not None and inode is not None else None
                )
                return PendingCapture(
                    session_key=session_key, path=Path(saved_path),
                    identity=saved_identity, source_size=saved_size,
                    generation=generation,
                    state="unavailable" if saved_identity else "pending",
                )
            rebound = prior is not None and identity is not None and (
                prior[0] != str(path) or prior[1] != identity.device
                or prior[2] != identity.inode or prior[3] is None
                or prior[3] > source_size or prior[4] != "pending"
            )
            row = connection.execute(
                "INSERT INTO pending_capture "
                "(origin, session_key, transcript_path, device, inode, source_size, state) "
                "VALUES (?, ?, ?, ?, ?, ?, 'pending') "
                "ON CONFLICT(origin, session_key) DO UPDATE SET "
                "generation = generation + 1, "
                "transcript_path = excluded.transcript_path, "
                "device = excluded.device, inode = excluded.inode, "
                "source_size = excluded.source_size, state = 'pending', "
                "failure_category = NULL "
                "RETURNING generation, state, transcript_path, device, inode, source_size",
                (
                    origin,
                    session_key,
                    str(path),
                    identity.device if identity else None,
                    identity.inode if identity else None,
                    source_size,
                ),
            ).fetchone()
            if rebound and watermark_key is not None:
                connection.execute(
                    "DELETE FROM watermark WHERE session_key = ?", (watermark_key,)
                )
            connection.execute("COMMIT")
        assert row is not None
        generation, state, saved_path, device, inode, saved_size = row
        saved_identity = (
            FileIdentity(device=device, inode=inode)
            if device is not None and inode is not None else None
        )
        return PendingCapture(
            session_key=session_key, path=Path(saved_path), identity=saved_identity,
            source_size=saved_size, generation=generation, state=state,
        )

    def _bind_missing_pending(
        self, origin: str, pending: PendingCapture,
        identity: FileIdentity, source_size: int,
    ) -> PendingCapture | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "UPDATE pending_capture SET device = ?, inode = ?, source_size = ?, "
                "generation = generation + 1 WHERE origin = ? AND session_key = ? "
                "AND generation = ? AND state = 'pending' AND device IS NULL "
                "AND inode IS NULL AND source_size IS NULL "
                "RETURNING generation",
                (identity.device, identity.inode, source_size, origin,
                 pending.session_key, pending.generation),
            ).fetchone()
        if row is None:
            return None
        return PendingCapture(
            session_key=pending.session_key, path=pending.path, identity=identity,
            source_size=source_size, generation=row[0],
        )

    def _oldest_pending(
        self, origin: str, except_session: str
    ) -> PendingCapture | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT session_key, transcript_path, device, inode, source_size, generation "
                "FROM pending_capture WHERE origin = ? AND session_key != ? "
                "AND state = 'pending' ORDER BY rowid LIMIT 1",
                (origin, except_session),
            ).fetchone()
        if row is None:
            return None
        session_key, path, device, inode, source_size, generation = row
        identity = (
            FileIdentity(device=device, inode=inode)
            if device is not None and inode is not None else None
        )
        return PendingCapture(
            session_key=session_key, path=Path(path), identity=identity,
            source_size=source_size,
            generation=generation,
        )

    def _complete_pending(self, origin: str, session_key: str, generation: int) -> None:
        with closing(self._connect()) as connection:
            connection.execute(
                "DELETE FROM pending_capture WHERE origin = ? AND session_key = ? "
                "AND generation = ?",
                (origin, session_key, generation),
            )

    def _source_changed(
        self, origin: str, session_key: str, generation: int
    ) -> None:
        with closing(self._connect()) as connection:
            connection.execute(
                "UPDATE pending_capture SET state = 'source_changed', "
                "failure_category = 'source_changed' "
                "WHERE origin = ? AND session_key = ? AND generation = ?",
                (origin, session_key, generation),
            )

    def _has_position(self, session_key: str) -> bool:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT 1 FROM watermark WHERE session_key = ?", (session_key,)
            ).fetchone()
        return row is not None

    async def offset_for(self, session_key: str) -> int:
        """Return the byte offset already read for a session.

        Args:
            session_key: Identifies the session, normally its transcript path or
                session id.

        Returns:
            The stored offset, or :data:`BEGINNING_OF_FILE` for a session never
            seen.
        """
        position = await self.position_for(session_key)
        return position.offset

    async def position_for(self, session_key: str) -> Position:
        """Return the full stored position, identity included.

        Args:
            session_key: Identifies the session.

        Returns:
            The stored :class:`Position`, or one at the beginning of the file
            with no identity when the session is unknown.
        """
        return await asyncio.to_thread(self._position_for, session_key)

    async def advance(
        self,
        session_key: str,
        offset: int,
        identity: FileIdentity | None = None,
    ) -> None:
        """Move a session's watermark forward to ``offset``.

        Args:
            session_key: Identifies the session.
            offset: The new position, at or beyond the current one.
            identity: Which file the offset is into. When it differs from the
                stored identity the file was REPLACED, so ``offset`` is
                accepted at any value -- a new file has its own positions and
                the forward-only rule does not span two files.

        Raises:
            WatermarkRegressionError: ``offset`` is behind the stored position
                for the same file.
            pydantic.ValidationError: ``offset`` is negative.
        """
        # Validate BEFORE handing off to a thread, so a bad value raises from
        # the caller's own frame rather than out of a worker.
        position = Position(offset=offset, identity=identity)
        await asyncio.to_thread(self._advance, session_key, position)

    def _position_for(self, session_key: str) -> Position:
        """Return the full stored position, identity included.

        Args:
            session_key: Identifies the session.

        Returns:
            The stored :class:`Position`, or one at the beginning of the file
            with no identity when the session is unknown.
        """
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                "SELECT offset, device, inode FROM watermark WHERE session_key = ?",
                (session_key,),
            ).fetchone()

        if row is None:
            return Position(offset=BEGINNING_OF_FILE)

        offset, device, inode = row
        identity = (
            FileIdentity(device=device, inode=inode)
            if device is not None and inode is not None
            else None
        )
        return Position(offset=offset, identity=identity)

    def _advance(self, session_key: str, proposed: Position) -> None:
        """Write a validated position, blocking. Called on a worker thread.

        Opens with ``BEGIN IMMEDIATE`` because this is a read-then-write
        transaction: it SELECTs the stored offset to enforce the forward-only
        rule, then writes.

        A DEFERRED transaction (sqlite3's default) takes a READ lock on the
        SELECT and then must UPGRADE it to a write lock -- and SQLite refuses to
        WAIT on an upgrade, because two readers each waiting to write is a
        deadlock it cannot resolve. It returns `database is locked` INSTANTLY,
        ignoring the busy timeout completely.

        Measured 2026-07-31 against two real processes: the deferred form failed
        in 0ms, while a plain single write to the same database waited 659ms and
        succeeded. The timeout was doing nothing on the one path it existed to
        protect.

        Taking the write lock up front costs nothing -- this transaction is
        microseconds long -- and makes the timeout apply as intended.
        """
        identity = proposed.identity

        # COMMIT and ROLLBACK are issued as SQL, not via connection.commit():
        # with autocommit=True the Python-level commit()/rollback() are no-ops,
        # so an explicitly-begun transaction would never be committed and would
        # be discarded on close. Verified 2026-07-31 -- every write silently did
        # nothing and offset_for returned 0.
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                self._write_position(connection, session_key, proposed, identity)
            except BaseException:
                connection.execute("ROLLBACK")
                raise
            connection.execute("COMMIT")

    def _write_position(
        self,
        connection: sqlite3.Connection,
        session_key: str,
        proposed: Position,
        identity: FileIdentity | None,
    ) -> None:
        """Check the forward-only rule and write, inside an open transaction."""
        row = connection.execute(
            "SELECT offset, device, inode FROM watermark WHERE session_key = ?",
            (session_key,),
        ).fetchone()

        if row is not None:
            stored_offset, device, inode = row
            stored_identity = (
                FileIdentity(device=device, inode=inode)
                if device is not None and inode is not None
                else None
            )
            same_file = (
                identity is None
                or stored_identity is None
                or stored_identity == identity
            )
            if same_file and proposed.offset < stored_offset:
                raise WatermarkRegressionError(
                    session_key, stored_offset, proposed.offset
                )

        connection.execute(
            "INSERT INTO watermark (session_key, offset, device, inode) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(session_key) DO UPDATE SET "
            "offset = excluded.offset, "
            "device = excluded.device, "
            "inode = excluded.inode",
            (
                session_key,
                proposed.offset,
                identity.device if identity else None,
                identity.inode if identity else None,
            ),
        )

    def _connect(self) -> sqlite3.Connection:
        """Open a configured connection, preparing the database on first use.

        WAL lets a reader run alongside a writer; the busy timeout is what
        prevents `database is locked` when two processes write at once. Both are
        needed -- WAL alone does not make writes concurrent, it only stops
        readers blocking on one.
        """
        if not self._ready:
            self._prepare()

        # autocommit=True so the CALLER decides where a transaction begins.
        # With autocommit=False sqlite3 opens a DEFERRED transaction at connect,
        # which cannot be upgraded under contention (see _advance) and makes an
        # explicit `BEGIN IMMEDIATE` an error. Reads need no transaction at all.
        return sqlite3.connect(
            self._path, timeout=LOCK_WAIT_SECONDS, autocommit=True
        )

    def _prepare(self) -> None:
        """Create the database and its schema, once per store object.

        Runs in autocommit mode because ``PRAGMA journal_mode=WAL`` cannot
        execute inside a transaction -- and WAL is a persistent property of the
        database file, so it only ever needs setting once rather than per
        connection.
        """
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with closing(
            sqlite3.connect(self._path, timeout=LOCK_WAIT_SECONDS, autocommit=True)
        ) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
            connection.execute(_SCHEMA)
            connection.execute(_PENDING_SCHEMA)

        self._ready = True
