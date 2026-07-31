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
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from conftest import RecordingLane, UnreachableLane, operator_line, write_lines
from openbrain.apps.capture.watermark import WatermarkStore
from openbrain.apps.hooks import stop
from openbrain.apps.hooks.dispatch import ENTRYPOINTS
from openbrain.apps.hooks.session import (
    CaptureNotConfiguredError,
    StopHook,
    run_stop,
)
from openbrain.config import CaptureSettings

if TYPE_CHECKING:
    from typing import TextIO

FIXTURES = Path(__file__).parent / "fixtures" / "captured_hooks"

#: The verified events with a fixture and an entrypoint. ``PostCompact`` is
#: absent because it was never captured (fixtures README); its stdin is unknown.
CAPTURED_EVENTS = (
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "SessionEnd",
    "PreToolUse",
    "PostToolUse",
    "SubagentStop",
    "PreCompact",
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
        # Stop reaches load_settings, which needs capture config; the stubs do
        # not. Test Stop's real behaviour separately -- here, only that a
        # dispatch entry exists and the stubs run clean over real input.
        entrypoint = ENTRYPOINTS[event]
        assert callable(entrypoint)
        if event != "Stop":
            assert entrypoint(stream_for(event)) == 0
            assert capsys.readouterr().out == ""

    def test_the_table_covers_exactly_the_captured_events(self) -> None:
        """A key with no fixture, or a fixture with no key, is a drift bug."""
        assert set(ENTRYPOINTS) == set(CAPTURED_EVENTS)

    def test_postcompact_has_no_entrypoint(self) -> None:
        """The uncaptured event must not have been invented a stdin shape."""
        assert "PostCompact" not in ENTRYPOINTS
        assert not (FIXTURES / "PostCompact.json").exists()


class TestStubsDrainAndExitZero:
    """A stub consumes its payload and acts on nothing."""

    STUB_EVENTS = tuple(e for e in CAPTURED_EVENTS if e != "Stop")

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

        result = await run_stop(payload, settings, lane_factory=lambda _s, _k: lane)

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
            payload, settings, lane_factory=lambda _s, _k: RecordingLane()
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
            await run_stop(payload, settings, lane_factory=lambda _s, _k: broken)

        assert broken.calls == 1
        assert await WatermarkStore(watermark).offset_for("sess") == 0


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
