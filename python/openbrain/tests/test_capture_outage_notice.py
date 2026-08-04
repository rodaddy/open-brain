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

import io
import json
from typing import TYPE_CHECKING

import pytest

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
from openbrain.config import CaptureSettings

if TYPE_CHECKING:
    from pathlib import Path


def unconfigured(watermark: Path) -> CaptureSettings:
    """Capture with no endpoint or token: the real factory raises immediately.

    A stand-in for "the write did not land", chosen over a socket because it is
    instant and deterministic. The watermark path is real, because that is the
    file the latch shares and these tests read it back.
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

        The latch shares the watermark's database file. Pointing it at a
        DIRECTORY makes every sqlite call fail; the hook must still return
        normally with empty stdout, because this function exists to report a
        failure and must not be able to cause one.
        """
        unusable = tmp_path / "not-a-file"
        unusable.mkdir()
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "hi", session="sess")])

        stop.capture_stop_with(
            io.StringIO(stop_payload(transcript)),
            unconfigured(unusable),
            notices=io.StringIO(),
        )
        # No assertion beyond "it returned": the contract is that nothing raised
        # and the session was never touched.

    def test_the_entrypoint_still_exits_zero(self, tmp_path: Path) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "hi", session="sess")])

        assert stop.main(io.StringIO(stop_payload(transcript))) == 0


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
        assert await latch.note_delivered("s") == RECOVERED_NOTICE
        assert await latch.note_delivered("s") is None

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
