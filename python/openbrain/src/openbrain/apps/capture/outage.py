"""Say it out loud when a turn spools, and say it once -- not once per Stop.

Purpose:
    When Open Brain is unreachable the session KEEPS WORKING and the turn lands
    in the durable spool. That much was already true. What was missing is that
    nobody heard about it: the operator learned of an outage only from the
    ``spool N`` count on the terminal gate line, and an agent mid-session
    learned nothing at all. The operator's ruling on the fail-open split
    (2026-08-03, during the #522 canon review) was **"both are fail"** --
    clarified to: the two error kinds differ only in whether the session
    survives, never in whether anyone hears about it (#536).

Architecture:
    A two-state latch per session, persisted in SQLite, plus the text of the two
    notices. It decides WHETHER to speak; the caller decides WHERE (the hook
    entrypoint writes to stderr, ``apps.hooks.stop``).

    The latch has to be on disk because a ``Stop`` hook is a fresh PROCESS every
    turn -- an in-memory flag would forget the outage between two consecutive
    Stops and re-announce it on every single one, which is exactly the
    per-call nagging the operator forbade. It shares the watermark's database
    file (a separate table) rather than introducing a second store and a second
    config knob: same durability, same locking discipline, one file to reason
    about.

Pattern/Convention:
    A NOTICE IS A STATE CHANGE, NEVER AN EVENT. ``degraded`` is announced on the
    transition healthy -> degraded, and ``recovered`` on degraded -> healthy.
    A second failure inside the same outage returns nothing, and so does an
    ordinary successful Stop in an already-healthy session. A long outage is
    therefore one line, not one line per turn.

    A NOTICE IS NEVER WORTH BREAKING A HOOK FOR. Every method here swallows its
    own storage failures and answers "say nothing", for the same reason
    ``apps.hooks.receipts`` does: this is a note ABOUT the work, and failing the
    turn to protect the note would discard the work. An unwritable latch
    degrades to silence, never to a raise and never to a nag on every Stop.

    THE NOTICE IS CONTENT-FREE. It names the condition and the spool depth, and
    carries no transcript text, no endpoint, no token, and no exception message
    -- the same rule the entrypoints' log lines already follow, and for the same
    reason (an exception's own text can hold the endpoint or the payload).

Example:
    >>> import asyncio, tempfile, pathlib
    >>> async def demo() -> list[str | None]:
    ...     with tempfile.TemporaryDirectory() as directory:
    ...         latch = OutageLatch(pathlib.Path(directory) / "w.db")
    ...         return [
    ...             await latch.note_spooled("s"),   # the outage begins
    ...             await latch.note_spooled("s"),   # still out: silence
    ...             await latch.note_delivered("s"), # it came back
    ...             await latch.note_delivered("s"), # healthy: silence
    ...         ]
    >>> asyncio.run(demo())
    ['open-brain unreachable - turn held for replay', None, \
'open-brain reachable again - held turns replayed', None]

See Also:
    - ``openbrain.apps.hooks.stop`` - the entrypoint that prints these
    - ``docs/decisions/capture-never-drops-a-turn.md`` - why the turn survives
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
from contextlib import closing
from pathlib import Path

from loguru import logger

#: How long a writer waits for another process's lock, matching the watermark
#: store this shares a file with. See ``watermark.LOCK_WAIT_SECONDS``.
LOCK_WAIT_SECONDS = 30.0

#: The line printed when a session's writes START failing.
#:
#: Content-free and bounded. It names the condition and what happened to the
#: turn -- "held for replay", not "lost" -- because the turn IS durable and an
#: operator reading this must not think otherwise.
#:
#: "held", not "spooled", is deliberate and is the honest word for THIS lane.
#: The capture factory builds its ``AgentMemory`` with no spool
#: (``apps.hooks.session._started_memory``), so a failed capture write does not
#: land in the JSONL spool at all: it survives because the watermark is not
#: advanced, and the next Stop re-reads the same region
#: (``apps.capture.deliver``, and ``docs/decisions/capture-never-drops-a-turn.md``).
#: Saying "spooled" here would send an operator to check a file that has no row
#: for this turn. The spool depth is still reported alongside when it is
#: readable, because the sibling provider writes (checkpoint, event) DO spool
#: and a nonzero depth is the other half of the same outage.
DEGRADED_NOTICE = "open-brain unreachable - turn held for replay"

#: The line printed when a session's writes start LANDING again.
#:
#: The bookend. Without it a session that saw the outage notice has no way to
#: learn the outage ended, so the operator is left assuming they are still
#: degraded for the rest of the session.
RECOVERED_NOTICE = "open-brain reachable again - held turns replayed"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS capture_outage (
    session_key TEXT PRIMARY KEY,
    degraded    INTEGER NOT NULL
)
"""


def spool_notice(notice: str, pending: int | None) -> str:
    """Render one notice, with the spool depth when it is known.

    Args:
        notice: :data:`DEGRADED_NOTICE` or :data:`RECOVERED_NOTICE`.
        pending: How many records are waiting in the spool, or ``None`` when
            the count could not be read.

    Returns:
        The line to print. The depth is appended only when it is genuinely
        known -- an unreadable spool prints no count rather than a ``?`` or a
        guessed ``0``, because a count is the one thing on this line an
        operator would act on.

    Example:
        >>> spool_notice(DEGRADED_NOTICE, 3)
        'open-brain unreachable - turn held for replay (spool: 3)'
        >>> spool_notice(DEGRADED_NOTICE, None)
        'open-brain unreachable - turn held for replay'
        >>> spool_notice(DEGRADED_NOTICE, 0)
        'open-brain unreachable - turn held for replay'
    """
    if not pending:
        return notice
    return f"{notice} (spool: {pending})"


def spool_pending(path: Path | None) -> int | None:
    """Count the records waiting in the provider's durability spool.

    Args:
        path: The spool file, or ``None`` when none is configured.

    Returns:
        The number of JSON-object lines, ``0`` for an absent or empty file, or
        ``None`` when the file exists but could not be read.

    A DELIBERATELY separate counter from ``openbrain_memory.JsonlSpool.status``,
    for the same reason the context-budget gate has its own: this runs inside a
    5-second Stop deadline and must not build a client, parse units, or touch
    the retry-state sidecar to print one number. Counting object lines is what
    the gate already does (``context_budget_gate._read_spool_pending``), so the
    two surfaces report the same figure, and a shape this cheap cannot itself
    become the reason a hook misses its deadline.
    """
    if path is None:
        return 0
    try:
        if not path.exists():
            return 0
        if path.stat().st_size == 0:
            return 0
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    return sum(1 for line in text.split("\n") if _is_json_object_line(line))


def _is_json_object_line(line: str) -> bool:
    """Whether one spool line is a complete JSON object.

    Blanks and truncated fragments are not pending records -- a partially
    written last line is a crash artifact, not a turn waiting to replay.
    """
    if not line.strip():
        return False
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError:
        return False
    return isinstance(parsed, dict)


def default_spool_path() -> Path:
    """Where the provider's durability spool lives, resolved as the gate does.

    Returns:
        ``$OPENBRAIN_SPOOL_PATH`` when set, else
        ``$XDG_STATE_HOME/openbrain-memory/claude-spool.jsonl`` falling back to
        ``~/.local/state``.

    The resolution is copied from ``context_budget_gate`` deliberately rather
    than imported: ``openbrain`` does not depend on ``openbrain_provider``, and
    a wrong path here costs a missing count on one line, never a wrong verdict.
    Empty-string variables fall back rather than resolving to the current
    directory, matching the gate and the receipt path (``receipts.state``).
    """
    configured = os.environ.get("OPENBRAIN_SPOOL_PATH")
    if configured:
        return Path(configured)
    state_home = os.environ.get("XDG_STATE_HOME") or str(
        Path.home() / ".local" / "state"
    )
    return Path(state_home) / "openbrain-memory" / "claude-spool.jsonl"


class OutageLatch:
    """Per-session capture health, remembered across hook processes.

    Args:
        path: The database file, normally the capture watermark's. Its parent
            directory is created on first use.

    Both methods return the line to print, or ``None`` for "say nothing" --
    which is the ordinary answer, since most Stops change no state.
    """

    def __init__(self, path: Path) -> None:
        """Bind the latch to a database file, creating it on first use."""
        self._path = path
        self._ready = False

    async def note_spooled(self, session_key: str) -> str | None:
        """Record that a write failed, and answer whether to announce it.

        Args:
            session_key: Identifies the session, as the watermark keys it.

        Returns:
            :data:`DEGRADED_NOTICE` on the first failure of an outage, or
            ``None`` when this session was already degraded.
        """
        changed = await self._set(session_key, degraded=True)
        return DEGRADED_NOTICE if changed else None

    async def note_delivered(self, session_key: str) -> str | None:
        """Record that a write landed, and answer whether to announce recovery.

        Args:
            session_key: Identifies the session.

        Returns:
            :data:`RECOVERED_NOTICE` when this session was degraded and is not
            any more, or ``None`` for the ordinary healthy Stop.
        """
        changed = await self._set(session_key, degraded=False)
        return RECOVERED_NOTICE if changed else None

    async def is_degraded(self, session_key: str) -> bool:
        """Whether this session's last observed write failed."""
        return await asyncio.to_thread(self._read, session_key)

    async def _set(self, session_key: str, *, degraded: bool) -> bool:
        """Store the new health and report whether it CHANGED.

        The read and the write are one ``BEGIN IMMEDIATE`` transaction, not two
        statements: with two, a second hook process could read the same old
        value between them and both would announce the same transition. Taking
        the write lock up front is what makes "announce once" true across
        processes, and it is the same reason the watermark's own read-then-write
        opens immediate (a DEFERRED transaction cannot upgrade its lock and
        fails instantly, ignoring the busy timeout).
        """
        try:
            return await asyncio.to_thread(self._set_blocking, session_key, degraded)
        except Exception as error:  # noqa: BLE001 -- a notice never breaks a turn
            # Class name only, the entrypoints' content-free convention.
            logger.warning(
                "capture outage latch unwritable ({}); notice suppressed",
                type(error).__name__,
            )
            return False

    def _set_blocking(self, session_key: str, degraded: bool) -> bool:
        """Write the health inside one immediate transaction. On a thread."""
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute(
                    "SELECT degraded FROM capture_outage WHERE session_key = ?",
                    (session_key,),
                ).fetchone()
                # An unknown session is HEALTHY, not degraded: a first Stop that
                # succeeds must be silent, and a first Stop that fails must
                # speak. Defaulting the other way would invert both.
                was_degraded = bool(row[0]) if row is not None else False
                connection.execute(
                    "INSERT INTO capture_outage (session_key, degraded) "
                    "VALUES (?, ?) "
                    "ON CONFLICT(session_key) DO UPDATE SET "
                    "degraded = excluded.degraded",
                    (session_key, int(degraded)),
                )
            except BaseException:
                connection.execute("ROLLBACK")
                raise
            connection.execute("COMMIT")
        return was_degraded != degraded

    def _read(self, session_key: str) -> bool:
        """Read the stored health, answering healthy on any failure."""
        try:
            with closing(self._connect()) as connection:
                row = connection.execute(
                    "SELECT degraded FROM capture_outage WHERE session_key = ?",
                    (session_key,),
                ).fetchone()
        except Exception:  # noqa: BLE001 -- a notice never breaks a turn
            return False
        return bool(row[0]) if row is not None else False

    def _connect(self) -> sqlite3.Connection:
        """Open a configured connection, preparing the database on first use."""
        if not self._ready:
            self._prepare()

        # autocommit=True so the caller owns transaction boundaries; see
        # ``watermark.WatermarkStore._connect`` for the full reasoning.
        return sqlite3.connect(self._path, timeout=LOCK_WAIT_SECONDS, autocommit=True)

    def _prepare(self) -> None:
        """Create the database and this module's table, once per latch object."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with closing(
            sqlite3.connect(self._path, timeout=LOCK_WAIT_SECONDS, autocommit=True)
        ) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(_SCHEMA)
        self._ready = True
