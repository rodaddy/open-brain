"""Functional tests for the spine: deliver to the lane, then advance, never drop.

The lane here is a recorder standing in for ``openbrain_memory.AgentMemory``
behind the ``RawLane`` protocol. The real round trip -- service, Postgres,
dedupe -- is ``test_capture_deliver_live.py``, and only that file proves a
write survives; these prove the ORDER and the composition.
"""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from openbrain.apps.capture.deliver import deliver_new_turns
from openbrain.apps.capture.watermark import WatermarkStore


def operator_line(uuid: str, content: str) -> str:
    """Build one transcript line in the shape Claude Code actually writes."""
    return json.dumps(
        {
            "type": "user",
            "uuid": uuid,
            "promptSource": "typed",
            "sessionId": "s1",
            "cwd": "/repo",
            "parentUuid": None,
            "timestamp": "2026-07-31T06:00:00.000Z",
            "message": {"role": "user", "content": content},
        }
    )


def assistant_line(uuid: str) -> str:
    return json.dumps({"type": "assistant", "uuid": uuid, "message": {"content": []}})


def write_lines(path: Path, lines: list[str]) -> None:
    path.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")


def append_lines(path: Path, lines: list[str]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write("".join(f"{line}\n" for line in lines))


class LaneUnreachableError(RuntimeError):
    """The send failed outright -- server gone, spool broken."""


@dataclass
class RecordingLane:
    """A ``RawLane`` that remembers every batch it was handed."""

    batches: list[list[dict[str, Any]]] = field(default_factory=list)

    def ingest_raw_turns(self, turns: Any) -> object:
        self.batches.append([dict(turn) for turn in turns])
        return {"ingested": len(self.batches[-1])}

    @property
    def turns(self) -> list[dict[str, Any]]:
        return [turn for batch in self.batches for turn in batch]


@dataclass
class UnreachableLane:
    """A ``RawLane`` that raises :class:`LaneUnreachableError` on every send."""

    calls: int = 0

    def ingest_raw_turns(self, turns: Any) -> object:
        self.calls += 1
        raise LaneUnreachableError


class TestDeliveryReachesTheLane:
    """The happy path: what was typed arrives, and only once."""

    async def test_operator_turns_are_delivered_and_the_watermark_advances(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "t.jsonl"
        write_lines(
            path,
            [
                operator_line("u1", "use postgres not sqlite"),
                assistant_line("a1"),
                operator_line("u2", "yes"),
            ],
        )
        store = WatermarkStore(tmp_path / "wm.sqlite")
        lane = RecordingLane()

        result = await deliver_new_turns(path, "s1", store, lane)

        assert result.delivered == 2
        assert [turn["turn_uuid"] for turn in lane.turns] == ["u1", "u2"]
        assert lane.turns[0]["content"] == "use postgres not sqlite"
        # The server's required fields, in the shape ingest_raw_turn validates:
        # role from the closed set, a per-send turn_index, and the transcript's
        # own timestamp as occurred_at -- the session's ordering key.
        assert [turn["turn_index"] for turn in lane.turns] == [0, 1]
        assert all(turn["role"] == "user" for turn in lane.turns)
        assert all(
            turn["occurred_at"] == "2026-07-31T06:00:00.000Z"
            for turn in lane.turns
        )
        assert await store.offset_for("s1") == result.next_offset
        assert result.next_offset == path.stat().st_size

    async def test_a_second_delivery_sends_nothing(self, tmp_path: Path) -> None:
        """A hook firing twice on a quiet transcript must not resend."""
        path = tmp_path / "t.jsonl"
        write_lines(path, [operator_line("u1", "ok")])
        store = WatermarkStore(tmp_path / "wm.sqlite")
        lane = RecordingLane()

        await deliver_new_turns(path, "s1", store, lane)
        second = await deliver_new_turns(path, "s1", store, lane)

        assert second.delivered == 0
        assert len(lane.batches) == 1

    async def test_only_turns_after_the_watermark_are_delivered(
        self, tmp_path: Path
    ) -> None:
        """The live call shape: resume from the watermark, not offset 0."""
        path = tmp_path / "t.jsonl"
        write_lines(path, [operator_line("u1", "first")])
        store = WatermarkStore(tmp_path / "wm.sqlite")
        lane = RecordingLane()
        await deliver_new_turns(path, "s1", store, lane)

        append_lines(path, [assistant_line("a1"), operator_line("u2", "second")])
        result = await deliver_new_turns(path, "s1", store, lane)

        assert result.delivered == 1
        assert lane.batches[-1][0]["turn_uuid"] == "u2"

    async def test_a_missing_file_delivers_nothing_and_records_nothing(
        self, tmp_path: Path
    ) -> None:
        """A transcript can be read before it exists; that is not a failure."""
        store = WatermarkStore(tmp_path / "wm.sqlite")
        lane = RecordingLane()

        result = await deliver_new_turns(
            tmp_path / "absent.jsonl", "s1", store, lane
        )

        assert result.delivered == 0
        assert lane.batches == []
        assert await store.offset_for("s1") == 0


class TestFailureNeverDrops:
    """docs/decisions/capture-never-drops-a-turn.md, at the spine's boundary."""

    async def test_a_failed_send_leaves_the_watermark_where_it_was(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "t.jsonl"
        write_lines(path, [operator_line("u1", "must not be lost")])
        store = WatermarkStore(tmp_path / "wm.sqlite")
        broken = UnreachableLane()

        with pytest.raises(LaneUnreachableError):
            await deliver_new_turns(path, "s1", store, broken)

        assert broken.calls == 1
        assert await store.offset_for("s1") == 0

    async def test_the_next_delivery_resends_what_the_failed_one_could_not(
        self, tmp_path: Path
    ) -> None:
        """Recovery is automatic: the unadvanced watermark IS the retry."""
        path = tmp_path / "t.jsonl"
        write_lines(path, [operator_line("u1", "must not be lost")])
        store = WatermarkStore(tmp_path / "wm.sqlite")

        with pytest.raises(LaneUnreachableError):
            await deliver_new_turns(path, "s1", store, UnreachableLane())

        lane = RecordingLane()
        result = await deliver_new_turns(path, "s1", store, lane)

        assert result.delivered == 1
        assert lane.turns[0]["content"] == "must not be lost"


class TestContentSurvivesWhole:
    """The payload handed to the lane is exactly what the operator typed.

    The sizes are INPUT sizes, never bounds: they bracket the two shortenings
    the port exists to bury (1,500 and 200,000) and keep going past them, so a
    reintroduced cut anywhere makes some case fail.
    """

    @pytest.mark.parametrize("size", [1, 24, 1_499, 1_500, 1_501, 10_000, 200_001])
    async def test_input_length_is_preserved_exactly(
        self, tmp_path: Path, size: int
    ) -> None:
        text = "x" * size
        path = tmp_path / "t.jsonl"
        write_lines(path, [operator_line("u1", text)])
        store = WatermarkStore(tmp_path / "wm.sqlite")
        lane = RecordingLane()

        await deliver_new_turns(path, "s1", store, lane)

        assert len(lane.turns[0]["content"]) == size
        assert lane.turns[0]["content"] == text
