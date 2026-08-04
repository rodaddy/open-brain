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

    AND A STATE CHANGE IS RATE-BOUND, because a state change alone is not
    enough. A FLAPPING service changes state on every Stop, so the latch by
    itself still announced on every Stop -- measured 6 notices across 6
    alternating Stops, which is exactly the per-call nagging #536 forbids. After
    a reported outage the latch stays quiet for :data:`FLAP_COOLDOWN_SECONDS`;
    a window opened inside that period is ridden out silently, and because the
    unit of output is the PAIR, its recovery is silent too. The timestamp lives
    in the same row as the state, so the quiet period survives the fresh process
    every Stop gets. Mirrors the server-side tracing tracker (#534).

    THE BOOKEND CARRIES WHAT THE WINDOW COST. Failed Stops are counted while
    degraded, and the recovery line reports the total when it exceeds one, so a
    single blip and a twenty-turn outage do not read identically.

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
    ...             await latch.note_delivered("s"), # it came back: 2 held
    ...             await latch.note_delivered("s"), # healthy: silence
    ...             await latch.note_spooled("s"),   # flapping: inside cooldown
    ...             await latch.note_delivered("s"), # so its bookend is silent
    ...         ]
    >>> asyncio.run(demo())
    ['open-brain unreachable - turn held for replay', None, \
'open-brain reachable again - held turns replayed (2 turns held)', None, None, None]

See Also:
    - ``openbrain.apps.hooks.stop`` - the entrypoint that prints these
    - ``docs/decisions/capture-never-drops-a-turn.md`` - why the turn survives
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import time
from contextlib import closing, suppress
from pathlib import Path
from typing import TYPE_CHECKING

from loguru import logger

if TYPE_CHECKING:
    from collections.abc import Callable

#: How long a writer waits for another process's lock.
#:
#: DELIBERATELY NOT the watermark's 30 s, even though this shares its file. The
#: two have opposite duties: the watermark is DURABILITY -- losing its write
#: re-delivers a turn -- so it is worth waiting for, while this latch is
#: TELEMETRY, and the worst case of not writing it is that a line goes unsaid.
#:
#: The value is bounded by the CALLER, not chosen for comfort. This runs inside
#: the ``Stop`` hook, which has a 5 s deadline and is killed by the harness at
#: 10 s, so a 30 s wait could never be paid: contention would stall the hook
#: until the harness killed it, taking the turn's capture with it -- the exact
#: outcome ``capture-never-drops-a-turn`` forbids, arrived at through the
#: telemetry that was supposed to be free. Measured on the old 30 s value: a
#: held lock kept the hook past its deadline
#: (``tests/test_capture_outage_notice.py``). So the latch waits a fraction of a
#: second, then gives up and says nothing.
LOCK_WAIT_SECONDS = 0.25

#: How long after a REPORTED outage the latch stays quiet about a new one.
#:
#: The latch alone makes a LONG outage one line instead of one per turn, but it
#: does nothing about a FLAPPING service, which changes state on every Stop and
#: therefore announced on every Stop -- measured 6 notices across 6 alternating
#: Stops. That is the per-call nagging the operator forbade in #536: "if you do
#: that every time, you're going to spend most of your time saying hey this
#: isn't working". Flapping is the ORDINARY failure here, not an exotic one:
#: the capture request timeout is 0.7 s with a single attempt, so one slow
#: response is a complete outage-and-recovery pair.
#:
#: 5 minutes is chosen against the TURN cadence, the same way the server-side
#: tracing tracker chose 30 s against its 5 s export cadence (#534,
#: ``server/observability/langfuse-tracing.ts``: ``DEFAULT_FLAP_COOLDOWN_MS``).
#: A ``Stop`` fires on the order of a minute, so this spans a handful of turns:
#: long enough that a flap cannot nag, short enough that a genuinely new outage
#: is still surfaced inside one operator-noticeable interval.
FLAP_COOLDOWN_SECONDS = 300.0

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

#: The recovery line, when the window it closes held more than one failure.
#:
#: The bare bookend says the outage ended; this says what it cost. The figure is
#: the count of FAILED STOPS in the window, which is the part an operator can
#: act on -- a single flap and a twenty-turn outage otherwise end with the same
#: words, and only one of them is worth investigating. Rendered only above one,
#: because "(1 turns held)" on a single blip is noise dressed as detail.
RECOVERED_NOTICE_WITH_COUNT = "{notice} ({failures} turns held)"

#: One stored latch row: ``(degraded, announced_at, failures, announced)``.
#:
#: SQLite hands back whatever the columns hold, so the nullable ones are typed
#: as such and every read below coerces rather than trusting the shape -- a row
#: written by the pre-migration two-column table reads ``None`` for the three
#: new fields, and that is the ordinary case on an existing install, not a
#: corruption.
_StoredRow = tuple[int | None, float | None, int | None, int | None]

_SCHEMA = """
CREATE TABLE IF NOT EXISTS capture_outage (
    session_key   TEXT PRIMARY KEY,
    degraded      INTEGER NOT NULL,
    announced_at  REAL,
    failures      INTEGER NOT NULL DEFAULT 0,
    announced     INTEGER NOT NULL DEFAULT 0
)
"""

#: Columns added after the table shipped, applied to an existing file on open.
#:
#: A migration rather than a rewritten ``_SCHEMA`` because ``CREATE TABLE IF NOT
#: EXISTS`` is a no-op against the table PR #542 already created on this
#: machine: a fresh install would get the new columns and every existing one
#: would keep the two-column table and fail every read. ``ADD COLUMN`` against a
#: column that already exists raises ``OperationalError``, caught per statement,
#: so this is idempotent without needing a version table for one migration.
_MIGRATIONS = (
    "ALTER TABLE capture_outage ADD COLUMN announced_at REAL",
    "ALTER TABLE capture_outage ADD COLUMN failures INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE capture_outage ADD COLUMN announced INTEGER NOT NULL DEFAULT 0",
)


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


def default_spool_path(configured: Path | None = None) -> Path:
    """Where the provider's durability spool lives, resolved as the gate does.

    Args:
        configured: The resolved ``capture.spool_path`` setting, when the caller
            has one. Passing it is preferred over letting this read the
            environment: the variable is a DECLARED field
            (``CaptureSettings.spool_path``), and reading the declared setting is
            what keeps the declaration honest rather than decorative.

    Returns:
        ``configured`` when given, else ``$OPENBRAIN_SPOOL_PATH``, else
        ``$XDG_STATE_HOME/openbrain-memory/claude-spool.jsonl`` falling back to
        ``~/.local/state``.

    The environment fallback remains for callers that have no settings object,
    and the resolution is copied from ``context_budget_gate`` deliberately
    rather than imported: ``openbrain`` does not depend on
    ``openbrain_provider``, and a wrong path here costs a missing count on one
    line, never a wrong verdict. Empty-string variables fall back rather than
    resolving to the current directory, matching the gate and the receipt path
    (``receipts.state``).
    """
    if configured is not None:
        return configured
    from_env = os.environ.get("OPENBRAIN_SPOOL_PATH")
    if from_env:
        return Path(from_env)
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

    def __init__(
        self,
        path: Path,
        *,
        cooldown_seconds: float = FLAP_COOLDOWN_SECONDS,
        now: Callable[[], float] | None = None,
    ) -> None:
        """Bind the latch to a database file, creating it on first use.

        Args:
            path: The database file, normally the capture watermark's.
            cooldown_seconds: The quiet period after a reported outage. Injected
                so a test drives the window without waiting out five real
                minutes.
            now: The clock, as a monotonic-ish seconds reader. Injected for the
                same reason; defaults to :func:`time.time`, which is wall clock
                DELIBERATELY -- the value is persisted and compared ACROSS hook
                processes, and ``monotonic`` is only meaningful within one.
        """
        self._path = path
        self._ready = False
        self._cooldown_seconds = cooldown_seconds
        self._now = time.time if now is None else now

    async def note_spooled(self, session_key: str) -> str | None:
        """Record that a write failed, and answer whether to announce it.

        Args:
            session_key: Identifies the session, as the watermark keys it.

        Returns:
            :data:`DEGRADED_NOTICE` on the first failure of an outage that is
            outside the cooldown window, or ``None`` when this session was
            already degraded OR when a recent outage was announced already.
        """
        return await self._set(session_key, degraded=True)

    async def note_delivered(self, session_key: str) -> str | None:
        """Record that a write landed, and answer whether to announce recovery.

        Args:
            session_key: Identifies the session.

        Returns:
            The recovery line -- carrying the window's failure count when it had
            more than one -- if and only if this session was degraded AND its
            outage was actually announced. ``None`` for the ordinary healthy
            Stop, and for a window that was ridden out silently under the
            cooldown: the unit of output is the PAIR, and a resume whose suspend
            was never printed reads as a recovery from nothing.
        """
        return await self._set(session_key, degraded=False)

    async def is_degraded(self, session_key: str) -> bool:
        """Whether this session's last observed write failed."""
        return await asyncio.to_thread(self._read, session_key)

    async def _set(self, session_key: str, *, degraded: bool) -> str | None:
        """Store the new health and answer with the line to print, if any.

        The read and the write are one ``BEGIN IMMEDIATE`` transaction, not two
        statements: with two, a second hook process could read the same old
        value between them and both would announce the same transition. Taking
        the write lock up front is what makes "announce once" true across
        processes, and it is the same reason the watermark's own read-then-write
        opens immediate (a DEFERRED transaction cannot upgrade its lock and
        fails instantly, ignoring the busy timeout).

        A lock this cannot get in :data:`LOCK_WAIT_SECONDS` degrades to silence.
        That is the whole reason the wait is a fraction of a second: another
        process holding the watermark file must never be able to hold THIS hook
        past its deadline, because a notice is not worth a turn.
        """
        try:
            return await asyncio.to_thread(self._set_blocking, session_key, degraded)
        except Exception as error:  # noqa: BLE001 -- a notice never breaks a turn
            # Class name only, the entrypoints' content-free convention.
            # `OperationalError: database is locked` lands here and is silence,
            # not a raise and not a nag.
            logger.warning(
                "capture outage latch unwritable ({}); notice suppressed",
                type(error).__name__,
            )
            return None

    def _set_blocking(self, session_key: str, degraded: bool) -> str | None:
        """Write the health inside one immediate transaction. On a thread."""
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute(
                    "SELECT degraded, announced_at, failures, announced "
                    "FROM capture_outage WHERE session_key = ?",
                    (session_key,),
                ).fetchone()
                notice, state = self._transition(row, degraded=degraded)
                connection.execute(
                    "INSERT INTO capture_outage "
                    "(session_key, degraded, announced_at, failures, announced) "
                    "VALUES (?, ?, ?, ?, ?) "
                    "ON CONFLICT(session_key) DO UPDATE SET "
                    "degraded = excluded.degraded, "
                    "announced_at = excluded.announced_at, "
                    "failures = excluded.failures, "
                    "announced = excluded.announced",
                    (session_key, *state),
                )
            except BaseException:
                connection.execute("ROLLBACK")
                raise
            connection.execute("COMMIT")
        return notice

    def _transition(
        self, row: _StoredRow | None, *, degraded: bool
    ) -> tuple[str | None, tuple[int, float | None, int, int]]:
        """Decide the line and the next stored state. Pure, so it is testable.

        Args:
            row: The stored ``(degraded, announced_at, failures, announced)``,
                or ``None`` for a session never seen before.
            degraded: What this Stop observed.

        Returns:
            The line to print (or ``None``), and the row to store.
        """
        # An unknown session is HEALTHY, not degraded: a first Stop that succeeds
        # must be silent, and a first Stop that fails must speak. Defaulting the
        # other way would invert both.
        was_degraded = bool(row[0]) if row is not None else False
        announced_at = (
            float(row[1]) if row is not None and row[1] is not None else None
        )
        failures = int(row[2]) if row is not None and row[2] is not None else 0
        announced = bool(row[3]) if row is not None and row[3] is not None else False

        if degraded:
            failures += 1
            if was_degraded:
                # Already inside this outage: silent either way, but keep
                # counting so the recovery line can report the real total.
                return None, (1, announced_at, failures, int(announced))
            # A NEW outage. Announce it only outside the quiet period left by
            # the last announced one; inside it, ride the window out silently
            # and mark it unannounced so its recovery stays silent too.
            if self._within_cooldown(announced_at):
                return None, (1, announced_at, failures, 0)
            return DEGRADED_NOTICE, (1, self._now(), failures, 1)

        if not was_degraded:
            # The ordinary healthy Stop. Nothing changed, nothing to say.
            return None, (0, announced_at, 0, int(announced))
        # Recovered. The window is over and its counter resets either way -- a
        # suppressed window is still a window that ended, and carrying its
        # failures forward would inflate the next reported figure with flaps the
        # operator was deliberately not shown.
        if not announced:
            return None, (0, announced_at, 0, 0)
        return self._recovery_line(failures), (0, announced_at, 0, 0)

    def _recovery_line(self, failures: int) -> str:
        """The bookend, carrying the window's failure count when it had several."""
        if failures > 1:
            return RECOVERED_NOTICE_WITH_COUNT.format(
                notice=RECOVERED_NOTICE, failures=failures
            )
        return RECOVERED_NOTICE

    def _within_cooldown(self, announced_at: float | None) -> bool:
        """Whether an announcement is still too recent to make another.

        A never-announced session is never in cooldown, so the FIRST outage a
        session sees is always reported immediately.
        """
        if announced_at is None:
            return False
        return (self._now() - announced_at) < self._cooldown_seconds

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
            for statement in _MIGRATIONS:
                # The column is already there -- the ordinary case on every run
                # after the first. Narrow suppression: a genuinely broken file
                # still raises out of here and is swallowed by `_set` into
                # silence, never into a nag.
                with suppress(sqlite3.OperationalError):
                    connection.execute(statement)
        self._ready = True
