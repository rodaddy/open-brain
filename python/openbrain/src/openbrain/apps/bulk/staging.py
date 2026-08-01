"""The SQLite staging store: whole file in, each turn pops off and yields.

Purpose:
    The bulk ingester loads a giant file, rejiggers it into ``RawTurn`` rows,
    and yields each one to its caller. Operator, 2026-07-31 02:15: *"big file
    goes in, SQLite... rejiggers it into the proper manner and then pops off and
    yields each output."* This store owns exactly that -- plus the resume and
    quarantine state an operator run needs (`_plans/python-port-sequence.md`
    §TWO APPLICATIONS lines 189-194).

Architecture:
    **SQLite stages it; pydantic shapes it.** Neither is hand-rolled:

        sqlite3 (stdlib)   durable, ordered, resumable staging of parsed turns
        pydantic           the shape of a staged turn, validated at the boundary

    Staging into SQLite rather than holding the parse in a Python list is the
    whole reason this store exists: `read_since(27.4 MB, offset=0)` peaked at
    +90 MB RSS to hold 244 turns in memory (`_plans/python-port-sequence.md`
    line 231). The staging table is the durable rejiggered form; the process
    reads it back one row at a time, so a 27 MB file is not resident as parsed
    objects all at once, and an interrupted run resumes from what was already
    sent rather than re-reading the file.

    This belongs to the BULK app ONLY. The live adapter never stages -- it reads
    a few KB from a watermark to EOF and sends it. Staging is the bulk signature,
    and putting it on the deadline-critical path is exactly the mixing the
    two-applications ruling forbids.

Pattern/Convention:
    A staged turn is sent EXACTLY ONCE across runs. ``mark_sent`` flips a flag,
    and ``pending`` yields only rows not yet sent, so a re-run after an
    interruption resumes rather than re-sends. (The server also de-dupes on
    ``UNIQUE(namespace, turn_uuid)``, so a double-send is a no-op there too --
    but resuming from the store means the second run does not even attempt the
    turns already durable, which is what an operator resume is.)

    A turn the server REJECTS is quarantined, not dropped and not retried
    forever: ``quarantine`` records the turn and the error class so the operator
    can inspect it. Quarantine is the loud-failure half of the operator
    contract -- nothing vanishes.

    Nothing here bounds, shortens, or samples a turn's content. The staged
    ``content`` column is the turn whole; SQLite stores an arbitrarily long TEXT
    value, and this store never truncates one.

Example:
    >>> import tempfile, pathlib
    >>> from openbrain.models.turn import RawTurn
    >>> with tempfile.TemporaryDirectory() as directory:
    ...     store = StagingStore(pathlib.Path(directory) / "stage.db")
    ...     store.stage([RawTurn(turn_uuid="u1", content="hello")])
    ...     [turn.content for turn in store.pending()]
    ['hello']

See Also:
    - `openbrain.apps.bulk.ingest` - the orchestrator that stages then yields
    - `openbrain.apps.capture.watermark` - the live adapter's SQLite store, the
      sibling pattern this follows (stdlib sqlite3 + pydantic, no hand-rolled I/O)
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterable, Iterator
from contextlib import closing
from pathlib import Path

from pydantic import BaseModel, ConfigDict

from openbrain.models.turn import RawTurn

#: How long a writer waits for another process's lock before erroring. Bulk runs
#: are single-operator and rarely concurrent, but staging a 27 MB file is many
#: writes, so the store is written to survive contention rather than assume its
#: absence -- the same reasoning the watermark store documents.
LOCK_WAIT_SECONDS = 30.0

_SCHEMA = """
CREATE TABLE IF NOT EXISTS staged_turn (
    stage_index INTEGER PRIMARY KEY,
    turn_uuid   TEXT NOT NULL,
    turn_json   TEXT NOT NULL,
    sent        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS quarantine (
    turn_uuid   TEXT PRIMARY KEY,
    turn_json   TEXT NOT NULL,
    error       TEXT NOT NULL
);
"""


class StagingCounts(BaseModel):
    """A snapshot of where a staged run stands.

    Attributes:
        staged: Total turns rejiggered into the staging table.
        sent: Turns already delivered to the raw lane and marked, across runs.
        quarantined: Turns the server rejected, held for operator inspection.
    """

    model_config = ConfigDict(frozen=True)

    staged: int
    sent: int
    quarantined: int


class StagingStore:
    """The whole file's parsed turns, staged in SQLite and yielded one by one.

    Args:
        path: The staging database file. Its parent directory is created on
            first use. A stable path is what makes a run RESUMABLE: point a
            re-run at the same file and it continues from the unsent rows.

    Example:
        >>> import tempfile, pathlib
        >>> from openbrain.models.turn import RawTurn
        >>> with tempfile.TemporaryDirectory() as directory:
        ...     store = StagingStore(pathlib.Path(directory) / "s.db")
        ...     store.stage([RawTurn(turn_uuid="u1", content="a")])
        ...     store.counts().staged
        1
    """

    def __init__(self, path: Path) -> None:
        """Bind the store to a database file, creating it on first use."""
        self._path = path
        self._ready = False

    def stage(self, turns: Iterable[RawTurn]) -> int:
        """Rejigger a run of parsed turns into the staging table, in order.

        Args:
            turns: The ``RawTurn`` objects a format adapter produced, in the
                order the file wrote them. Streamed in, so the caller may pass a
                generator over a 27 MB file without holding every turn at once.

        Returns:
            The number of turns staged by this call.

        Each turn is appended after the current highest ``stage_index``, so
        staging is additive and ordered: a resumed or extended run keeps the
        turns already staged and continues the sequence. ``content`` is written
        whole -- the turn is serialised with ``model_dump`` and stored as TEXT,
        never shortened.
        """
        with self._connect() as connection:
            start = self._next_index(connection)
            rows = [
                (
                    start + offset,
                    turn.turn_uuid,
                    turn.model_dump_json(),
                )
                for offset, turn in enumerate(turns)
            ]
            connection.executemany(
                "INSERT INTO staged_turn (stage_index, turn_uuid, turn_json) "
                "VALUES (?, ?, ?)",
                rows,
            )
        return len(rows)

    def pending(self) -> Iterator[RawTurn]:
        """Yield every staged turn not yet marked sent, in stage order.

        Yields:
            Each unsent ``RawTurn``, oldest first. A run iterates this, sends
            each turn, and marks it -- so an interruption leaves the sent ones
            flagged and a re-run picks up exactly the remainder.

        The cursor streams rows from SQLite; the whole staging table is never
        pulled into a list, which is the point of staging a 27 MB file rather
        than holding its parse in memory.
        """
        with self._connect() as connection:
            cursor = connection.execute(
                "SELECT turn_json FROM staged_turn WHERE sent = 0 "
                "ORDER BY stage_index"
            )
            for (turn_json,) in cursor:
                yield RawTurn.model_validate_json(turn_json)

    def mark_sent(self, turn_uuid: str) -> None:
        """Record that a staged turn reached the raw lane.

        Args:
            turn_uuid: The turn just delivered. Flipping its ``sent`` flag is
                what makes the next run skip it -- the operator's resume.
        """
        with self._connect() as connection:
            connection.execute(
                "UPDATE staged_turn SET sent = 1 WHERE turn_uuid = ?",
                (turn_uuid,),
            )

    def quarantine(self, turn: RawTurn, error: str) -> None:
        """Set a rejected turn aside for inspection, whole, with its error.

        Args:
            turn: The turn the server would not accept.
            error: The failure's CLASS name, never a value -- the same
                content-free discipline the live adapter's swallow keeps, so no
                turn text or token is written into the quarantine record.

        A quarantined turn is neither dropped nor retried forever: it is held
        so the operator can act, which is the loud-failure half of the bulk
        contract. Re-quarantining the same ``turn_uuid`` replaces the record.
        """
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO quarantine (turn_uuid, turn_json, error) "
                "VALUES (?, ?, ?) "
                "ON CONFLICT(turn_uuid) DO UPDATE SET "
                "turn_json = excluded.turn_json, error = excluded.error",
                (turn.turn_uuid, turn.model_dump_json(), error),
            )

    def quarantined(self) -> Iterator[tuple[RawTurn, str]]:
        """Yield every quarantined turn with the error class that set it aside.

        Yields:
            ``(turn, error)`` pairs, so an operator run can report exactly what
            the server rejected and why.
        """
        with self._connect() as connection:
            cursor = connection.execute(
                "SELECT turn_json, error FROM quarantine ORDER BY turn_uuid"
            )
            for turn_json, error in cursor:
                yield RawTurn.model_validate_json(turn_json), str(error)

    def counts(self) -> StagingCounts:
        """Return where the run stands: staged, sent, and quarantined totals."""
        with self._connect() as connection:
            staged, sent = connection.execute(
                "SELECT COUNT(*), COALESCE(SUM(sent), 0) FROM staged_turn"
            ).fetchone()
            (quarantined,) = connection.execute(
                "SELECT COUNT(*) FROM quarantine"
            ).fetchone()
        return StagingCounts(
            staged=int(staged), sent=int(sent), quarantined=int(quarantined)
        )

    def _next_index(self, connection: sqlite3.Connection) -> int:
        """The stage index one past the highest staged so far.

        Zero for an empty table, so staging into a fresh store starts at 0 and a
        resumed run continues the sequence rather than colliding on the primary
        key.
        """
        (highest,) = connection.execute(
            "SELECT MAX(stage_index) FROM staged_turn"
        ).fetchone()
        return 0 if highest is None else int(highest) + 1

    def _connect(self) -> sqlite3.Connection:
        """Open the database, creating the file and schema once.

        WAL mode lets a reader (``pending``) run alongside a writer, and the busy
        timeout waits out a lock rather than erroring instantly -- the same
        durability the watermark store configures. The connection is returned as
        a context manager so each operation is one committed transaction.
        """
        if not self._ready:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with closing(self._open()) as connection:
                connection.executescript(_SCHEMA)
            self._ready = True
        return self._open()

    def _open(self) -> sqlite3.Connection:
        """Open a configured connection to the staging database."""
        connection = sqlite3.connect(
            self._path, timeout=LOCK_WAIT_SECONDS, isolation_level=None
        )
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute(f"PRAGMA busy_timeout = {int(LOCK_WAIT_SECONDS * 1000)}")
        return connection
