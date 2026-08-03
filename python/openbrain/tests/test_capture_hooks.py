"""Functional tests for the hook entrypoints, over CAPTURED harness stdin.

Every entrypoint is exercised with the bytes Claude Code actually sent
(``tests/fixtures/captured_hooks/``), not a payload hand-written from docs. The
contract each proves is the acceptance criterion in
``_plans/418-prov-9-hook-entrypoints.md``: stdin in, exit 0, empty stdout.

``stop`` gets more: with a recording lane it must deliver the turns and advance
the watermark ONLY after the lane returns, and with a failing lane it must still
exit 0 with empty stdout and leave the watermark where it was -- capture never
blocks or breaks a session (``docs/decisions/capture-never-drops-a-turn.md``).
"""

from __future__ import annotations

import io
import json
import socket
import threading
import time
from collections.abc import Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from conftest import (
    CanonPackReader,
    ClosingRecorder,
    RecordingLane,
    UnreachableLane,
    operator_line,
    write_lines,
)
from openbrain.apps.capture.watermark import WatermarkStore
from openbrain.apps.hooks import (
    post_compact,
    post_tool_use,
    session_end,
    session_start,
    stop,
    subagent_stop,
)
from openbrain.apps.hooks.dispatch import ENTRYPOINTS
from openbrain.apps.hooks.session import (
    STOP_HOOK_DEADLINE_SECONDS,
    CanonNotConfiguredError,
    CaptureNotConfiguredError,
    PostCompactHook,
    PostToolUseHook,
    SessionEndHook,
    SessionStartHook,
    StartedLane,
    StopHook,
    SubagentStopHook,
    run_post_compact,
    run_post_tool_use,
    run_session_end,
    run_session_start,
    run_stop,
    run_subagent_stop,
)
from openbrain.config import CanonSettings, CaptureSettings

#: The events whose entrypoints do REAL work and reach settings/the client, so
#: the shared "run it through the table" tests below skip them and each gets its
#: own focused coverage. Every other event is a drain-and-exit stub.
REAL_EVENTS = (
    "SessionStart",
    "Stop",
    "SubagentStop",
    "SessionEnd",
    "PostCompact",
    # PostToolUse stopped being a stub with #469: a Skill call now records one
    # usage metric. It is listed here rather than left among the stubs because
    # the captured fixture is a BASH call, which returns early -- so the stub
    # test would keep passing over it and silently stop describing the module.
    "PostToolUse",
)

if TYPE_CHECKING:
    from typing import TextIO

FIXTURES = Path(__file__).parent / "fixtures" / "captured_hooks"

#: The verified events with a fixture and an entrypoint. ``PostCompact`` is now
#: present: a real compaction was forced on 2026-07-31, it fired, and its stdin
#: is captured (fixtures README) rather than unknown.
CAPTURED_EVENTS = (
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "SessionEnd",
    "PreToolUse",
    "PostToolUse",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
)


def fixture_bytes(event: str) -> str:
    """The captured stdin for one event, byte-exact as the harness sent it."""
    return (FIXTURES / f"{event}.json").read_text(encoding="utf-8")


def stream_for(event: str) -> TextIO:
    """A stdin stream carrying one event's captured payload."""
    return io.StringIO(fixture_bytes(event))


class TestEveryEntrypointAcceptsItsCapturedInput:
    """stdin -> exit 0, empty stdout, for each verified event's real bytes."""

    @pytest.mark.parametrize("event", CAPTURED_EVENTS)
    def test_the_dispatch_table_runs_the_captured_event(
        self, event: str, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # The real entrypoints reach load_settings and the client; the stubs do
        # not. Test the real ones' behaviour separately -- here, only that a
        # dispatch entry exists and the stubs run clean over real input.
        entrypoint = ENTRYPOINTS[event]
        assert callable(entrypoint)
        if event not in REAL_EVENTS:
            assert entrypoint(stream_for(event)) == 0
            assert capsys.readouterr().out == ""

    def test_the_table_covers_exactly_the_captured_events(self) -> None:
        """A key with no fixture, or a fixture with no key, is a drift bug."""
        assert set(ENTRYPOINTS) == set(CAPTURED_EVENTS)

    def test_postcompact_now_has_an_entrypoint_and_a_fixture(self) -> None:
        """The last uncaptured event fired on 2026-07-31 -- it is verified now.

        Its stdin was captured (not invented) by forcing a real compaction, so
        it earns a dispatch entry and a byte-exact fixture like every other
        verified event. The old ``must not exist`` assertion is inverted to the
        new truth.
        """
        assert "PostCompact" in ENTRYPOINTS
        assert (FIXTURES / "PostCompact.json").exists()

    def test_postcompact_fixture_carries_the_compact_summary(self) -> None:
        """The field that distinguishes PostCompact from PreCompact is present.

        ``compact_summary`` is the generated summary that replaces the discarded
        context -- the real payload field a parser must expect, proven by the
        captured bytes, not docs.
        """
        payload = json.loads(fixture_bytes("PostCompact"))
        assert payload["hook_event_name"] == "PostCompact"
        assert payload["trigger"] == "manual"
        assert isinstance(payload["compact_summary"], str)
        assert payload["compact_summary"] != ""


class TestStubsDrainAndExitZero:
    """A stub consumes its payload and acts on nothing."""

    STUB_EVENTS = tuple(e for e in CAPTURED_EVENTS if e not in REAL_EVENTS)

    @pytest.mark.parametrize("event", STUB_EVENTS)
    def test_a_stub_returns_zero_and_reads_its_input(self, event: str) -> None:
        stream = stream_for(event)
        assert ENTRYPOINTS[event](stream) == 0
        # The whole payload was consumed -- an unread pipe can wedge the writer.
        assert stream.read() == ""


class TestStopParsesTheCapturedPayload:
    """The Stop fixture yields the transcript path and session id capture needs."""

    def test_transcript_and_session_are_read_from_the_real_bytes(self) -> None:
        payload = StopHook.model_validate_json(fixture_bytes("Stop"))
        captured = json.loads(fixture_bytes("Stop"))
        assert payload.session_id == captured["session_id"]
        assert str(payload.transcript_path) == captured["transcript_path"]


def started(lane: object, close: object = None) -> StartedLane:
    """Wrap a recorder as the :class:`StartedLane` a ``lane_factory`` returns.

    The injected factory now hands back a lane PLUS its closer; a recorder holds
    no session slot, so its close defaults to a no-op unless the test wants to
    observe it.
    """
    return StartedLane(lane=lane, close=close or (lambda: None))  # type: ignore[arg-type]


def capture_settings(watermark_path: Path) -> CaptureSettings:
    """A CaptureSettings pointed at a temp watermark; endpoint values are inert.

    run_stop with an injected lane_factory never builds a real client, so the
    base_url and token here are never dialed -- they exist because the section
    requires them, not because the test reaches a service.
    """
    return CaptureSettings(
        base_url="http://127.0.0.1:0",
        token="unused-in-injected-lane-tests",  # noqa: S106 -- not a real secret
        watermark_path=watermark_path,
    )


class TestStopDeliversThroughTheSpine:
    """run_stop is the capability the entrypoint calls; drive it with a lane."""

    async def test_turns_are_delivered_and_the_watermark_advances_after(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(
            transcript,
            [operator_line("u1", "use postgres not sqlite", session="sess")],
        )
        watermark = tmp_path / "wm.sqlite"
        settings = capture_settings(watermark)
        lane = RecordingLane()
        payload = StopHook(transcript_path=transcript, session_id="sess")

        result = await run_stop(
            payload, settings, lane_factory=lambda _s, _k: started(lane)
        )

        assert result is not None
        assert result.delivered == 1
        assert lane.turns[0]["content"] == "use postgres not sqlite"
        # Advanced only after the lane returned: the stored offset now matches
        # what the delivery reported, which is EOF of the read file.
        stored = await WatermarkStore(watermark).offset_for("sess")
        assert stored == result.next_offset
        assert stored == transcript.stat().st_size

    async def test_a_payload_with_no_transcript_delivers_nothing(
        self, tmp_path: Path
    ) -> None:
        settings = capture_settings(tmp_path / "wm.sqlite")
        payload = StopHook(session_id="sess")  # no transcript_path

        result = await run_stop(
            payload, settings, lane_factory=lambda _s, _k: started(RecordingLane())
        )

        assert result is None

    async def test_a_failed_lane_leaves_the_watermark_where_it_was(
        self, tmp_path: Path
    ) -> None:
        """The unadvanced watermark is the retry; the turn is not lost."""
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "must not be lost", session="sess")])
        watermark = tmp_path / "wm.sqlite"
        settings = capture_settings(watermark)
        broken = UnreachableLane()
        payload = StopHook(transcript_path=transcript, session_id="sess")

        with pytest.raises(RuntimeError):
            await run_stop(
                payload, settings, lane_factory=lambda _s, _k: started(broken)
            )

        assert broken.calls == 1
        assert await WatermarkStore(watermark).offset_for("sess") == 0


class TestStopReleasesTheSessionSlot:
    """run_stop closes the lane on BOTH paths -- a slot left open exhausts the cap.

    The server caps sessions per worker; a Stop that opens one and never frees it
    lets a burst hit ``session_cap_exceeded``. ``run_stop`` owns the close in a
    ``finally``, so it happens whether the delivery returned or raised.
    """

    async def test_close_is_called_after_a_successful_delivery(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "kept", session="sess")])
        settings = capture_settings(tmp_path / "wm.sqlite")
        recorder = ClosingRecorder()
        payload = StopHook(transcript_path=transcript, session_id="sess")

        result = await run_stop(
            payload,
            settings,
            lane_factory=lambda _s, _k: started(recorder, recorder.close),
        )

        assert result is not None
        assert result.delivered == 1
        assert recorder.closed == 1

    async def test_close_is_called_even_when_the_send_fails(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "boom", session="sess")])
        settings = capture_settings(tmp_path / "wm.sqlite")
        recorder = ClosingRecorder(fail=True)
        payload = StopHook(transcript_path=transcript, session_id="sess")

        with pytest.raises(RuntimeError):
            await run_stop(
                payload,
                settings,
                lane_factory=lambda _s, _k: started(recorder, recorder.close),
            )

        assert recorder.closed == 1


class TestSubagentStopParsesTheCapturedPayload:
    """The SubagentStop fixture yields the subagent transcript and a distinct key."""

    def test_fields_are_read_from_the_real_bytes(self) -> None:
        payload = SubagentStopHook.model_validate_json(fixture_bytes("SubagentStop"))
        captured = json.loads(fixture_bytes("SubagentStop"))
        assert str(payload.agent_transcript_path) == captured["agent_transcript_path"]
        assert payload.agent_id == captured["agent_id"]
        assert payload.session_id == captured["session_id"]

    def test_the_watermark_key_is_per_subagent_not_the_parent_session(self) -> None:
        # The key must NOT collide with the main Stop's watermark for the same
        # session_id -- the subagent transcript is its own byte stream.
        payload = SubagentStopHook.model_validate_json(fixture_bytes("SubagentStop"))
        captured = json.loads(fixture_bytes("SubagentStop"))
        key = payload.watermark_key()
        assert key == f"{captured['session_id']}:{captured['agent_id']}"
        assert key != captured["session_id"]

    def test_missing_agent_id_has_no_key(self) -> None:
        payload = SubagentStopHook(session_id="s", agent_transcript_path=Path("/x"))
        assert payload.watermark_key() is None


class TestSubagentStopDeliversThroughTheSpine:
    """run_subagent_stop is the same spine as run_stop, over the subagent transcript."""

    async def test_turns_are_delivered_under_the_per_subagent_key(
        self, tmp_path: Path
    ) -> None:
        # The subagent's OWN transcript, and its own watermark keyed to it.
        transcript = tmp_path / "sub.jsonl"
        write_lines(
            transcript,
            [operator_line("a1", "subagent turn one", session="sub-key")],
        )
        watermark = tmp_path / "wm.sqlite"
        settings = capture_settings(watermark)
        lane = RecordingLane()
        payload = SubagentStopHook(
            agent_transcript_path=transcript,
            agent_id="agent-xyz",
            session_id="parent-sess",
        )

        result = await run_subagent_stop(
            payload, settings, lane_factory=lambda _s, _k: started(lane)
        )

        assert result is not None
        assert result.delivered == 1
        assert lane.turns[0]["content"] == "subagent turn one"
        # Advanced under the per-subagent key, not the parent session_id.
        stored = await WatermarkStore(watermark).offset_for("parent-sess:agent-xyz")
        assert stored == result.next_offset
        # The parent session's own key is untouched by a subagent stop.
        assert await WatermarkStore(watermark).offset_for("parent-sess") == 0

    async def test_no_transcript_delivers_nothing(self, tmp_path: Path) -> None:
        settings = capture_settings(tmp_path / "wm.sqlite")
        payload = SubagentStopHook(agent_id="a", session_id="s")  # no transcript

        result = await run_subagent_stop(
            payload, settings, lane_factory=lambda _s, _k: started(RecordingLane())
        )

        assert result is None

    async def test_a_failed_lane_leaves_the_subagent_watermark_unmoved(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "sub.jsonl"
        write_lines(transcript, [operator_line("a1", "keep me", session="k")])
        watermark = tmp_path / "wm.sqlite"
        settings = capture_settings(watermark)
        broken = UnreachableLane()
        payload = SubagentStopHook(
            agent_transcript_path=transcript, agent_id="a", session_id="s"
        )

        with pytest.raises(RuntimeError):
            await run_subagent_stop(
                payload, settings, lane_factory=lambda _s, _k: started(broken)
            )

        assert broken.calls == 1
        assert await WatermarkStore(watermark).offset_for("s:a") == 0


class TestSubagentStopEntrypointNeverDisruptsTheSession:
    """capture_subagent_stop swallows everything and exits 0 with empty stdout."""

    def test_a_malformed_payload_is_swallowed(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        subagent_stop.capture_subagent_stop(io.StringIO("{not json"))
        assert capsys.readouterr().out == ""

    def test_the_captured_fixture_runs_clean_through_the_entrypoint(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # The real fixture names a transcript that does not exist on this box, so
        # the spine finds nothing to read -- the swallow keeps it exit-0 either
        # way, with an unconfigured or an unreachable capture.
        subagent_stop.capture_subagent_stop_with(
            io.StringIO(fixture_bytes("SubagentStop")), _unconfigured_settings()
        )
        assert capsys.readouterr().out == ""

    def test_main_returns_zero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("sys.stdin", io.StringIO("{not json"))
        assert subagent_stop.main() == 0


class TestSessionEndReleasesTheServerSlot:
    """run_session_end starts and closes the session -- no delivery, slot freed."""

    async def test_it_closes_the_session_and_delivers_nothing(
        self, tmp_path: Path
    ) -> None:
        settings = capture_settings(tmp_path / "wm.sqlite")
        recorder = ClosingRecorder()
        payload = SessionEndHook(session_id="sess")

        released = await run_session_end(
            payload,
            settings,
            lane_factory=lambda _s, _k: started(recorder, recorder.close),
        )

        assert released is True
        assert recorder.closed == 1
        # No delivery on SessionEnd -- turns were durable on each Stop already.
        assert recorder.batches == []

    async def test_no_session_id_is_a_no_op(self, tmp_path: Path) -> None:
        settings = capture_settings(tmp_path / "wm.sqlite")
        recorder = ClosingRecorder()
        payload = SessionEndHook()  # no session_id

        released = await run_session_end(
            payload,
            settings,
            lane_factory=lambda _s, _k: started(recorder, recorder.close),
        )

        assert released is False
        assert recorder.closed == 0

    def test_the_session_id_is_read_from_the_real_bytes(self) -> None:
        payload = SessionEndHook.model_validate_json(fixture_bytes("SessionEnd"))
        captured = json.loads(fixture_bytes("SessionEnd"))
        assert payload.session_id == captured["session_id"]


class TestSessionEndEntrypointNeverDisruptsTheSession:
    """close_session swallows everything and exits 0 with empty stdout."""

    def test_a_malformed_payload_is_swallowed(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        session_end.close_session(io.StringIO("{not json"))
        assert capsys.readouterr().out == ""

    def test_an_unconfigured_capture_is_swallowed(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # The real fixture carries a session_id, so the real factory would be
        # reached; an unconfigured capture raises CaptureNotConfiguredError,
        # which the entrypoint must eat.
        session_end.close_session_with(
            io.StringIO(fixture_bytes("SessionEnd")), _unconfigured_settings()
        )
        assert capsys.readouterr().out == ""

    def test_main_returns_zero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("sys.stdin", io.StringIO("{not json"))
        assert session_end.main() == 0


class TestPostCompactParsesTheCapturedPayload:
    """The PostCompact fixture yields the summary and the ids capture needs."""

    def test_summary_and_ids_are_read_from_the_real_bytes(self) -> None:
        payload = PostCompactHook.model_validate_json(fixture_bytes("PostCompact"))
        captured = json.loads(fixture_bytes("PostCompact"))
        assert payload.compact_summary == captured["compact_summary"]
        assert payload.session_id == captured["session_id"]
        assert payload.prompt_id == captured["prompt_id"]


class TestPostCompactRecordsTheSummary:
    """run_post_compact records the summary the Stop spine drops, WHOLE."""

    async def test_the_whole_summary_is_sent_as_one_raw_turn(
        self, tmp_path: Path
    ) -> None:
        # The real captured payload, so the summary shape is what the harness
        # actually sent -- not a hand-written stand-in.
        payload = PostCompactHook.model_validate_json(fixture_bytes("PostCompact"))
        captured = json.loads(fixture_bytes("PostCompact"))
        settings = capture_settings(tmp_path / "wm.sqlite")
        recorder = ClosingRecorder()

        recorded = await run_post_compact(
            payload,
            settings,
            lane_factory=lambda _s, _k: started(recorder, recorder.close),
        )

        assert recorded is True
        # One batch, one turn, and its content is the summary BYTE FOR BYTE -- no
        # bound, no shortening.
        assert len(recorder.batches) == 1
        assert len(recorder.batches[0]) == 1
        turn = recorder.batches[0][0]
        assert turn["content"] == captured["compact_summary"]
        # Dedup key is the compaction's own prompt_id, so a re-fired hook is a
        # server-side no-op.
        assert turn["turn_uuid"] == captured["prompt_id"]
        assert turn["session_ref"] == captured["session_id"]
        # The slot is released even though nothing read a transcript.
        assert recorder.closed == 1

    async def test_no_summary_is_a_no_op(self, tmp_path: Path) -> None:
        settings = capture_settings(tmp_path / "wm.sqlite")
        recorder = ClosingRecorder()
        payload = PostCompactHook(session_id="sess", prompt_id="p")  # no summary

        recorded = await run_post_compact(
            payload,
            settings,
            lane_factory=lambda _s, _k: started(recorder, recorder.close),
        )

        assert recorded is False
        assert recorder.batches == []
        assert recorder.closed == 0

    async def test_a_whitespace_only_summary_is_a_no_op(self, tmp_path: Path) -> None:
        settings = capture_settings(tmp_path / "wm.sqlite")
        recorder = ClosingRecorder()
        payload = PostCompactHook(
            session_id="sess", prompt_id="p", compact_summary="   \n  "
        )

        recorded = await run_post_compact(
            payload,
            settings,
            lane_factory=lambda _s, _k: started(recorder, recorder.close),
        )

        assert recorded is False
        assert recorder.batches == []

    async def test_no_session_id_is_a_no_op(self, tmp_path: Path) -> None:
        settings = capture_settings(tmp_path / "wm.sqlite")
        recorder = ClosingRecorder()
        payload = PostCompactHook(prompt_id="p", compact_summary="a summary")

        recorded = await run_post_compact(
            payload,
            settings,
            lane_factory=lambda _s, _k: started(recorder, recorder.close),
        )

        assert recorded is False
        assert recorder.batches == []

    async def test_a_failed_lane_still_releases_the_slot(self, tmp_path: Path) -> None:
        settings = capture_settings(tmp_path / "wm.sqlite")
        recorder = ClosingRecorder(fail=True)
        payload = PostCompactHook(
            session_id="sess", prompt_id="p", compact_summary="a summary"
        )

        with pytest.raises(RuntimeError):
            await run_post_compact(
                payload,
                settings,
                lane_factory=lambda _s, _k: started(recorder, recorder.close),
            )

        # The slot is freed on the failure path too -- the finally owns it.
        assert recorder.closed == 1


class TestPostCompactEntrypointNeverDisruptsTheSession:
    """record_compact_summary swallows everything and exits 0 with empty stdout."""

    def test_a_malformed_payload_is_swallowed(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        post_compact.record_compact_summary(io.StringIO("{not json"))
        assert capsys.readouterr().out == ""

    def test_an_unconfigured_capture_is_swallowed(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # The real fixture carries a summary and a session, so the real factory
        # would be reached; an unconfigured capture raises
        # CaptureNotConfiguredError, which the entrypoint must eat.
        post_compact.record_compact_summary_with(
            io.StringIO(fixture_bytes("PostCompact")), _unconfigured_settings()
        )
        assert capsys.readouterr().out == ""

    def test_main_returns_zero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("sys.stdin", io.StringIO("{not json"))
        assert post_compact.main() == 0


class TestPostToolUseParsesTheCapturedPayload:
    """The PostToolUse fixture yields the fields usage telemetry needs -- and no more."""

    def test_the_captured_bash_call_is_not_a_skill_invocation(self) -> None:
        """The real fixture is a Bash call, so it must count as nothing.

        PostToolUse fires for EVERY tool. #469 counts skills, so anything that is
        not a Skill call has to fall out before any client is built.
        """
        payload = PostToolUseHook.model_validate_json(fixture_bytes("PostToolUse"))
        captured = json.loads(fixture_bytes("PostToolUse"))
        assert payload.tool_name == captured["tool_name"] == "Bash"
        assert payload.skill_slug() is None

    def test_the_session_and_cwd_are_read_from_the_real_bytes(self) -> None:
        payload = PostToolUseHook.model_validate_json(fixture_bytes("PostToolUse"))
        captured = json.loads(fixture_bytes("PostToolUse"))
        assert payload.session_id == captured["session_id"]
        assert payload.cwd == captured["cwd"]
        assert payload.repo() == Path(captured["cwd"]).name

    def test_the_tool_response_is_dropped_at_the_parse_boundary(self) -> None:
        """The open memory-vs-observability question stays open, structurally.

        ``tool_response`` is the content stream ``capture-never-drops-a-turn.md``
        leaves UNDECIDED. The model must not even carry it, so it cannot be sent
        by a later edit reaching for a field that happens to be there.
        """
        captured = json.loads(fixture_bytes("PostToolUse"))
        assert "tool_response" in captured, "fixture should carry the field"
        payload = PostToolUseHook.model_validate_json(fixture_bytes("PostToolUse"))
        assert not hasattr(payload, "tool_response")
        assert "tool_response" not in PostToolUseHook.model_fields

    def test_a_skill_call_yields_its_slug(self) -> None:
        payload = PostToolUseHook.model_validate_json(
            json.dumps(
                {
                    "hook_event_name": "PostToolUse",
                    "tool_name": "Skill",
                    "tool_input": {"skill": "brain", "args": "recall"},
                    "session_id": "sess-1",
                    "cwd": "/Volumes/ThunderBolt/Development/open-brain",
                }
            )
        )
        assert payload.skill_slug() == "brain"
        assert payload.repo() == "open-brain"

    @pytest.mark.parametrize(
        "tool_input",
        [{}, {"skill": ""}, {"skill": "   "}, {"skill": 7}, {"args": "no skill"}],
    )
    def test_a_skill_call_without_a_usable_name_counts_as_nothing(
        self, tool_input: dict[str, object]
    ) -> None:
        payload = PostToolUseHook(tool_name="Skill", tool_input=tool_input)
        assert payload.skill_slug() is None


class TestPostToolUseRecordsOneUsageMetric:
    """run_post_tool_use sends the metric dimensions #469 asks for, and nothing else."""

    async def test_a_skill_call_sends_the_four_dimensions(self, tmp_path: Path) -> None:
        settings = capture_settings(tmp_path / "wm.sqlite")
        sent: list[dict[str, object]] = []
        payload = PostToolUseHook(
            tool_name="Skill",
            tool_input={"skill": "wayfinder", "args": "chart"},
            session_id="sess-1",
            cwd="/Volumes/ThunderBolt/Development/open-brain",
        )

        recorded = await run_post_tool_use(
            payload,
            settings,
            recorder=lambda _s, _k, arguments: sent.append(arguments),
        )

        assert recorded is True
        assert len(sent) == 1
        assert sent[0]["skill_slug"] == "wayfinder"
        assert sent[0]["session_id"] == "sess-1"
        assert sent[0]["repo"] == "open-brain"
        assert sent[0]["runtime"] == "claude-code"
        assert sent[0]["agent"] == settings.agent_id
        assert sent[0]["usage_kind"] == "skill"

    async def test_no_tool_content_is_ever_sent(self, tmp_path: Path) -> None:
        """The metric carries the skill NAME and no other tool input.

        This is the guard on the open question: a later edit that widened the
        payload to carry arguments or output would fail here.
        """
        settings = capture_settings(tmp_path / "wm.sqlite")
        sent: list[dict[str, object]] = []
        payload = PostToolUseHook(
            tool_name="Skill",
            tool_input={"skill": "brain", "args": "SECRET-ARGUMENT-VALUE"},
            session_id="sess-1",
        )

        await run_post_tool_use(
            payload, settings, recorder=lambda _s, _k, a: sent.append(a)
        )

        assert "SECRET-ARGUMENT-VALUE" not in json.dumps(sent[0])
        assert set(sent[0]) <= {
            "skill_slug",
            "usage_kind",
            "session_id",
            "runtime",
            "agent",
            "repo",
        }

    async def test_a_non_skill_tool_is_a_no_op(self, tmp_path: Path) -> None:
        settings = capture_settings(tmp_path / "wm.sqlite")
        sent: list[dict[str, object]] = []
        payload = PostToolUseHook(
            tool_name="Bash",
            tool_input={"command": "echo hello"},
            session_id="sess-1",
        )

        recorded = await run_post_tool_use(
            payload, settings, recorder=lambda _s, _k, a: sent.append(a)
        )

        assert recorded is False
        assert sent == []

    async def test_no_session_is_a_no_op(self, tmp_path: Path) -> None:
        settings = capture_settings(tmp_path / "wm.sqlite")
        sent: list[dict[str, object]] = []
        payload = PostToolUseHook(tool_name="Skill", tool_input={"skill": "brain"})

        recorded = await run_post_tool_use(
            payload, settings, recorder=lambda _s, _k, a: sent.append(a)
        )

        assert recorded is False
        assert sent == []

    async def test_a_missing_cwd_omits_the_repo_rather_than_guessing(
        self, tmp_path: Path
    ) -> None:
        settings = capture_settings(tmp_path / "wm.sqlite")
        sent: list[dict[str, object]] = []
        payload = PostToolUseHook(
            tool_name="Skill", tool_input={"skill": "brain"}, session_id="sess-1"
        )

        await run_post_tool_use(
            payload, settings, recorder=lambda _s, _k, a: sent.append(a)
        )

        assert "repo" not in sent[0]


class TestPostToolUseEntrypointNeverDisruptsTheSession:
    """record_skill_usage swallows everything and exits 0 with empty stdout."""

    def test_a_malformed_payload_is_swallowed(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        post_tool_use.record_skill_usage(io.StringIO("{not json"))
        assert capsys.readouterr().out == ""

    def test_an_unconfigured_capture_is_swallowed(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # A Skill payload reaches the real recorder, and an unconfigured capture
        # raises CaptureNotConfiguredError -- which the entrypoint must eat.
        skill_payload = json.dumps(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "Skill",
                "tool_input": {"skill": "brain"},
                "session_id": "sess-1",
            }
        )
        post_tool_use.record_skill_usage_with(
            io.StringIO(skill_payload), _unconfigured_settings()
        )
        assert capsys.readouterr().out == ""

    def test_the_captured_non_skill_payload_runs_clean(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """The real Bash fixture returns before settings are ever loaded."""
        assert post_tool_use.main(stream_for("PostToolUse")) == 0
        assert capsys.readouterr().out == ""

    def test_main_returns_zero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("sys.stdin", io.StringIO("{not json"))
        assert post_tool_use.main() == 0

    def test_stdin_content_never_reaches_the_log(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """A sentinel in a malformed payload must not appear in any log output."""
        post_tool_use.record_skill_usage(io.StringIO('{"tool_input": SENTINEL-XYZZY'))
        captured = capsys.readouterr()
        assert "SENTINEL-XYZZY" not in captured.out
        assert "SENTINEL-XYZZY" not in captured.err


class TestStopEntrypointNeverDisruptsTheSession:
    """capture_stop swallows everything and exits 0 with empty stdout."""

    def test_a_malformed_payload_is_swallowed(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        stop.capture_stop(io.StringIO("{not json"))
        assert capsys.readouterr().out == ""

    def test_main_returns_zero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("sys.stdin", io.StringIO("{not json"))
        assert stop.main() == 0

    def test_stdin_content_never_reaches_the_log(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """A sentinel in a malformed payload must not appear in any log output.

        loguru's ``diagnose`` renders an exception's locals -- and a pydantic
        ``ValidationError`` from a bad Stop payload carries its ``input_value``,
        which is the hook's raw stdin. The failure log must be content-free by
        construction, so it holds even against a sink with diagnose turned ON
        (the default for the stderr handler a hook actually logs to).
        """
        from loguru import logger

        sink = io.StringIO()
        sink_id = logger.add(sink, backtrace=True, diagnose=True, level="WARNING")
        try:
            # session_id is a list, so pydantic raises a ValidationError whose
            # input_value embeds SECRET-CONTENT-SENTINEL verbatim.
            payload = '{"session_id": ["SECRET-CONTENT-SENTINEL"], '
            payload += '"transcript_path": "/x"}'
            stop.capture_stop(io.StringIO(payload))
        finally:
            logger.remove(sink_id)

        captured = capsys.readouterr()
        assert "SECRET-CONTENT-SENTINEL" not in sink.getvalue()
        assert "SECRET-CONTENT-SENTINEL" not in captured.err
        assert "SECRET-CONTENT-SENTINEL" not in captured.out
        # The failure WAS logged -- content-free, by class name.
        assert "Stop capture failed" in sink.getvalue()


class TestUnconfiguredCaptureFailsAtUseNotAtLoad:
    """base_url/token are optional so a non-hook process loads; a hook needs both.

    The requirement moved to use time (``apps.hooks.session``) so an unrelated
    process is not failed at startup by capture config it never uses. When a
    ``Stop`` DOES run against an unconfigured capture, the real lane factory
    raises -- and the entrypoint swallows it, exactly like any other fault.
    """

    async def test_run_stop_raises_when_no_endpoint_or_token(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "hi", session="sess")])
        # No lane_factory: run_stop uses the real _started_memory, which checks
        # config before importing or dialing anything.
        settings = CaptureSettings(watermark_path=tmp_path / "wm.sqlite")
        payload = StopHook(transcript_path=transcript, session_id="sess")

        with pytest.raises(CaptureNotConfiguredError):
            await run_stop(payload, settings)

    def test_the_entrypoint_swallows_that_and_leaves_stdout_empty(
        self, capsys: pytest.CaptureFixture[str], tmp_path: Path
    ) -> None:
        # A payload with a transcript reaches the real factory, which raises
        # CaptureNotConfiguredError; capture_stop must eat it.
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "hi", session="sess")])
        payload = json.dumps(
            {"transcript_path": str(transcript), "session_id": "sess"}
        )

        stop.capture_stop_with(io.StringIO(payload), _unconfigured_settings())

        assert capsys.readouterr().out == ""


def _unconfigured_settings() -> CaptureSettings:
    """A CaptureSettings with no endpoint or token -- capture is not set up."""
    return CaptureSettings()


class _StallingEndpoint:
    """A TCP listener that accepts a connection and never answers it.

    This is the failure the timeout budget exists for: an endpoint that is up
    enough to accept the socket but never sends a byte back. Without a client
    timeout the request blocks on the read until the OS gives up, far past the
    5-second Stop deadline, and Claude Code kills the process mid-capture.
    """

    def __init__(self) -> None:
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind(("127.0.0.1", 0))
        self._server.listen(8)
        self.port = self._server.getsockname()[1]
        self._accepted: list[socket.socket] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._accept_and_hold, daemon=True)
        self._thread.start()

    def _accept_and_hold(self) -> None:
        self._server.settimeout(0.25)
        while not self._stop.is_set():
            try:
                conn, _addr = self._server.accept()
            except OSError:
                continue
            # Hold the connection open and send nothing -- the client's read
            # blocks until ITS timeout fires, which is the whole point.
            self._accepted.append(conn)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2.0)
        for conn in self._accepted:
            conn.close()
        self._server.close()


@pytest.fixture
def stalling_endpoint() -> object:
    """A stalling TCP endpoint, torn down after the test."""
    endpoint = _StallingEndpoint()
    try:
        yield endpoint
    finally:
        endpoint.close()


class TestStopSurvivesAStalledEndpointWithinTheDeadline:
    """The structural time budget: a stalled endpoint cannot outlast the deadline.

    Drives the REAL ``_started_memory`` factory (no injected lane) against a
    socket that accepts and never responds. The client's per-request timeout,
    with retry pinned to one attempt, bounds the worst-case wall time under
    Claude Code's 5-second Stop deadline. The turn is not lost: the watermark is
    left unmoved, so the next Stop re-reads it.
    """

    def test_main_returns_zero_fast_and_leaves_the_watermark_unmoved(
        self,
        capsys: pytest.CaptureFixture[str],
        tmp_path: Path,
        stalling_endpoint: _StallingEndpoint,
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(
            transcript, [operator_line("u1", "held hostage", session="sess")]
        )
        watermark = tmp_path / "wm.sqlite"
        settings = CaptureSettings(
            base_url=stalling_endpoint.base_url,
            token="tok",  # noqa: S106 -- not a real secret
            watermark_path=watermark,
        )
        payload = json.dumps(
            {"transcript_path": str(transcript), "session_id": "sess"}
        )

        start = time.monotonic()
        # capture_stop_with(settings=...) reaches the real factory and dials the
        # stalling endpoint, then swallows the timeout.
        stop.capture_stop_with(io.StringIO(payload), settings)
        elapsed = time.monotonic() - start

        # Under the deadline, with headroom -- the harness would not have killed
        # it. This is the acceptance criterion the budget exists to satisfy.
        assert elapsed < STOP_HOOK_DEADLINE_SECONDS
        # The Stop contract held: empty stdout, and no exception escaped.
        assert capsys.readouterr().out == ""
        # The turn was NOT delivered, so the watermark never advanced -- the next
        # Stop re-reads it. No watermark file, or a zero offset, both prove it.
        store = WatermarkStore(watermark)
        assert asyncio_run(store.offset_for("sess")) == 0


def asyncio_run(coro: object) -> object:
    """Run a coroutine to completion -- a tiny shim so the sync test can await."""
    import asyncio

    return asyncio.run(coro)  # type: ignore[arg-type]


def _make_scripted_handler(
    server: _ScriptedMCPServer,
) -> type[BaseHTTPRequestHandler]:
    """Build a request handler bound to one scripted server.

    The handler is a thin adapter: it reads the body, pays the configured delay,
    asks the server for the reply, and writes it. All routing choices live on the
    server, so this stays trivial and the server holds the test-visible state.
    """

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:  # noqa: D401 - silence logs
            return

        def _write(self, reply: _ScriptedReply) -> None:
            status, body, headers = reply
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_DELETE(self) -> None:  # noqa: N802 - http.server naming
            server.delay()
            self._write(server.delete_reply())

        def do_POST(self) -> None:  # noqa: N802 - http.server naming
            server.delay()
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b""
            try:
                payload = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                payload = {}
            self._write(server.reply_for(payload))

    return Handler


#: One scripted reply: the HTTP status, the JSON body, and any extra headers.
_ScriptedReply = tuple[int, bytes, dict[str, str]]


def _jsonrpc_ok(request_id: object, result: dict[str, object]) -> bytes:
    return json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}).encode()


def _tool_ok_body(request_id: object) -> bytes:
    return _jsonrpc_ok(
        request_id,
        {"content": [{"type": "text", "text": json.dumps({"ok": 1})}]},
    )


class _ScriptedMCPServer:
    """A real localhost MCP endpoint that speaks the five-request lifecycle.

    The stalling endpoint above proves the timeout on a socket that answers
    NOTHING; these tests need one that answers, and can be told HOW: return a 429
    with ``Retry-After`` on ``session_start``, or add a real per-request delay to
    every leg. It drives the REAL ``_started_memory`` factory end to end, so what
    it observes is proof about the factory's own wiring -- both retry policies,
    the close on the startup path -- not about a stubbed lane.

    It counts each request kind and records whether the ``DELETE`` (session
    close) ever arrived, so a test can assert on exactly-once calls and on
    slot release. ``request_delay_seconds`` sleeps inside EVERY handler, so the
    worst-case wall time is the whole lifecycle paying the delay, which is what
    the per-request-timeout budget is sized against.

    The routing lives on the server (``reply_for``/``delete_reply``), not in the
    nested handler, so the handler stays a thin adapter: read, delay, delegate,
    write.
    """

    def __init__(
        self,
        *,
        session_start_status: int = 200,
        session_start_retry_after: str | None = None,
        request_delay_seconds: float = 0.0,
    ) -> None:
        self.session_start_status = session_start_status
        self.session_start_retry_after = session_start_retry_after
        self.request_delay_seconds = request_delay_seconds
        self.counts: dict[str, int] = {}
        self.deleted = False
        self._lock = threading.Lock()

        self._server = ThreadingHTTPServer(
            ("127.0.0.1", 0), _make_scripted_handler(self)
        )
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(
            target=self._server.serve_forever, daemon=True
        )
        self._thread.start()

    def _bump(self, name: str) -> None:
        with self._lock:
            self.counts[name] = self.counts.get(name, 0) + 1

    def delay(self) -> None:
        if self.request_delay_seconds > 0:
            time.sleep(self.request_delay_seconds)

    def delete_reply(self) -> _ScriptedReply:
        with self._lock:
            self.deleted = True
        self._bump("delete")
        return 200, b"{}", {}

    def reply_for(self, payload: Mapping[str, object]) -> _ScriptedReply:
        method = payload.get("method")
        request_id = payload.get("id")
        if method == "initialize":
            self._bump("initialize")
            body = _jsonrpc_ok(
                request_id,
                {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "serverInfo": {"name": "scripted", "version": "0"},
                },
            )
            return 200, body, {"Mcp-Session-Id": "scripted-sess"}
        if method == "notifications/initialized":
            self._bump("initialized")
            return 202, b"", {}
        if method == "tools/call":
            return self._reply_for_tool(payload, request_id)
        return 200, b"{}", {}

    def _reply_for_tool(
        self, payload: Mapping[str, object], request_id: object
    ) -> _ScriptedReply:
        params = payload.get("params")
        tool = params.get("name") if isinstance(params, Mapping) else None
        self._bump(f"tool:{tool}")
        if tool == "session_start" and self.session_start_status != 200:
            headers = (
                {"Retry-After": self.session_start_retry_after}
                if self.session_start_retry_after is not None
                else {}
            )
            body = json.dumps({"error": "rate limited"}).encode()
            return self.session_start_status, body, headers
        return 200, _tool_ok_body(request_id), {}

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def count(self, name: str) -> int:
        with self._lock:
            return self.counts.get(name, 0)

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2.0)


def _scripted_settings(server: _ScriptedMCPServer, watermark: Path) -> CaptureSettings:
    return CaptureSettings(
        base_url=server.base_url,
        token="tok",  # noqa: S106 -- not a real secret
        watermark_path=watermark,
    )


class TestSessionStart429MakesExactlyOneCall:
    """R1: a 429+Retry-After on session_start fires ONE call, under the deadline.

    Before the fix, AgentMemory kept the sibling default of two attempts, so a
    single 429 on session_start independently retried -- two calls -- while the
    client had already been pinned to one. This drives the REAL factory, so the
    single call it observes is proof AgentMemory received attempts=1 too. And
    because attempts=1 means with_retry never sleeps, the Retry-After header is
    never honoured, so the process cannot be parked past the budget.
    """

    def test_one_call_and_under_deadline(
        self, capsys: pytest.CaptureFixture[str], tmp_path: Path
    ) -> None:
        server = _ScriptedMCPServer(
            session_start_status=429,
            # A large Retry-After: if it were ever honoured, the wall time would
            # blow the deadline. attempts=1 means it is not.
            session_start_retry_after="30",
        )
        try:
            transcript = tmp_path / "t.jsonl"
            write_lines(
                transcript, [operator_line("u1", "one call only", session="sess")]
            )
            watermark = tmp_path / "wm.sqlite"
            settings = _scripted_settings(server, watermark)
            payload = json.dumps(
                {"transcript_path": str(transcript), "session_id": "sess"}
            )

            start = time.monotonic()
            stop.capture_stop_with(io.StringIO(payload), settings)
            elapsed = time.monotonic() - start

            # Exactly one session_start attempt -- the retry pinning held on BOTH
            # the client and AgentMemory.
            assert server.count("tool:session_start") == 1
            # The Retry-After was NOT slept on: well under the deadline.
            assert elapsed < STOP_HOOK_DEADLINE_SECONDS
            assert capsys.readouterr().out == ""
            # The turn was not delivered (session_start failed), so the watermark
            # never advanced -- the next Stop re-reads it.
            assert asyncio_run(WatermarkStore(watermark).offset_for("sess")) == 0
        finally:
            server.close()


class TestEveryRequestDelayedStillFitsTheDeadline:
    """R1: a delay on EVERY leg of the lifecycle still exits 0 under the deadline.

    The old comment sized the budget against four calls and 1.0 s each; the real
    lifecycle is five requests including the closing DELETE. This puts a real
    per-request delay on all five and proves the whole run still finishes under
    the deadline with the watermark unmoved -- the arithmetic the constant block
    documents, exercised rather than asserted on paper.
    """

    def test_all_five_legs_delayed_exits_zero_fast(
        self, capsys: pytest.CaptureFixture[str], tmp_path: Path
    ) -> None:
        # A delay on every request. Five legs at 0.2 s is 1.0 s of pure network
        # wait, well under the per-request timeout on each and under the whole
        # deadline -- the point is that the delay lands on EVERY leg, DELETE
        # included, not just initialize.
        server = _ScriptedMCPServer(request_delay_seconds=0.2)
        try:
            transcript = tmp_path / "t.jsonl"
            write_lines(
                transcript, [operator_line("u1", "delayed everywhere", session="sess")]
            )
            watermark = tmp_path / "wm.sqlite"
            settings = _scripted_settings(server, watermark)
            payload = json.dumps(
                {"transcript_path": str(transcript), "session_id": "sess"}
            )

            start = time.monotonic()
            stop.capture_stop_with(io.StringIO(payload), settings)
            elapsed = time.monotonic() - start

            assert elapsed < STOP_HOOK_DEADLINE_SECONDS
            assert capsys.readouterr().out == ""
            # Every leg was reached, DELETE included -- the delay hit all five.
            assert server.count("initialize") == 1
            assert server.count("tool:session_start") == 1
            assert server.count("tool:ingest_raw_turn") == 1
            assert server.count("delete") == 1
            # A full clean delivery: this run succeeded, so the watermark advanced
            # to EOF -- the delay never broke the write, it only slowed it.
            stored = asyncio_run(WatermarkStore(watermark).offset_for("sess"))
            assert stored == transcript.stat().st_size
        finally:
            server.close()


class TestStartupFailureReleasesTheSessionSlot:
    """R2: session_start failing AFTER initialize still closes the server session.

    initialize allocates the slot; if session_start then raises, the factory has
    not returned the StartedLane whose close run_stop's finally would call, so
    the slot would leak on the STARTUP path -- the same leak the delivery-path
    close() fix addressed, one step earlier. The factory now closes the client
    and re-raises. Proof: the DELETE arrives even though session_start failed.
    """

    def test_delete_is_issued_when_session_start_fails(
        self, capsys: pytest.CaptureFixture[str], tmp_path: Path
    ) -> None:
        server = _ScriptedMCPServer(session_start_status=500)
        try:
            transcript = tmp_path / "t.jsonl"
            write_lines(
                transcript, [operator_line("u1", "no leak", session="sess")]
            )
            watermark = tmp_path / "wm.sqlite"
            settings = _scripted_settings(server, watermark)
            payload = json.dumps(
                {"transcript_path": str(transcript), "session_id": "sess"}
            )

            stop.capture_stop_with(io.StringIO(payload), settings)

            # initialize opened the slot, session_start failed, and the factory's
            # cleanup released the slot on the way out.
            assert server.count("initialize") == 1
            assert server.count("tool:session_start") == 1
            assert server.deleted is True
            # ingest never ran -- the lane was never returned to the spine.
            assert server.count("tool:ingest_raw_turn") == 0
            # Entrypoint swallowed it: exit contract held.
            assert capsys.readouterr().out == ""
            assert asyncio_run(WatermarkStore(watermark).offset_for("sess")) == 0
        finally:
            server.close()


#: The canon-only default the ruling mandates: exactly the three
#: structured-guidance sections, nothing episodic.
CANON_DEFAULT_SECTIONS = ("profile_guidance", "process_guidance", "repo_facts")

#: Sections that are BACK-HISTORY -- auto-loading any of these on session start
#: is exactly what the ruling forbids. The default must contain none of them.
EPISODIC_SECTIONS = (
    "working_set",
    "durable_memory",
    "durable_lane_context",
    "recovery",
    "candidate_memory",
    "pointers",
)


def canon_settings(**overrides: object) -> CanonSettings:
    """A configured CanonSettings; endpoint values are inert under an injected factory.

    ``run_session_start`` with an injected ``canon_factory`` never builds a real
    client, so ``base_url``/``token`` here are never dialed. They exist because a
    configured canon carries them, not because the test reaches a service.
    """
    values: dict[str, object] = {
        "base_url": "http://127.0.0.1:0",
        "token": "unused-in-injected-canon-tests",  # noqa: S106 -- not a real secret
    }
    values.update(overrides)
    return CanonSettings(**values)


class TestSessionStartParsesTheCapturedPayload:
    """The SessionStart fixture yields the source and session id canon reads."""

    def test_source_and_session_are_read_from_the_real_bytes(self) -> None:
        payload = SessionStartHook.model_validate_json(fixture_bytes("SessionStart"))
        captured = json.loads(fixture_bytes("SessionStart"))
        assert payload.session_id == captured["session_id"]
        assert payload.source == captured["source"]

    def test_the_startup_fixture_is_the_startup_source(self) -> None:
        # The stored fixture is a fresh session -- source "startup". The other
        # variants (resume/compact/clear/fork) are the same do-canon path.
        payload = SessionStartHook.model_validate_json(fixture_bytes("SessionStart"))
        assert payload.source == "startup"


class TestSessionStartRequestsCanonOnly:
    """run_session_start requests the always-known layer and NOTHING episodic."""

    async def test_the_default_requests_exactly_the_three_canon_sections(self) -> None:
        reader = CanonPackReader()
        payload = SessionStartHook(session_id="sess", source="startup")

        await run_session_start(payload, canon_settings(), canon_factory=reader)

        # The factory was handed settings whose sections are canon-only.
        assert len(reader.requested) == 1
        assert reader.requested[0].sections == CANON_DEFAULT_SECTIONS

    def test_the_settings_default_is_canon_only(self) -> None:
        # Grounded in canon.md: profile_guidance (User), process_guidance (Soul:
        # rules/LAWs/standards/persona), repo_facts (this repo, scope-bound).
        assert CanonSettings().sections == CANON_DEFAULT_SECTIONS

    def test_no_episodic_section_is_in_the_default(self) -> None:
        # The whole ruling: back-history poisons a fresh start, so none of it is
        # auto-loaded. This is the regression guard on that invariant.
        default = set(CanonSettings().sections)
        assert default.isdisjoint(EPISODIC_SECTIONS)

    async def test_the_read_slot_is_released(self) -> None:
        reader = CanonPackReader()
        payload = SessionStartHook(session_id="sess", source="startup")

        await run_session_start(payload, canon_settings(), canon_factory=reader)

        assert reader.closed == 1

    async def test_an_empty_sections_override_reads_nothing(self) -> None:
        # An explicit empty override means "inject nothing" -- no factory call,
        # no pack, no injection. The default is canon-only, never empty.
        reader = CanonPackReader()
        payload = SessionStartHook(session_id="sess", source="startup")

        pack = await run_session_start(
            payload, canon_settings(sections=()), canon_factory=reader
        )

        assert pack is None
        assert reader.requested == []
        assert reader.closed == 0

    async def test_the_whole_pack_is_returned_untouched(self) -> None:
        # No truncation, shortening, or reshaping anywhere -- the pack the server
        # assembled is what the capability returns, byte-for-byte.
        pack = {
            "schema": "openbrain.agent_context_pack.v1",
            "sections": {
                "profile_guidance": {"items": ["x" * 5000]},
                "process_guidance": {"items": ["rule"]},
                "repo_facts": {"items": []},
            },
        }
        reader = CanonPackReader(pack=pack)
        payload = SessionStartHook(session_id="sess", source="startup")

        returned = await run_session_start(
            payload, canon_settings(), canon_factory=reader
        )

        assert returned is pack


class TestSessionStartBindsRepoFromCwd:
    """repo_facts binds to the repo the session is IN, not a literal (#517).

    The regression: ``CanonSettings.repo`` defaulted to ``"open-brain"`` and the
    hook never looked at ``cwd``, so every session on the machine -- Development
    root, king repos, anywhere -- was served open-brain's repo facts. Proven
    live 2026-08-03 against the dogfood DB (Development has 1 bound fact; the
    emission returned open-brain's 7).
    """

    async def test_repo_is_derived_from_the_payload_cwd(self, tmp_path) -> None:
        root = tmp_path / "King-Core"
        (root / ".git").mkdir(parents=True)
        nested = root / "src" / "deep"
        nested.mkdir(parents=True)
        reader = CanonPackReader()
        payload = SessionStartHook(session_id="sess", source="startup", cwd=nested)

        await run_session_start(payload, canon_settings(), canon_factory=reader)

        assert reader.requested[0].repo == "king-core"

    async def test_an_explicit_repo_setting_wins_over_derivation(self, tmp_path) -> None:
        root = tmp_path / "some-repo"
        (root / ".git").mkdir(parents=True)
        reader = CanonPackReader()
        payload = SessionStartHook(session_id="sess", source="startup", cwd=root)

        await run_session_start(
            payload, canon_settings(repo="pinned-repo"), canon_factory=reader
        )

        assert reader.requested[0].repo == "pinned-repo"

    async def test_a_worktree_git_file_counts_as_the_repo_root(self, tmp_path) -> None:
        root = tmp_path / "Some-Worktree"
        root.mkdir()
        (root / ".git").write_text("gitdir: elsewhere")
        reader = CanonPackReader()
        payload = SessionStartHook(session_id="sess", source="startup", cwd=root)

        await run_session_start(payload, canon_settings(), canon_factory=reader)

        assert reader.requested[0].repo == "some-worktree"

    async def test_outside_any_repo_requests_the_empty_state_not_a_fallback(
        self, tmp_path
    ) -> None:
        # None is the honest binding: the server serves the defined empty state
        # (agent-context-pack-repo-facts.ts), never another repo's facts.
        reader = CanonPackReader()
        payload = SessionStartHook(session_id="sess", source="startup", cwd=tmp_path)

        await run_session_start(payload, canon_settings(), canon_factory=reader)

        assert reader.requested[0].repo is None

    async def test_a_missing_cwd_requests_the_empty_state(self) -> None:
        reader = CanonPackReader()
        payload = SessionStartHook(session_id="sess", source="startup")

        await run_session_start(payload, canon_settings(), canon_factory=reader)

        assert reader.requested[0].repo is None


class TestStartupLaneResume:
    """Emission two carries the repo lane's recent state (#519).

    Operator amendment 2026-08-03 to the canon-only ruling: a REPO-SCOPED lane
    resume auto-loads at session start; cross-lane history stays
    explicit-on-request. Scope is the contamination guard, so an unresolvable
    repo reads no lane at all -- there is no fallback lane.
    """

    def test_lane_key_derives_from_cwd(self, tmp_path) -> None:
        root = tmp_path / "Some-Repo"
        (root / ".git").mkdir(parents=True)
        payload = SessionStartHook(session_id="sess", source="startup", cwd=root)

        assert (
            session_start._resolve_lane_key(payload, canon_settings())
            == "dev:some-repo"
        )

    def test_an_explicit_session_key_wins(self, tmp_path) -> None:
        root = tmp_path / "some-repo"
        (root / ".git").mkdir(parents=True)
        payload = SessionStartHook(session_id="sess", source="startup", cwd=root)

        key = session_start._resolve_lane_key(
            payload, canon_settings(session_key="dev:pinned")
        )

        assert key == "dev:pinned"

    def test_outside_a_repo_reads_no_lane(self, tmp_path) -> None:
        payload = SessionStartHook(session_id="sess", source="startup", cwd=tmp_path)

        assert session_start._resolve_lane_key(payload, canon_settings()) is None

    def test_an_empty_lane_says_so_in_one_line(self) -> None:
        text = session_start._render_lane_resume(
            "dev:new-repo", {"lane": None, "events": [], "event_count": 0}
        )

        assert "No lane history for this repo yet." in text
        assert "dev:new-repo" in text

    def test_renders_only_the_newest_day_of_intent_events_whole(self) -> None:
        context = {
            "lane": {"current_context_md": "Checkpoint line one.\nMore detail."},
            "events": [
                # Newest first, as session_context returns them.
                {
                    "event_type": "decision",
                    "content": "today decision body carried whole",
                    "created_at": "2026-08-03T04:01:20+00:00",
                },
                {
                    "event_type": "fact",
                    "content": "facts are noise here",
                    "created_at": "2026-08-03T03:00:00+00:00",
                },
                {
                    "event_type": "blocker",
                    "content": "today blocker",
                    "created_at": "2026-08-03T01:00:00+00:00",
                },
                {
                    "event_type": "decision",
                    "content": "yesterday decision must not render",
                    "created_at": "2026-08-02T22:00:00+00:00",
                },
            ],
            "event_count": 4,
        }

        text = session_start._render_lane_resume("dev:open-brain", context)

        assert "Checkpoint: Checkpoint line one." in text
        assert "today decision body carried whole" in text
        assert "today blocker" in text
        assert "facts are noise here" not in text
        assert "yesterday decision must not render" not in text
        # Reading order matches time order: blocker (01:00) before decision (04:01).
        assert text.index("today blocker") < text.index("today decision body")

    def test_the_envelope_appends_the_trailer_after_the_pack(self) -> None:
        envelope = json.loads(
            session_start._injection_envelope(
                _FIXTURE_PACK, trailer="LANE RESUME (dev:x)\nline"
            )
        )

        context = envelope["hookSpecificOutput"]["additionalContext"]
        assert context.endswith("LANE RESUME (dev:x)\nline")

    def test_no_trailer_leaves_the_envelope_unchanged(self) -> None:
        with_none = session_start._injection_envelope(_FIXTURE_PACK, trailer=None)
        plain = session_start._injection_envelope(_FIXTURE_PACK)

        assert with_none == plain


def _write_injection(pack: object, out: io.StringIO) -> None:
    """Serialise a pack through the entrypoint's own envelope builder."""
    out.write(session_start._injection_envelope(pack))


#: A fixture pack shaped exactly like the live ``agent_context_pack.v1``: the two
#: real item shapes (guidance items with ``scope_key``/``guidance``/
#: ``candidate_type``; fact items with ``subject``/``fact``/``fact_type``) and the
#: envelope fields the renderer reads. Every rule text is a distinct sentinel so a
#: test can assert it survived verbatim.
_FIXTURE_PACK = {
    "schema": "openbrain.agent_context_pack.v1",
    "scope": {"namespace": "rico", "agent": "claude"},
    "sections": {
        "profile_guidance": {
            "label": "profile_guidance",
            "item_count": 2,
            "items": [
                {
                    "scope_key": "profile.who",
                    "guidance": "Rico is the operator; PROFILE-RULE-ONE in full.",
                    "candidate_type": "profile_fact",
                },
                {
                    "scope_key": "profile.adhd",
                    "guidance": "Lead with the next action; PROFILE-RULE-TWO in full.",
                    "candidate_type": "profile_fact",
                },
            ],
        },
        "process_guidance": {
            "label": "process_guidance",
            "item_count": 1,
            "items": [
                {
                    "scope_key": "process.no_tmp",
                    "guidance": "Never /tmp; PROCESS-RULE-ONE in full.",
                    "candidate_type": "process_rule",
                },
            ],
        },
        "repo_facts": {
            "label": "repo_facts",
            "item_count": 1,
            "items": [
                {
                    "subject": "repo.two_hosts",
                    "fact": "Exactly two hosts; REPO-FACT-ONE in full.",
                    "fact_type": "gotcha",
                },
            ],
        },
    },
    "warnings": {"scope_denials": [], "degraded_sources": [], "truncation": []},
}


class TestSessionStartRendersCanonAsPlainText:
    """render_pack renders every rule WHOLE as plain text -- no JSON envelope."""

    def test_every_items_rule_text_appears_verbatim(self) -> None:
        rendered = session_start.render_pack(_FIXTURE_PACK)
        # Every rule sentinel from every section survives, IN FULL.
        for section in _FIXTURE_PACK["sections"].values():
            for item in section["items"]:
                text = item.get("guidance") or item.get("fact")
                assert text in rendered

    def test_every_scope_key_and_lane_appears(self) -> None:
        rendered = session_start.render_pack(_FIXTURE_PACK)
        assert "profile.who" in rendered
        assert "process.no_tmp" in rendered
        assert "repo.two_hosts" in rendered  # a fact item keys on ``subject``
        # The lane is the item's candidate/fact type, rendered as a ``[lane]`` tag.
        assert "[process_rule]" in rendered
        assert "[gotcha]" in rendered

    def test_the_counts_line_is_correct(self) -> None:
        rendered = session_start.render_pack(_FIXTURE_PACK)
        header = rendered.splitlines()[0]
        # The header names the schema, namespace, and per-section counts.
        assert "openbrain.agent_context_pack.v1" in header
        assert "namespace=rico" in header
        assert "profile_guidance=2" in header
        assert "process_guidance=1" in header
        assert "repo_facts=1" in header

    def test_one_line_per_item_after_the_header(self) -> None:
        rendered = session_start.render_pack(_FIXTURE_PACK)
        lines = rendered.splitlines()
        # header, blank, then exactly one line per item (4 items here).
        assert lines[1] == ""
        item_lines = [ln for ln in lines[2:] if ln]
        total = sum(len(s["items"]) for s in _FIXTURE_PACK["sections"].values())
        assert len(item_lines) == total == 4

    def test_the_raw_json_envelope_is_gone(self) -> None:
        rendered = session_start.render_pack(_FIXTURE_PACK)
        # The metadata bulk that diverted the injection to a preview must not be
        # in the rendered text: no citation/confidence keys, no warnings block.
        assert "citation_id" not in rendered
        assert "candidate_type" not in rendered  # rendered as a lane tag, not a key
        assert "scope_denials" not in rendered

    def test_a_non_dict_pack_renders_empty(self) -> None:
        assert session_start.render_pack("not a pack") == ""
        assert session_start.render_pack(None) == ""

    def test_a_missing_field_does_not_raise(self) -> None:
        # A partial pack (no scope, an item missing its key) still renders its
        # rule text rather than raising.
        partial = {"sections": {"process_guidance": {"items": [{"guidance": "R"}]}}}
        rendered = session_start.render_pack(partial)
        assert "R" in rendered


class TestSessionStartSplitsCanonAcrossTwoEmissions:
    """The two hook outputs partition one pack without changing any rule text."""

    def test_default_sections_are_partitioned_without_overlap(self) -> None:
        configured = ("profile_guidance", "process_guidance", "repo_facts")

        first = session_start.sections_for_emission(
            configured, session_start.CanonEmission.PROFILE_PROCESS
        )
        second = session_start.sections_for_emission(
            configured, session_start.CanonEmission.REMAINING
        )

        assert first == ("profile_guidance", "process_guidance")
        assert second == ("repo_facts",)
        assert set(first).isdisjoint(second)
        assert first + second == configured

    def test_widened_sections_land_in_the_remaining_emission(self) -> None:
        configured = (
            "profile_guidance",
            "process_guidance",
            "repo_facts",
            "working_set",
        )

        second = session_start.sections_for_emission(
            configured, session_start.CanonEmission.REMAINING
        )

        assert second == ("repo_facts", "working_set")

    def test_each_header_names_its_sections_and_one_shared_pack(self) -> None:
        first_sections = ("profile_guidance", "process_guidance")
        second_sections = ("repo_facts",)
        first = session_start.render_pack(
            _FIXTURE_PACK,
            emission=session_start.CanonEmission.PROFILE_PROCESS,
            requested_sections=first_sections,
        )
        second = session_start.render_pack(
            _FIXTURE_PACK,
            emission=session_start.CanonEmission.REMAINING,
            requested_sections=second_sections,
        )

        assert "CANON PACK 1/2" in first.splitlines()[0]
        assert "this emission sections: profile_guidance, process_guidance" in first
        assert "CANON PACK 2/2" in second.splitlines()[0]
        assert "this emission sections: repo_facts" in second
        assert "one pack across two SessionStart emissions" in first
        assert "one pack across two SessionStart emissions" in second

    def test_every_rule_appears_whole_in_exactly_one_emission(self) -> None:
        first = session_start.render_pack(
            _FIXTURE_PACK,
            emission=session_start.CanonEmission.PROFILE_PROCESS,
            requested_sections=("profile_guidance", "process_guidance"),
        )
        second = session_start.render_pack(
            _FIXTURE_PACK,
            emission=session_start.CanonEmission.REMAINING,
            requested_sections=("repo_facts",),
        )

        for section in _FIXTURE_PACK["sections"].values():
            for item in section["items"]:
                text = item.get("guidance") or item.get("fact")
                assert (text in first) != (text in second)

        expected_first = [
            item["guidance"]
            for label in ("profile_guidance", "process_guidance")
            for item in _FIXTURE_PACK["sections"][label]["items"]
        ]
        expected_second = [
            item["fact"] for item in _FIXTURE_PACK["sections"]["repo_facts"]["items"]
        ]
        assert first.splitlines()[2:] == expected_first
        assert second.splitlines()[2:] == expected_second


class TestSessionStartEntrypointWritesTheInjection:
    """The additionalContext envelope carries the rendered canon on the happy path."""

    def test_the_envelope_shape_is_the_sessionstart_contract(self) -> None:
        out = io.StringIO()
        _write_injection(_FIXTURE_PACK, out)

        envelope = json.loads(out.getvalue())
        assert set(envelope) == {"hookSpecificOutput"}
        specific = envelope["hookSpecificOutput"]
        assert specific["hookEventName"] == "SessionStart"
        # additionalContext is a STRING carrying the RENDERED canon, not raw JSON.
        assert isinstance(specific["additionalContext"], str)
        assert specific["additionalContext"] == session_start.render_pack(_FIXTURE_PACK)
        # And it is plain text, not a re-parseable pack object.
        with pytest.raises(json.JSONDecodeError):
            json.loads(specific["additionalContext"])

    def test_the_injected_rule_text_is_whole(self) -> None:
        # A large rule body survives into additionalContext with no bound.
        big = "y" * 20000
        pack = {
            "sections": {
                "process_guidance": {"items": [{"scope_key": "big", "guidance": big}]}
            }
        }
        out = io.StringIO()
        _write_injection(pack, out)

        envelope = json.loads(out.getvalue())
        assert big in envelope["hookSpecificOutput"]["additionalContext"]

    def test_the_entrypoint_writes_the_envelope_end_to_end(self) -> None:
        # inject_canon_with, real path but injected factory via monkeypatch-free
        # override of the module factory would be heavier; drive the capability's
        # own return through the envelope by pointing the real factory at a reader.
        reader = CanonPackReader(pack=_FIXTURE_PACK)
        import openbrain.apps.hooks.session as session_mod

        original = session_mod._canon_context
        session_mod._canon_context = reader  # type: ignore[assignment]
        try:
            out = io.StringIO()
            session_start.inject_canon_with(
                io.StringIO(fixture_bytes("SessionStart")), out, canon_settings()
            )
        finally:
            session_mod._canon_context = original  # type: ignore[assignment]

        envelope = json.loads(out.getvalue())
        context = envelope["hookSpecificOutput"]["additionalContext"]
        assert context == session_start.render_pack(
            _FIXTURE_PACK,
            emission=session_start.CanonEmission.PROFILE_PROCESS,
            requested_sections=("profile_guidance", "process_guidance"),
        )
        assert "PROFILE-RULE-ONE in full." in context
        assert "PROCESS-RULE-ONE in full." in context
        assert "REPO-FACT-ONE in full." not in context

    def test_the_remaining_entrypoint_writes_repo_facts(self) -> None:
        reader = CanonPackReader(pack=_FIXTURE_PACK)
        import openbrain.apps.hooks.session as session_mod

        original = session_mod._canon_context
        session_mod._canon_context = reader  # type: ignore[assignment]
        try:
            out = io.StringIO()
            session_start.inject_canon_remaining_with(
                io.StringIO(fixture_bytes("SessionStart")), out, canon_settings()
            )
        finally:
            session_mod._canon_context = original  # type: ignore[assignment]

        envelope = json.loads(out.getvalue())
        context = envelope["hookSpecificOutput"]["additionalContext"]
        assert context == session_start.render_pack(
            _FIXTURE_PACK,
            emission=session_start.CanonEmission.REMAINING,
            requested_sections=("repo_facts",),
        )
        assert "REPO-FACT-ONE in full." in context
        assert "PROFILE-RULE-ONE in full." not in context
        assert "PROCESS-RULE-ONE in full." not in context


class TestSessionStartEntrypointNeverDisruptsTheSession:
    """inject_canon fails open: every fault leaves stdout empty and the session opens."""

    def test_a_malformed_payload_is_swallowed_with_empty_stdout(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        out = io.StringIO()
        session_start.inject_canon(io.StringIO("{not json"), out)
        assert out.getvalue() == ""
        assert capsys.readouterr().out == ""

    def test_an_unconfigured_canon_is_swallowed_with_empty_stdout(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # The real fixture carries a session_id, so the real factory is reached;
        # an unconfigured canon raises CanonNotConfiguredError, which the
        # entrypoint must eat and write nothing.
        out = io.StringIO()
        session_start.inject_canon_with(
            io.StringIO(fixture_bytes("SessionStart")), out, CanonSettings()
        )
        assert out.getvalue() == ""
        assert capsys.readouterr().out == ""

    def test_main_returns_zero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("sys.stdin", io.StringIO("{not json"))
        assert session_start.main() == 0

    def test_stdin_content_never_reaches_the_log(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """A sentinel in a malformed payload must not appear in any log output.

        Same content-free-by-construction guarantee the Stop entrypoint proves:
        a pydantic ValidationError carries its input_value (the raw stdin), and
        loguru's diagnose would render it. Only the class name is logged.
        """
        from loguru import logger

        sink = io.StringIO()
        sink_id = logger.add(sink, backtrace=True, diagnose=True, level="WARNING")
        try:
            payload = '{"session_id": ["SECRET-CANON-SENTINEL"], "source": "startup"}'
            session_start.inject_canon(io.StringIO(payload), io.StringIO())
        finally:
            logger.remove(sink_id)

        assert "SECRET-CANON-SENTINEL" not in sink.getvalue()
        assert "SECRET-CANON-SENTINEL" not in capsys.readouterr().err
        assert "SessionStart canon injection failed" in sink.getvalue()


class TestSessionStartUnreachableCanonFailsOpen:
    """An unreachable brain leaves the session opening with no injection."""

    async def test_a_failed_read_raises_from_the_capability(self) -> None:
        # The capability surfaces the failure (its tests see it); the entrypoint
        # is what swallows it.
        reader = CanonPackReader(fail=True)
        payload = SessionStartHook(session_id="sess", source="startup")

        with pytest.raises(RuntimeError):
            await run_session_start(payload, canon_settings(), canon_factory=reader)

    def test_the_entrypoint_swallows_it_and_writes_nothing(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # Point the real module factory at an unreachable read; inject_canon_with
        # must eat it with empty stdout.
        reader = CanonPackReader(fail=True)
        import openbrain.apps.hooks.session as session_mod

        original = session_mod._canon_context
        session_mod._canon_context = reader  # type: ignore[assignment]
        try:
            out = io.StringIO()
            session_start.inject_canon_with(
                io.StringIO(fixture_bytes("SessionStart")), out, canon_settings()
            )
        finally:
            session_mod._canon_context = original  # type: ignore[assignment]

        assert out.getvalue() == ""
        assert capsys.readouterr().out == ""


class TestUnconfiguredCanonFailsAtUseNotAtLoad:
    """base_url/token are optional so a non-hook process loads; a hook needs both."""

    async def test_run_session_start_raises_when_no_endpoint_or_token(self) -> None:
        # No canon_factory: run_session_start uses the real _canon_context, which
        # checks config before importing or dialing anything.
        payload = SessionStartHook(session_id="sess", source="startup")

        with pytest.raises(CanonNotConfiguredError):
            await run_session_start(payload, CanonSettings())
