"""Codex rollout records traverse the existing Stop capture spine."""

import io
import json
import sqlite3
import time
from pathlib import Path

import pytest

from conftest import (
    FailAfterNBatchesLane,
    LaneUnreachableError,
    RecordingLane,
    UnreachableLane,
    operator_line,
)
from openbrain.apps.bulk.formats import MalformedCodexRecordError
from openbrain.apps.capture.deliver import SERVER_BATCH, CaptureSourceChangedError
from openbrain.apps.capture.watermark import WatermarkStore
from openbrain.apps.hooks import stop
from openbrain.apps.hooks.session import (
    StartedLane,
    StopHook,
    _capture_origin,
    _scoped_watermark_key,
    run_stop,
)
from openbrain.config import CaptureSettings

FIXTURE = (
    Path(__file__).parents[3]
    / "scripts"
    / "done-means"
    / "fixtures"
    / "512-codex-rollout.jsonl"
)
FIXTURE_SESSION = "fixture-session-512"
MALFORMED_SESSION = "malformed-codex"
TUI_FIXTURE = FIXTURE.with_name("512-codex-tui-stop.jsonl")
TUI_SESSION = "fixture-tui-session-512"
TUI_TURN = "fixture-tui-turn-512"


def _settings(watermark: Path) -> CaptureSettings:
    """Build inert settings for the injected recording lane."""
    return CaptureSettings(
        base_url="http://127.0.0.1:0",
        token="unused-in-injected-lane-tests",  # noqa: S106
        watermark_path=watermark,
    )


def _started(lane: RecordingLane) -> StartedLane:
    """Wrap the recorder with the session lifecycle shape run_stop owns."""
    return StartedLane(lane=lane, close=lambda: None)


def _scoped_key(settings: CaptureSettings, session: str) -> str:
    """Return the auth-bound watermark key used by the Stop spine."""
    origin = _capture_origin(settings)
    assert origin is not None
    return _scoped_watermark_key(origin, session)


class TestCodexStopCapture:
    """A Codex Stop delivers speech while preserving the capture invariants."""

    async def test_delivers_both_roles_and_filters_non_speech(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "rollout.jsonl"
        transcript.write_bytes(FIXTURE.read_bytes())
        watermark = tmp_path / "watermark.sqlite"
        lane = RecordingLane()
        payload = StopHook(
            transcript_path=transcript,
            session_id=FIXTURE_SESSION,
        )

        settings = _settings(watermark)
        result = await run_stop(
            payload,
            settings,
            lane_factory=lambda _settings, _session: _started(lane),
        )

        assert result is not None
        assert result.delivered == 2
        assert [turn["role"] for turn in lane.turns] == ["user", "assistant"]
        assert [turn["is_human_prompt"] for turn in lane.turns] == [True, False]
        assert [turn["session_ref"] for turn in lane.turns] == [
            FIXTURE_SESSION,
            FIXTURE_SESSION,
        ]
        assert len(lane.turns) < len(FIXTURE.read_text().splitlines())
        assert await WatermarkStore(watermark).offset_for(
            _scoped_key(settings, FIXTURE_SESSION)
        ) == transcript.stat().st_size

        with transcript.open("a", encoding="utf-8") as handle:
            _ = handle.write(
                '{"timestamp":"2026-08-09T18:23:00.000Z","type":"event_msg",'
                '"payload":{"type":"user_message","message":"after watermark",'
                '"images":[],"local_images":[],"audio":[],"local_audio":[],'
                '"text_elements":[]}}\n'
            )

        resumed = await run_stop(
            payload,
            _settings(watermark),
            lane_factory=lambda _settings, _session: _started(lane),
        )

        assert resumed is not None
        assert resumed.delivered == 1
        assert lane.turns[-1]["session_ref"] == FIXTURE_SESSION

    async def test_malformed_codex_event_does_not_advance_watermark(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "rollout.jsonl"
        transcript.write_text(
            '{"type":"event_msg","payload":{"type":"task_complete"}}\n'
        )
        watermark = tmp_path / "watermark.sqlite"
        lane = RecordingLane()
        payload = StopHook(transcript_path=transcript, session_id=MALFORMED_SESSION)

        with pytest.raises(MalformedCodexRecordError):
            await run_stop(
                payload,
                _settings(watermark),
                lane_factory=lambda _settings, _session: _started(lane),
            )

        assert lane.turns == []
        assert await WatermarkStore(watermark).offset_for(MALFORMED_SESSION) == 0

    async def test_tui_stop_captures_only_operator_and_final_reply_before_task_complete(
        self, tmp_path: Path
    ) -> None:
        """Native TUI writes task_complete after Stop, and injects a fake user record."""
        transcript = tmp_path / "rollout.jsonl"
        transcript.write_bytes(TUI_FIXTURE.read_bytes())
        watermark = tmp_path / "watermark.sqlite"
        lane = RecordingLane()
        # The extra native Stop fields are accepted but ignored by StopHook;
        # the asserted assistant identity comes from transcript metadata.
        payload = StopHook(
            transcript_path=transcript,
            session_id=TUI_SESSION,
            turn_id=TUI_TURN,
            last_assistant_message="fixture TUI assistant reply",
            stop_hook_active=False,
        )

        settings = _settings(watermark)
        first = await run_stop(
            payload,
            settings,
            lane_factory=lambda _settings, _session: _started(lane),
        )

        assert first is not None and first.delivered == 2
        assert [turn["role"] for turn in lane.turns] == ["user", "assistant"]
        assert [turn["content"] for turn in lane.turns] == [
            "fixture TUI operator prompt",
            "fixture TUI assistant reply",
        ]
        assert [turn["session_ref"] for turn in lane.turns] == [
            TUI_SESSION,
            TUI_SESSION,
        ]
        assert [turn["turn_uuid"] for turn in lane.turns if turn["role"] == "assistant"] == [TUI_TURN]
        assert await WatermarkStore(watermark).offset_for(
            _scoped_key(settings, TUI_SESSION)
        ) == transcript.stat().st_size

        with transcript.open("a", encoding="utf-8") as handle:
            _ = handle.write(
                '{"timestamp":"2026-09-16T20:00:05.000Z","type":"event_msg",'
                '"payload":{"type":"task_complete","turn_id":"fixture-tui-turn-512",'
                '"last_agent_message":"fixture TUI assistant reply","started_at":1,'
                '"completed_at":5,"duration_ms":4000}}\n'
            )

        second = await run_stop(
            payload,
            _settings(watermark),
            lane_factory=lambda _settings, _session: _started(lane),
        )
        assert second is not None and second.delivered == 1
        assert [turn["turn_uuid"] for turn in lane.turns if turn["role"] == "assistant"] == [
            TUI_TURN,
            TUI_TURN,
        ]
        # The server's UNIQUE(namespace, turn_uuid) keeps one durable assistant.
        assert len({turn["turn_uuid"] for turn in lane.turns}) == 2

    def test_failed_final_stop_recovers_from_next_session_in_same_namespace(  # noqa: PLR0915
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A closed session cannot issue another Stop to retry its final turn."""
        import openbrain.apps.hooks.session as session_mod

        watermark = tmp_path / "watermark.sqlite"
        alpha = RecordingLane()
        beta = RecordingLane()
        fail_first_alpha = True

        def factory(settings: CaptureSettings, _session: str) -> StartedLane:
            nonlocal fail_first_alpha
            token = settings.token.get_secret_value() if settings.token else ""
            if (
                token == "alpha"  # noqa: S105 -- test token
                and settings.agent_id == "agent-a"
                and fail_first_alpha
            ):
                fail_first_alpha = False
                raise ConnectionError
            return _started(alpha if settings.agent_id == "agent-a" else beta)

        monkeypatch.setattr(session_mod, "_started_memory", factory)

        def fire(session: str, turn: str, token: str, agent_id: str) -> Path:
            transcript = tmp_path / f"{session}.jsonl"
            transcript.write_text(
                TUI_FIXTURE.read_text(encoding="utf-8")
                .replace(TUI_SESSION, session)
                .replace(TUI_TURN, turn),
                encoding="utf-8",
            )
            payload = json.dumps(
                {"transcript_path": str(transcript), "session_id": session}
            )
            stop.capture_stop_with(
                io.StringIO(payload),
                CaptureSettings(
                    base_url="http://127.0.0.1:0",
                    token=token,
                    watermark_path=watermark,
                    agent_id=agent_id,
                ),
                notices=io.StringIO(),
            )
            return transcript

        # A is the final Stop of its session. Its transport fails and that
        # process exits, leaving no automatic same-session retry opportunity.
        a = fire("session-a", "turn-a", "alpha", "agent-a")
        assert alpha.turns == []
        assert beta.turns == []
        with sqlite3.connect(watermark) as database:
            assert database.execute("SELECT count(*) FROM watermark").fetchone() == (0,)

        # A different token owns a different namespace. Its healthy Stop must
        # not receive or acknowledge A's pending transcript.
        fire("session-beta", "turn-beta", "beta", "agent-b")
        assert [turn["session_ref"] for turn in beta.turns] == [
            "session-beta",
            "session-beta",
        ]
        assert alpha.turns == []

        # The same token with a different configured agent is also a different
        # origin. It must not receive A's pending transcript.
        fire("session-foreign-agent", "turn-foreign-agent", "alpha", "agent-b")
        assert [turn["session_ref"] for turn in beta.turns] == [
            "session-beta",
            "session-beta",
            "session-foreign-agent",
            "session-foreign-agent",
        ]
        assert alpha.turns == []

        # A later healthy session under A's token must recover the closed
        # session's exact turns, retaining original identity and session_ref.
        fire("session-b", "turn-b", "alpha", "agent-a")
        assert [turn["session_ref"] for turn in alpha.turns] == [
            "session-b",
            "session-b",
            "session-a",
            "session-a",
        ]
        assert [turn["turn_uuid"] for turn in alpha.turns if turn["role"] == "assistant"] == [
            "turn-b",
            "turn-a",
        ]
        assert [turn["role"] for turn in alpha.turns] == [
            "user",
            "assistant",
            "user",
            "assistant",
        ]
        assert len({turn["turn_uuid"] for turn in alpha.turns}) == 4
        assert a.stat().st_size > 0

    async def test_stale_pending_completion_keeps_new_generation(
        self, tmp_path: Path
    ) -> None:
        """An old Stop cannot delete a locator refreshed by a newer Stop."""
        transcript = tmp_path / "rollout.jsonl"
        transcript.write_text(operator_line("a", "pending") + "\n", encoding="utf-8")
        store = WatermarkStore(tmp_path / "watermark.sqlite")

        first = await store.register_pending("origin-a", "session-a", transcript)
        second = await store.register_pending("origin-a", "session-a", transcript)

        assert second.generation == first.generation + 1
        await store.complete_pending("origin-a", "session-a", first.generation)

        pending = await store.oldest_pending("origin-a", except_session="other")
        assert pending is not None
        assert pending.generation == second.generation
        assert pending.state == "pending"

    async def test_current_source_rebinds_after_same_inode_truncation(
        self, tmp_path: Path
    ) -> None:
        """A current source reset starts from zero after a same-inode shrink."""
        transcript = tmp_path / "rollout.jsonl"
        transcript.write_text(
            "".join(
                f"{operator_line(f'old-{i}', f'old-turn-{i}', session='session-a')}\n"
                for i in range(SERVER_BATCH * 2 + 1)
            ),
            encoding="utf-8",
        )
        settings = _settings(tmp_path / "watermark.sqlite")
        payload = StopHook(transcript_path=transcript, session_id="session-a")
        failing = FailAfterNBatchesLane()

        with pytest.raises(LaneUnreachableError):
            await run_stop(
                payload,
                settings,
                lane_factory=lambda _settings, _session: _started(failing),
                deadline=time.monotonic() + 100.0,
            )

        key = _scoped_key(settings, "session-a")
        checkpoint = await WatermarkStore(settings.watermark_path).offset_for(key)
        old_size = transcript.stat().st_size
        assert 0 < checkpoint < old_size

        transcript.write_text(
            "".join(
                f"{operator_line(f'new-{i}', f'new-turn-{i}', session='session-a')}\n"
                for i in range(150)
            ),
            encoding="utf-8",
        )
        new_size = transcript.stat().st_size
        assert checkpoint < new_size < old_size

        lane = RecordingLane()
        result = await run_stop(
            payload,
            settings,
            lane_factory=lambda _settings, _session: _started(lane),
        )

        assert result is not None and result.delivered == 150
        assert result.source_complete
        assert lane.turns[0]["turn_uuid"] == "new-0"
        assert lane.turns[-1]["turn_uuid"] == "new-149"
        assert await WatermarkStore(settings.watermark_path).offset_for(key) == new_size
        with sqlite3.connect(settings.watermark_path) as database:
            assert database.execute("SELECT count(*) FROM pending_capture").fetchone() == (0,)

    async def test_older_replay_mismatch_is_parked_without_dispatch(
        self, tmp_path: Path
    ) -> None:
        """A changed older source stays parked and never reaches the lane."""
        transcript = tmp_path / "session-a.jsonl"
        transcript.write_text(
            operator_line("old-a", "old source", session="session-a") + "\n",
            encoding="utf-8",
        )
        settings = _settings(tmp_path / "watermark.sqlite")
        with pytest.raises(LaneUnreachableError):
            await run_stop(
                StopHook(transcript_path=transcript, session_id="session-a"),
                settings,
                lane_factory=lambda _settings, _session: _started(UnreachableLane()),
            )

        replacement = tmp_path / "replacement.jsonl"
        replacement.write_text(
            operator_line("new-a", "replacement source", session="session-a") + "\n",
            encoding="utf-8",
        )
        replacement.replace(transcript)
        current = tmp_path / "session-b.jsonl"
        current.write_text(
            operator_line("new-b", "current source", session="session-b") + "\n",
            encoding="utf-8",
        )
        lane = RecordingLane()
        result = await run_stop(
            StopHook(transcript_path=current, session_id="session-b"),
            settings,
            lane_factory=lambda _settings, _session: _started(lane),
        )

        assert result is not None and result.delivered == 1
        assert [turn["session_ref"] for turn in lane.turns] == ["session-b"]
        with sqlite3.connect(settings.watermark_path) as database:
            row = database.execute(
                "SELECT state, failure_category FROM pending_capture "
                "WHERE session_key = ?",
                ("session-a",),
            ).fetchone()
        assert row == ("source_changed", "source_changed")

    async def test_missing_source_rebinds_when_created_and_replays_from_next_session(
        self, tmp_path: Path
    ) -> None:
        """A missing first source can be bound and replayed after it appears."""
        missing = tmp_path / "session-a.jsonl"
        settings = _settings(tmp_path / "watermark.sqlite")
        first = await run_stop(
            StopHook(transcript_path=missing, session_id="session-a"),
            settings,
            lane_factory=lambda _settings, _session: _started(RecordingLane()),
        )

        assert first is not None and first.delivered == 0
        assert not first.source_complete
        with sqlite3.connect(settings.watermark_path) as database:
            row = database.execute(
                "SELECT state, device, inode, source_size FROM pending_capture"
            ).fetchone()
        assert row == ("pending", None, None, None)

        missing.write_text(
            operator_line("late-a", "created later", session="session-a") + "\n",
            encoding="utf-8",
        )
        current = tmp_path / "session-b.jsonl"
        current.write_text(
            operator_line("new-b", "current source", session="session-b") + "\n",
            encoding="utf-8",
        )
        lane = RecordingLane()
        result = await run_stop(
            StopHook(transcript_path=current, session_id="session-b"),
            settings,
            lane_factory=lambda _settings, _session: _started(lane),
        )

        assert result is not None and result.delivered == 1
        assert [turn["session_ref"] for turn in lane.turns] == [
            "session-b",
            "session-a",
        ]
        assert [turn["turn_uuid"] for turn in lane.turns] == ["new-b", "late-a"]
        with sqlite3.connect(settings.watermark_path) as database:
            assert database.execute("SELECT count(*) FROM pending_capture").fetchone() == (0,)

    async def test_transient_stat_error_preserves_identified_pending_source(  # noqa: PLR0915 -- pins both failure and later recovery
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A transient stat failure leaves the identified locator retryable."""
        transcript = tmp_path / "session-a.jsonl"
        transcript.write_text(
            operator_line("a", "retry after stat", session="session-a") + "\n",
            encoding="utf-8",
        )
        settings = _settings(tmp_path / "watermark.sqlite")
        payload = StopHook(transcript_path=transcript, session_id="session-a")
        with pytest.raises(LaneUnreachableError):
            await run_stop(
                payload,
                settings,
                lane_factory=lambda _settings, _session: _started(UnreachableLane()),
            )

        with sqlite3.connect(settings.watermark_path) as database:
            before = database.execute(
                "SELECT state, device, inode, generation FROM pending_capture"
            ).fetchone()
        assert before is not None and before[0] == "pending"

        original_stat = Path.stat
        failures = 1

        def flaky_stat(path: Path, *args: object, **kwargs: object) -> object:
            nonlocal failures
            if path == transcript and failures:
                failures -= 1
                raise OSError
            return original_stat(path, *args, **kwargs)

        monkeypatch.setattr(Path, "stat", flaky_stat)
        with pytest.raises(CaptureSourceChangedError):
            await run_stop(
                payload,
                settings,
                lane_factory=lambda _settings, _session: _started(RecordingLane()),
            )

        with sqlite3.connect(settings.watermark_path) as database:
            after = database.execute(
                "SELECT state, device, inode, generation FROM pending_capture"
            ).fetchone()
        assert after == before

        lane = RecordingLane()
        result = await run_stop(
            payload,
            settings,
            lane_factory=lambda _settings, _session: _started(lane),
        )
        assert result is not None and result.delivered == 1
        assert lane.turns[0]["turn_uuid"] == "a"
        with sqlite3.connect(settings.watermark_path) as database:
            assert database.execute("SELECT count(*) FROM pending_capture").fetchone() == (0,)

    async def test_complete_records_earn_receipt_with_partial_trailing_record(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A partial tail defers completion but not the successful capture receipt."""
        import openbrain.apps.hooks.session as session_mod

        transcript = tmp_path / "partial.jsonl"
        transcript.write_text(
            operator_line("complete", "complete record", session="partial")
            + "\n{\"partial\":",
            encoding="utf-8",
        )
        settings = _settings(tmp_path / "watermark.sqlite")
        receipts: list[tuple[object, ...]] = []

        def record_receipt(*args: object, **_kwargs: object) -> None:
            receipts.append(args)

        monkeypatch.setattr(session_mod, "note_capture", record_receipt)
        lane = RecordingLane()
        result = await run_stop(
            StopHook(transcript_path=transcript, session_id="partial"),
            settings,
            lane_factory=lambda _settings, _session: _started(lane),
        )

        assert result is not None and result.delivered == 1
        assert not result.source_complete
        assert receipts == [("partial", None)]
        assert await WatermarkStore(settings.watermark_path).offset_for(
            _scoped_key(settings, "partial")
        ) < transcript.stat().st_size

    async def test_deadline_checkpoints_current_progress_without_capture_receipt(  # noqa: PLR0915
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An exhausted Stop leaves acknowledged chunks for the next session."""
        import openbrain.apps.hooks.session as session_mod

        class Clock:
            now = 0.0

            def monotonic(self) -> float:
                return self.now

        class AdvancingLane(RecordingLane):
            advance = True

            def ingest_raw_turns(self, turns: object) -> object:
                result = super().ingest_raw_turns(turns)
                if self.advance:
                    clock.now = 5.0
                return result

        clock = Clock()
        monkeypatch.setattr(time, "monotonic", clock.monotonic)
        receipts: list[tuple[object, ...]] = []

        def record_receipt(*args: object, **_kwargs: object) -> None:
            receipts.append(args)

        monkeypatch.setattr(session_mod, "note_capture", record_receipt)

        transcript = tmp_path / "session-a.jsonl"
        transcript.write_text(
            "".join(
                f"{operator_line(f'a{i}', f'a-turn-{i}', session='session-a')}\n"
                for i in range(SERVER_BATCH + 1)
            ),
            encoding="utf-8",
        )
        settings = _settings(tmp_path / "watermark.sqlite")
        lane = AdvancingLane()
        payload = StopHook(transcript_path=transcript, session_id="session-a")

        with pytest.raises(TimeoutError):
            await run_stop(
                payload,
                settings,
                lane_factory=lambda _settings, _session: _started(lane),
                deadline=5.0,
            )

        assert receipts == []
        key = _scoped_key(settings, "session-a")
        checkpoint = await WatermarkStore(settings.watermark_path).offset_for(key)
        assert len(lane.batches) == 1
        assert 0 < checkpoint < transcript.stat().st_size

        clock.now = 0.0
        lane.advance = False
        next_transcript = tmp_path / "session-b.jsonl"
        next_transcript.write_text(
            operator_line("b", "b-turn", session="session-b") + "\n",
            encoding="utf-8",
        )
        next_result = await run_stop(
            StopHook(transcript_path=next_transcript, session_id="session-b"),
            settings,
            lane_factory=lambda _settings, _session: _started(lane),
            deadline=100.0,
        )

        assert next_result is not None and next_result.source_complete
        assert [turn["turn_uuid"] for turn in lane.turns[-2:]] == ["b", "a100"]
