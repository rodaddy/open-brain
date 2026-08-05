"""The loud-spool contract (#536): an outage is announced, once, and survived.

The operator's ruling on the fail-open split is **"both are fail"** -- when Open
Brain is unreachable the session KEEPS WORKING and the failure is visibly
reported. Before this, an environment error spooled in silence: the operator
learned of an outage only from the ``spool N`` count on the gate line, and an
agent mid-session learned nothing at all.

What each class here pins, and why it is a separate one:

    the notice FIRES on the unreachable path          -- the whole point
    it does NOT fire on the success path              -- silence is the default
    it does NOT fire twice inside one outage          -- no per-call nagging
    it fires again on RECOVERY, once                  -- the bookend
    capture still never drops a turn, and never       -- fail-open is unchanged
      writes to stdout

The failing lane here is an UNCONFIGURED capture: an instant, deterministic
failure with no socket, so the dedup and state-machine assertions never depend
on network timing. The real environment outage -- a socket that accepts and
never answers -- is proven separately, in
``test_capture_hooks.TestStopSurvivesAStalledEndpointWithinTheDeadline``, which
already owns that fixture and now also asserts the notice. Two failure SHAPES,
one notice path, and neither file grows a second copy of the other's harness.
"""

from __future__ import annotations

import contextlib
import io
import json
import sqlite3
import time
from typing import TYPE_CHECKING

import pytest
from loguru import logger

import openbrain.apps.capture.outage as outage_module
from conftest import (
    LaneUnreachableError,
    RecordingLane,
    operator_line,
    write_lines,
)
from openbrain.apps.capture.outage import (
    DEGRADED_NOTICE,
    RECOVERED_NOTICE,
    OutageLatch,
    default_spool_path,
    spool_notice,
    spool_pending,
)
from openbrain.apps.capture.watermark import WatermarkStore
from openbrain.apps.hooks import stop, subagent_stop
from openbrain.config import (
    CaptureSettings,
    load_capture_settings,
    unknown_prefixed_variables,
)

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path


class FakeClock:
    """A clock a test moves by hand.

    The cooldown is 5 real minutes; sleeping through it would make these tests
    slow AND flaky, and would assert a wall-clock coincidence rather than the
    window. Callable so it drops straight into ``OutageLatch(now=...)``.
    """

    def __init__(self, start: float = 1_000_000.0) -> None:
        """Start at an arbitrary epoch-like value."""
        self._now = start

    def __call__(self) -> float:
        """Read the current time."""
        return self._now

    def advance(self, seconds: float) -> None:
        """Move the clock forward."""
        self._now += seconds


#: The message this module's demotion tests are about.
#:
#: Matched on so the assertions cannot be answered by an UNRELATED line. The
#: hook also logs "observation settings unreadable" at WARNING whenever the test
#: environment carries a prefixed variable the model does not declare, and a
#: bare "was there a WARNING" check reads that as the capture line and passes
#: (or fails) for the wrong reason -- observed while writing these.
CAPTURE_FAILURE_MESSAGE = "Stop capture failed"


@contextlib.contextmanager
def record_log_levels(contains: str) -> Iterator[list[str]]:
    """Collect the loguru LEVELS of matching messages emitted inside the block.

    Args:
        contains: Substring identifying the line under test.

    Levels, not messages: the question these tests ask is how LOUD a line was,
    which is the whole subject of the demotion. A ``DEBUG``-level sink is added
    so the demoted line is still observable -- proving it was demoted rather
    than deleted.
    """
    seen: list[str] = []

    def record(message: object) -> None:
        record_ = message.record  # type: ignore[attr-defined]
        if contains in record_["message"]:
            seen.append(record_["level"].name)

    sink_id = logger.add(record, level="DEBUG")
    try:
        yield seen
    finally:
        logger.remove(sink_id)


def unconfigured(watermark: Path) -> CaptureSettings:
    """Capture with no endpoint or token: the real factory raises immediately.

    A stand-in for "the write did not land", chosen over a socket because it is
    instant and deterministic. The watermark path is real, because the latch's
    own file is derived from it (``outage.latch_path``) and these tests read
    that back.
    """
    return CaptureSettings(watermark_path=watermark)


def reachable(watermark: Path) -> CaptureSettings:
    """Capture whose config is complete -- the lane is supplied by ``healthy``.

    The endpoint values are inert: with ``healthy`` in force the real factory is
    never called, so nothing here is ever dialed. They exist because the section
    requires both before it will build a lane at all.
    """
    return CaptureSettings(
        base_url="http://127.0.0.1:0",
        token="unused",  # noqa: S106 -- not a real secret
        watermark_path=watermark,
    )


class Brain:
    """A switchable stand-in for the service, driving the REAL lane factory.

    ``up`` flips between a lane that accepts a batch and one that raises. That
    switch is what makes a RECOVERY test possible at all: the notice fires on a
    transition, so the same session has to fail and then succeed within one
    test, which two different ``CaptureSettings`` objects cannot express.

    Patched over ``session._started_memory``, the ONE non-test lane factory, so
    ``capture_stop_with`` runs end to end -- payload parse, delivery, latch,
    notice -- with only the network replaced. A socket cannot stand in for the
    healthy side: ``run_stop`` builds and STARTS the lane before it reads the
    transcript, so even a zero-turn delivery dials.
    """

    def __init__(self) -> None:
        """Start reachable; a test flips ``up`` to stage the outage."""
        self.up = True
        self.lane = RecordingLane()

    def ingest_raw_turns(self, turns: object) -> object:
        """Accept the batch, or fail the way an unreachable service does."""
        if not self.up:
            raise LaneUnreachableError
        return self.lane.ingest_raw_turns(turns)


@pytest.fixture
def brain(monkeypatch: pytest.MonkeyPatch) -> Brain:
    """Install :class:`Brain` as the lane factory for one test."""
    import openbrain.apps.hooks.session as session_mod

    service = Brain()

    def factory(_settings: CaptureSettings, _key: str) -> object:
        return session_mod.StartedLane(
            lane=service,  # type: ignore[arg-type]
            close=lambda: None,
        )

    monkeypatch.setattr(session_mod, "_started_memory", factory)
    return service


def stop_payload(transcript: Path | None, session: str = "sess") -> str:
    """One ``Stop`` payload as JSON, with or without a transcript."""
    body: dict[str, object] = {"session_id": session}
    if transcript is not None:
        body["transcript_path"] = str(transcript)
    return json.dumps(body)


class TestTheNoticeFiresWhenTheWriteDoesNotLand:
    """An unreachable brain is SAID OUT LOUD, on stderr, content-free."""

    def test_an_unreachable_lane_writes_the_degraded_notice(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "hear me", session="sess")])
        notices = io.StringIO()

        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)),
            unconfigured(tmp_path / "wm.sqlite"),
            notices=notices,
        )

        assert DEGRADED_NOTICE in notices.getvalue()

    def test_the_notice_carries_no_transcript_content(self, tmp_path: Path) -> None:
        """Content-free: the operator's words never reach the notice line."""
        transcript = tmp_path / "t.jsonl"
        write_lines(
            transcript,
            [operator_line("u1", "SECRET-OUTAGE-SENTINEL", session="sess")],
        )
        notices = io.StringIO()

        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)),
            unconfigured(tmp_path / "wm.sqlite"),
            notices=notices,
        )

        assert "SECRET-OUTAGE-SENTINEL" not in notices.getvalue()


class TestTheNoticeIsSilentWhenNothingChanged:
    """Silence is the default. A notice means a STATE CHANGE, never an event."""

    @pytest.mark.usefixtures("brain")
    def test_a_successful_delivery_says_nothing(self, tmp_path: Path) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "landed", session="sess")])
        notices = io.StringIO()

        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)),
            reachable(tmp_path / "wm.sqlite"),
            notices=notices,
        )

        assert notices.getvalue() == ""

    def test_a_second_failure_in_the_same_outage_says_nothing(
        self, tmp_path: Path
    ) -> None:
        """THE anti-nag test. A long outage is one line, not one line per Stop."""
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "again", session="sess")])
        settings = unconfigured(tmp_path / "wm.sqlite")
        first = io.StringIO()
        second = io.StringIO()

        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)), settings, notices=first
        )
        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)), settings, notices=second
        )

        assert DEGRADED_NOTICE in first.getvalue()
        assert second.getvalue() == ""

    def test_the_latch_survives_a_new_process(self, tmp_path: Path) -> None:
        """The dedup is on DISK, not in memory.

        A ``Stop`` hook is a fresh process every turn. An in-memory flag would
        forget the outage between two consecutive Stops and re-announce it on
        every single one -- exactly the nagging the operator forbade. Rebuilding
        the settings object between calls stands in for that process boundary:
        nothing is carried over in Python except the file.
        """
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "again", session="sess")])
        watermark = tmp_path / "wm.sqlite"
        second = io.StringIO()

        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)),
            unconfigured(watermark),
            notices=io.StringIO(),
        )
        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)),
            unconfigured(watermark),
            notices=second,
        )

        assert second.getvalue() == ""

    def test_an_unparseable_payload_never_announces_an_outage(
        self, tmp_path: Path
    ) -> None:
        """Malformed stdin is a harness defect, not evidence about reachability.

        Announcing from one would put a false outage line on screen every time a
        payload arrived in an unexpected shape, and would then SUPPRESS the real
        notice when the brain actually went down (the latch would already read
        degraded).
        """
        notices = io.StringIO()

        stop.capture_stop_with(
            io.StringIO("not json"),
            unconfigured(tmp_path / "wm.sqlite"),
            notices=notices,
        )

        assert notices.getvalue() == ""


class TestRecoveryIsAnnouncedOnceToo:
    """The bookend: a session told about an outage is told when it ends."""

    def test_a_delivery_after_an_outage_announces_recovery(
        self, tmp_path: Path, brain: Brain
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "lost", session="sess")])
        settings = reachable(tmp_path / "wm.sqlite")
        recovered = io.StringIO()

        brain.up = False
        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)), settings, notices=io.StringIO()
        )
        brain.up = True
        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)), settings, notices=recovered
        )

        assert RECOVERED_NOTICE in recovered.getvalue()

    def test_recovery_is_not_repeated_on_every_healthy_stop(
        self, tmp_path: Path, brain: Brain
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "lost", session="sess")])
        settings = reachable(tmp_path / "wm.sqlite")
        third = io.StringIO()

        brain.up = False
        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)), settings, notices=io.StringIO()
        )
        brain.up = True
        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)), settings, notices=io.StringIO()
        )
        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)), settings, notices=third
        )

        assert third.getvalue() == ""

    def test_a_stop_that_dialed_nothing_never_claims_recovery(
        self, tmp_path: Path
    ) -> None:
        """A no-op Stop is not evidence of health. REGRESSION, found in review.

        A ``Stop`` naming no transcript returns ``None`` from ``run_stop``
        without building a lane, so the service was never contacted. Latching
        that as a successful delivery printed a false all-clear IN THE MIDDLE OF
        A LIVE OUTAGE -- measured before the guard existed -- and worse, it also
        cleared the latch, so the next genuinely failing Stop would announce the
        same outage a second time. Only a delivery that RETURNED proves
        reachability.
        """
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "lost", session="sess")])
        settings = unconfigured(tmp_path / "wm.sqlite")
        after = io.StringIO()

        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)), settings, notices=io.StringIO()
        )
        # No transcript: the hook parses, finds nothing to read, and returns.
        stop.capture_stop_with(
            io.StringIO(stop_payload(None)), settings, notices=after
        )

        assert after.getvalue() == ""

    @pytest.mark.usefixtures("brain")
    def test_a_first_healthy_stop_never_claims_recovery(
        self, tmp_path: Path
    ) -> None:
        """A session that was never degraded has nothing to recover from."""
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "fine", session="sess")])
        notices = io.StringIO()

        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)),
            reachable(tmp_path / "wm.sqlite"),
            notices=notices,
        )

        assert notices.getvalue() == ""


class TestTheNoticeNeverBreaksTheTurn:
    """Fail-open is UNCHANGED. Only the silence goes."""

    def test_stdout_stays_empty_while_the_notice_is_written(
        self, capsys: pytest.CaptureFixture[str], tmp_path: Path
    ) -> None:
        """The Stop verdict channel is untouched.

        Empty stdout with exit 0 is Claude Code's "proceed normally". One line
        there is a corrupted verdict, not a message -- which is precisely why
        the notice goes to stderr.
        """
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "hi", session="sess")])
        notices = io.StringIO()

        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)),
            unconfigured(tmp_path / "wm.sqlite"),
            notices=notices,
        )

        assert capsys.readouterr().out == ""
        assert notices.getvalue() != ""

    def test_the_turn_is_still_held_for_replay(self, tmp_path: Path) -> None:
        """The watermark did not advance, so the next Stop re-reads the turn.

        This is what makes the notice's wording honest: the turn is HELD, not
        lost, and ``capture-never-drops-a-turn`` still holds under the change.
        """
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "must survive", session="sess")])
        watermark = tmp_path / "wm.sqlite"

        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)),
            unconfigured(watermark),
            notices=io.StringIO(),
        )

        assert asyncio_offset(watermark, "sess") == 0

    def test_an_unwritable_latch_degrades_to_silence_not_to_a_raise(
        self, tmp_path: Path
    ) -> None:
        """A notice that cannot be latched is dropped, never raised.

        A DIRECTORY where the latch's file belongs makes every sqlite call fail;
        the hook must still return normally with empty stdout, because this
        function exists to report a failure and must not be able to cause one.

        The directory goes at ``latch_path(watermark)``, NOT at the watermark
        path. Now that the latch has its own file, an unusable WATERMARK path
        leaves it on a perfectly writable sibling -- so the old spelling of this
        test passed while exercising nothing, verified by hand before the path
        was corrected. That is the ``docs/decisions/capture-never-drops-a-turn``
        #447 pattern (a suite encoding the defect as intended behaviour), caught
        here instead of six days later.
        """
        watermark = tmp_path / "wm.sqlite"
        unusable = outage_module.latch_path(watermark)
        unusable.mkdir()
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "hi", session="sess")])

        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)),
            unconfigured(watermark),
            notices=io.StringIO(),
        )
        # No assertion beyond "it returned": the contract is that nothing raised
        # and the session was never touched.

    def test_the_entrypoint_still_exits_zero(self, tmp_path: Path) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "hi", session="sess")])

        assert stop.main(io.StringIO(stop_payload(transcript))) == 0


class TestAFlappingServiceCannotNag:
    """The state-change rule is not enough on its own (#536, fix round 2).

    A LONG outage is one line because the state only changes once. A FLAPPING
    service changes state on EVERY Stop, so the latch alone announced on every
    Stop -- measured 6 notices across 6 alternating Stops before the cooldown
    existed, which is exactly the nagging the operator forbade: "if you do that
    every time, you're going to spend most of your time saying hey this isn't
    working". Flapping is the ORDINARY failure here, not an exotic one: the
    capture request timeout is 0.7s with a single attempt, so one slow response
    is a complete outage-and-recovery pair.

    The clock is injected rather than slept, so these run in microseconds and
    assert the WINDOW rather than a wall-clock coincidence.
    """

    async def test_six_alternating_stops_do_not_produce_six_notices(
        self, tmp_path: Path
    ) -> None:
        """The measured defect, pinned as a count.

        Six alternating Stops inside one cooldown window. Before the fix this
        emitted 6 lines; the contract is that a flap costs ONE reported pair.
        """
        clock = FakeClock()
        latch = OutageLatch(
            tmp_path / "w.db", cooldown_seconds=300.0, now=clock
        )

        spoken: list[str] = []
        for index in range(6):
            # Each Stop is one second after the last: a service flapping far
            # faster than the cooldown.
            clock.advance(1.0)
            notice = await (
                latch.note_spooled("s")
                if index % 2 == 0
                else latch.note_delivered("s")
            )
            if notice is not None:
                spoken.append(notice)

        assert len(spoken) == 2
        assert spoken[0] == DEGRADED_NOTICE
        assert spoken[1].startswith(RECOVERED_NOTICE)

    async def test_the_quiet_period_is_bounded_not_permanent(
        self, tmp_path: Path
    ) -> None:
        """A cooldown that never expired would be a mute button, not a bound.

        A genuinely NEW outage, after the window has passed, must still be
        announced -- otherwise the second real outage of a session is silent.
        """
        clock = FakeClock()
        latch = OutageLatch(
            tmp_path / "w.db", cooldown_seconds=300.0, now=clock
        )

        assert await latch.note_spooled("s") == DEGRADED_NOTICE
        assert await latch.note_delivered("s") == RECOVERED_NOTICE

        clock.advance(301.0)

        assert await latch.note_spooled("s") == DEGRADED_NOTICE

    async def test_a_suppressed_window_stays_silent_on_both_ends(
        self, tmp_path: Path
    ) -> None:
        """The unit of output is the PAIR.

        A recovery whose outage was never printed reads as a recovery from
        nothing, so a window ridden out under the cooldown is silent at both
        ends. Mirrors the server-side tracker's ``suppressed`` flag (#534).
        """
        clock = FakeClock()
        latch = OutageLatch(
            tmp_path / "w.db", cooldown_seconds=300.0, now=clock
        )

        assert await latch.note_spooled("s") == DEGRADED_NOTICE
        assert await latch.note_delivered("s") == RECOVERED_NOTICE

        clock.advance(10.0)

        assert await latch.note_spooled("s") is None
        assert await latch.note_delivered("s") is None

    async def test_the_quiet_period_survives_a_fresh_process(
        self, tmp_path: Path
    ) -> None:
        """A Stop hook is a NEW PROCESS every turn.

        An in-memory cooldown would forget the last announcement between two
        consecutive Stops and re-announce on every one -- the same defect the
        latch itself exists to avoid, reintroduced one layer up. A second
        ``OutageLatch`` over the same file stands in for the next process.
        """
        clock = FakeClock()
        database = tmp_path / "w.db"

        first = OutageLatch(database, cooldown_seconds=300.0, now=clock)
        assert await first.note_spooled("s") == DEGRADED_NOTICE
        assert await first.note_delivered("s") == RECOVERED_NOTICE

        clock.advance(10.0)

        second = OutageLatch(database, cooldown_seconds=300.0, now=clock)
        assert await second.note_spooled("s") is None

    async def test_a_flap_faster_than_the_cooldown_still_reports_once_per_window(
        self, tmp_path: Path
    ) -> None:
        """A suppressed window must not EXTEND the quiet period.

        If every suppressed flap pushed the timestamp forward, a service
        flapping faster than the cooldown would stay silent forever instead of
        reporting once per window -- silence indistinguishable from health,
        which is the failure #536 was raised about in the first place.
        """
        clock = FakeClock()
        latch = OutageLatch(
            tmp_path / "w.db", cooldown_seconds=300.0, now=clock
        )

        spoken: list[str] = []
        # 40 minutes of a service flapping every 30 seconds.
        for _ in range(80):
            clock.advance(30.0)
            for notice in (
                await latch.note_spooled("s"),
                await latch.note_delivered("s"),
            ):
                if notice is not None:
                    spoken.append(notice)

        degraded = [line for line in spoken if line == DEGRADED_NOTICE]
        # 2400s of flapping over a 300s cooldown: reported periodically, not
        # once and never again, and nowhere near the 80 a per-call nag gives.
        assert 4 <= len(degraded) <= 9


class TestTheRecoveryLineCarriesWhatTheWindowCost:
    """A single blip and a long outage must not read identically."""

    async def test_the_failed_turns_are_counted(self, tmp_path: Path) -> None:
        latch = OutageLatch(tmp_path / "w.db")

        for _ in range(5):
            await latch.note_spooled("s")

        assert await latch.note_delivered("s") == f"{RECOVERED_NOTICE} (5 turns held)"

    async def test_the_count_does_not_leak_into_the_next_window(
        self, tmp_path: Path
    ) -> None:
        """Each window reports its OWN failures, not the session's running total."""
        clock = FakeClock()
        latch = OutageLatch(
            tmp_path / "w.db", cooldown_seconds=1.0, now=clock
        )

        for _ in range(4):
            await latch.note_spooled("s")
        assert await latch.note_delivered("s") == f"{RECOVERED_NOTICE} (4 turns held)"

        clock.advance(10.0)

        await latch.note_spooled("s")
        await latch.note_spooled("s")

        assert await latch.note_delivered("s") == f"{RECOVERED_NOTICE} (2 turns held)"


@contextlib.contextmanager
def latch_held(database: Path) -> Iterator[None]:
    """Hold a ``BEGIN IMMEDIATE`` write lock on ``database`` for the block.

    Exactly what a second capture process does while it is inside
    :meth:`OutageLatch._set` -- the write lock is taken up front, so a
    concurrent ``Stop`` and ``SubagentStop`` overlapping on one file is this,
    not an exotic case. Parallel subagents make it routine.
    """
    OutageLatch(database)._prepare()  # noqa: SLF001 -- setting up the contention
    blocker = sqlite3.connect(database, timeout=1.0, autocommit=True)
    try:
        blocker.execute("BEGIN IMMEDIATE")
        blocker.execute(
            "INSERT INTO capture_outage (session_key, degraded) VALUES ('x', 1)"
        )
        yield
    finally:
        with contextlib.suppress(sqlite3.Error):
            blocker.execute("ROLLBACK")
        blocker.close()


class TestALockedLatchNeverStallsTheHook:
    """The latch is best-effort telemetry; it may never hold a hook past its deadline.

    ``Stop`` has a 5s deadline and the harness kills the hook at 10s. Two
    properties make that true and BOTH are needed:

        the latch's own WAIT is a fraction of a second   -- it never blocks long
        the latch's FILE is not the watermark's          -- it never blocks the
                                                            delivery path at all

    The first alone is not enough, and that is measured below: bounding the wait
    governs how long the latch WAITS, never how long it HOLDS, so while it held
    the shared watermark file the DELIVERY's own read
    (``watermark.LOCK_WAIT_SECONDS = 30``) waited behind it and a healthy Stop
    ran 31.4s with zero batches delivered.
    """

    def test_a_held_lock_does_not_push_the_hook_past_its_deadline(
        self, tmp_path: Path
    ) -> None:
        """The latch's WAIT: a locked latch file degrades to silence, fast."""
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "hi", session="sess")])
        watermark = tmp_path / "wm.sqlite"

        with latch_held(outage_module.latch_path(watermark)):
            start = time.monotonic()
            stop.capture_stop_with(
                io.StringIO(stop_payload(transcript)),
                unconfigured(watermark),
                notices=io.StringIO(),
            )
            elapsed = time.monotonic() - start

        # Well under the 5s Stop deadline. On the 30s lock wait this measured
        # over 30s and the harness would have killed the hook.
        assert elapsed < 2.0

    def test_the_lock_wait_is_under_the_stop_deadline(self) -> None:
        """The constant itself, so the reason survives a future edit.

        A latch write is telemetry. The watermark's own 30s wait is DURABILITY
        and is correct there; copying it here is what made the hook stallable.
        """
        assert outage_module.LOCK_WAIT_SECONDS < 1.0


class TestTheLatchCannotBlockTheDeliveryPath:
    """The latch's FILE: telemetry may never cost the turn it reports on.

    THE TEST ABOVE CANNOT CATCH THIS, and that gap is why the defect shipped.
    It drives an UNCONFIGURED capture, which raises in the lane factory BEFORE
    ``deliver`` ever reads the watermark -- so the only file it touches under
    contention is the latch's, and the delivery lane it is supposed to protect
    is never exercised at all. The measurement that found this drove a
    CONFIGURED, REACHABLE Stop instead, and these do the same: the real
    ``_started_memory`` seam (``brain``), a real transcript, a real watermark
    read.

    Measured on the shared-file latch, reproduced 4x: 31.36 / 31.37 / 31.38 /
    31.01 s, and ``RecordingLane`` received NOTHING -- past the 5s deadline,
    past the harness's 10s kill, the turn DROPPED rather than delayed. The
    latch's ``BEGIN IMMEDIATE`` was on the watermark file and
    ``deliver.position_for`` waited the watermark's own 30s behind it.
    """

    def test_a_healthy_turn_is_delivered_on_time_while_the_latch_is_locked(
        self, tmp_path: Path, brain: Brain, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """CONFIGURED + REACHABLE, with the latch's transaction held open.

        Driven through the real ``main`` -- the process entrypoint, whose return
        value IS the exit code -- with only the settings loader replaced, so all
        three of the measurement's failures are asserted from one run: the wall
        time, the delivery, and the exit code. Any one alone passes for the
        wrong reason; a hook that returns instantly having delivered nothing
        satisfies the timing.
        """
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "hi", session="sess")])
        watermark = tmp_path / "wm.sqlite"
        monkeypatch.setattr(stop, "_loaded_capture", lambda: reachable(watermark))

        with latch_held(outage_module.latch_path(watermark)):
            start = time.monotonic()
            exit_code = stop.main(io.StringIO(stop_payload(transcript)))
            elapsed = time.monotonic() - start

        # (a) Well inside the 5s Stop deadline. The shared file measured 31.4s.
        assert elapsed < 2.0
        # (b) The turn LANDED. This is the assertion the old test could not
        # make: on the shared file the lane received zero batches.
        assert len(brain.lane.batches) == 1
        # (c) And the hook still reported success.
        assert exit_code == 0

    def test_the_latch_never_opens_the_watermark_file(
        self, tmp_path: Path, brain: Brain
    ) -> None:
        """The structural half, so a future refactor cannot quietly re-share it.

        A timing assertion is a proxy; this is the property itself. After a full
        configured Stop the two files both exist and are DIFFERENT, and the
        watermark carries no ``capture_outage`` table.
        """
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "hi", session="sess")])
        watermark = tmp_path / "wm.sqlite"

        # Fail first (to write a latch row), then succeed (to write a
        # watermark), so both files are genuinely created by the hook.
        brain.up = False
        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)),
            reachable(watermark),
            notices=io.StringIO(),
        )
        brain.up = True
        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)),
            reachable(watermark),
            notices=io.StringIO(),
        )

        latch_file = outage_module.latch_path(watermark)
        assert latch_file != watermark
        assert latch_file.exists()
        assert watermark.exists()
        assert table_names(watermark) == {"watermark"}
        assert "capture_outage" in table_names(latch_file)

    def test_an_old_watermark_table_is_left_alone_not_dropped(
        self, tmp_path: Path, brain: Brain
    ) -> None:
        """Migration is a no-op: the dead table stays, unread (no destructive ops).

        Dogfood machines have a ``capture_outage`` table inside their watermark
        file from the first revision of #542. It must neither break the hook nor
        be deleted by it -- and its stale state must not be read, so a session
        recorded degraded there starts fresh as healthy.
        """
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "hi", session="sess")])
        watermark = tmp_path / "wm.sqlite"

        # Stand up the OLD shape: the latch's table inside the watermark file,
        # holding a degraded row for the session about to run.
        OutageLatch(watermark)._prepare()  # noqa: SLF001 -- staging the old on-disk shape
        with contextlib.closing(sqlite3.connect(watermark, autocommit=True)) as old:
            old.execute(
                "INSERT INTO capture_outage (session_key, degraded) VALUES ('sess', 1)"
            )

        notices = io.StringIO()
        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)),
            reachable(watermark),
            notices=notices,
        )

        # The dead table survives untouched -- nothing here deletes operator data.
        assert "capture_outage" in table_names(watermark)
        with contextlib.closing(sqlite3.connect(watermark, autocommit=True)) as old:
            stale = old.execute(
                "SELECT degraded FROM capture_outage WHERE session_key = 'sess'"
            ).fetchone()
        assert stale == (1,)
        # And it is not READ: a stale "degraded" there would make this healthy
        # Stop print a false recovery.
        assert notices.getvalue() == ""
        assert len(brain.lane.batches) == 1


def table_names(database: Path) -> set[str]:
    """Every user table in ``database``. Reads, never writes."""
    with contextlib.closing(sqlite3.connect(database, autocommit=True)) as connection:
        rows = connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    return {row[0] for row in rows if not row[0].startswith("sqlite_")}


class TestTheKnownOutageStopsRepeatingItselfInTheLog:
    """The latched notice is pointless if the old warning still nags (#536).

    ``stop`` already logged a ``warning`` on every failed Stop, to the SAME
    stderr the notice goes to. Latching only the notice left the per-Stop noise
    in place one line down. Inside a KNOWN outage that line drops to ``debug``
    -- demoted, never deleted, so a configured file/JSON sink still receives it.
    """

    def test_the_first_failure_is_still_a_warning(self, tmp_path: Path) -> None:
        """The first report stays loud: it IS the report."""
        levels = record_log_levels(CAPTURE_FAILURE_MESSAGE)
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "hi", session="sess")])

        with levels as seen:
            stop.capture_stop_with(
                io.StringIO(stop_payload(transcript)),
                unconfigured(tmp_path / "wm.sqlite"),
                notices=io.StringIO(),
            )

        assert "WARNING" in seen

    def test_a_repeat_failure_inside_a_known_outage_is_demoted(
        self, tmp_path: Path
    ) -> None:
        """The second failed Stop must not print another warning to stderr."""
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "hi", session="sess")])
        settings = unconfigured(tmp_path / "wm.sqlite")

        # First Stop: latches the outage and warns.
        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)),
            settings,
            notices=io.StringIO(),
        )

        levels = record_log_levels(CAPTURE_FAILURE_MESSAGE)
        with levels as seen:
            stop.capture_stop_with(
                io.StringIO(stop_payload(transcript)),
                settings,
                notices=io.StringIO(),
            )

        assert "WARNING" not in seen
        # NOT deleted -- the information still flows, one level down.
        assert "DEBUG" in seen


class TestTheSpoolPathVariableIsLegalToSet:
    """``OPENBRAIN_SPOOL_PATH`` must not kill capture (#536, fix round 2).

    ``default_spool_path`` reads it, but the strict settings model treated the
    name as an UNRECOGNISED prefixed variable and raised
    ``UnknownEnvironmentVariableError``. That is swallowed by the entrypoint,
    so an operator pointing the provider's spool somewhere produced a SILENT
    ZERO CAPTURE on every Stop. Fixed at the owning boundary: the variable is a
    declared field.
    """

    def test_capture_settings_load_with_the_variable_set(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        spool = tmp_path / "custom-spool.jsonl"
        monkeypatch.setenv("OPENBRAIN_SPOOL_PATH", str(spool))

        settings = load_capture_settings({"OPENBRAIN_SPOOL_PATH": str(spool)})

        assert settings.spool_path == spool

    def test_the_variable_is_not_reported_as_a_typo(self) -> None:
        """The check that raised is the one that has to accept it now."""
        assert (
            unknown_prefixed_variables({"OPENBRAIN_SPOOL_PATH": "/x/y.jsonl"}) == ()
        )

    def test_the_declared_setting_is_what_the_notice_reads(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The field is read, not merely declared to silence the check.

        A declared-but-unread field is dead config: the variable would load and
        still do nothing. The setting wins over the environment.
        """
        monkeypatch.setenv("OPENBRAIN_SPOOL_PATH", str(tmp_path / "from-env.jsonl"))
        configured = tmp_path / "from-settings.jsonl"

        assert default_spool_path(configured) == configured


class TestSubagentStopSharesTheParentsLatch:
    """One outage is one notice, even across the two capture lanes."""

    def test_a_subagent_outage_announces(self, tmp_path: Path) -> None:
        transcript = tmp_path / "sub.jsonl"
        write_lines(transcript, [operator_line("a1", "sub turn", session="sess")])
        notices = io.StringIO()
        payload = json.dumps(
            {
                "agent_transcript_path": str(transcript),
                "agent_id": "agent-1",
                "session_id": "sess",
            }
        )

        subagent_stop.capture_subagent_stop_with(
            io.StringIO(payload), unconfigured(tmp_path / "wm.sqlite"), notices=notices
        )

        assert DEGRADED_NOTICE in notices.getvalue()

    def test_the_parent_stop_does_not_repeat_it(self, tmp_path: Path) -> None:
        """Latched under the PARENT session, so the two lanes announce once.

        A subagent's turns get their own WATERMARK key -- durability is per
        transcript -- but the outage is one condition. Latching per lane would
        put the same line on screen twice for one dead service.
        """
        watermark = tmp_path / "wm.sqlite"
        sub = tmp_path / "sub.jsonl"
        write_lines(sub, [operator_line("a1", "sub turn", session="sess")])
        main_transcript = tmp_path / "t.jsonl"
        write_lines(main_transcript, [operator_line("u1", "main", session="sess")])
        second = io.StringIO()

        subagent_stop.capture_subagent_stop_with(
            io.StringIO(
                json.dumps(
                    {
                        "agent_transcript_path": str(sub),
                        "agent_id": "agent-1",
                        "session_id": "sess",
                    }
                )
            ),
            unconfigured(watermark),
            notices=io.StringIO(),
        )
        stop.capture_stop_with(
            io.StringIO(stop_payload(main_transcript)),
            unconfigured(watermark),
            notices=second,
        )

        assert second.getvalue() == ""


class TestTheLatchItself:
    """The state machine, exercised directly rather than through a hook."""

    async def test_it_reports_only_transitions(self, tmp_path: Path) -> None:
        latch = OutageLatch(tmp_path / "w.db")

        assert await latch.note_spooled("s") == DEGRADED_NOTICE
        assert await latch.note_spooled("s") is None
        # The bookend still fires on the transition, and now carries what the
        # window cost: two Stops failed inside it.
        assert await latch.note_delivered("s") == (
            f"{RECOVERED_NOTICE} (2 turns held)"
        )
        assert await latch.note_delivered("s") is None

    async def test_a_single_failure_recovers_without_a_count(
        self, tmp_path: Path
    ) -> None:
        """One failed Stop gets the bare bookend -- "(1 turns held)" is noise."""
        latch = OutageLatch(tmp_path / "w.db")

        assert await latch.note_spooled("s") == DEGRADED_NOTICE

        assert await latch.note_delivered("s") == RECOVERED_NOTICE

    async def test_sessions_do_not_share_health(self, tmp_path: Path) -> None:
        """Two live sessions are two states; one going down is not the other's."""
        latch = OutageLatch(tmp_path / "w.db")

        assert await latch.note_spooled("a") == DEGRADED_NOTICE
        assert await latch.is_degraded("a") is True
        assert await latch.is_degraded("b") is False
        assert await latch.note_delivered("b") is None

    async def test_an_unknown_session_reads_healthy(self, tmp_path: Path) -> None:
        """The default has to be healthy, or a first success would announce."""
        latch = OutageLatch(tmp_path / "w.db")

        assert await latch.is_degraded("never-seen") is False


class TestTheSpoolDepthOnTheNotice:
    """The count is reported when known, and omitted rather than guessed."""

    def test_object_lines_are_counted(self, tmp_path: Path) -> None:
        spool = tmp_path / "spool.jsonl"
        spool.write_text('{"a":1}\n{"b":2}\n\n', encoding="utf-8")

        assert spool_pending(spool) == 2

    def test_a_missing_spool_is_zero_not_unknown(self, tmp_path: Path) -> None:
        assert spool_pending(tmp_path / "absent.jsonl") == 0

    def test_a_truncated_last_line_is_not_a_pending_record(
        self, tmp_path: Path
    ) -> None:
        """A half-written line is a crash artifact, not a turn waiting."""
        spool = tmp_path / "spool.jsonl"
        spool.write_text('{"a":1}\n{"b":', encoding="utf-8")

        assert spool_pending(spool) == 1

    def test_an_unreadable_spool_reports_unknown(self, tmp_path: Path) -> None:
        """A directory where a file belongs reads as unknown, never as zero.

        Zero would be a claim that nothing is waiting, which is exactly the
        false reassurance this line exists to avoid.
        """
        unreadable = tmp_path / "spool.jsonl"
        unreadable.mkdir()

        assert spool_pending(unreadable) is None

    def test_an_unknown_or_empty_depth_is_omitted_from_the_line(self) -> None:
        assert spool_notice(DEGRADED_NOTICE, None) == DEGRADED_NOTICE
        assert spool_notice(DEGRADED_NOTICE, 0) == DEGRADED_NOTICE

    def test_a_known_depth_is_appended(self) -> None:
        assert spool_notice(DEGRADED_NOTICE, 7) == f"{DEGRADED_NOTICE} (spool: 7)"

    def test_the_configured_spool_path_wins(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OPENBRAIN_SPOOL_PATH", str(tmp_path / "custom.jsonl"))

        assert default_spool_path() == tmp_path / "custom.jsonl"

    def test_an_empty_variable_falls_back_rather_than_resolving_to_cwd(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An empty variable is ABSENT, matching the gate and the receipt path."""
        monkeypatch.setenv("OPENBRAIN_SPOOL_PATH", "")
        monkeypatch.setenv("XDG_STATE_HOME", "")

        resolved = default_spool_path()

        assert resolved.is_absolute()
        assert resolved.name == "claude-spool.jsonl"


def asyncio_offset(watermark: Path, session_key: str) -> int:
    """Read a stored watermark offset from a synchronous test."""
    import asyncio

    return asyncio.run(WatermarkStore(watermark).offset_for(session_key))
