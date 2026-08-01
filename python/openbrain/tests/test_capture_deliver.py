"""Functional tests for the spine: deliver to the lane, then advance, never drop.

The lane here is a recorder standing in for ``openbrain_memory.AgentMemory``
behind the ``RawLane`` protocol. The real round trip -- service, Postgres,
dedupe -- is ``test_capture_deliver_live.py``, and only that file proves a
write survives; these prove the ORDER and the composition.
"""

from pathlib import Path

import pytest

from conftest import (
    BatchTooLargeError,
    BoundedRecordingLane,
    FailAfterNBatchesLane,
    LaneUnreachableError,
    RecordingLane,
    UnreachableLane,
    append_lines,
    assistant_line,
    operator_line,
    write_lines,
)
from openbrain.apps.capture.deliver import SERVER_BATCH, deliver_new_turns
from openbrain.apps.capture.watermark import WatermarkStore


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


class TestLargeRegionsAreDeliveredWhole:
    """More turns than one server call takes still all land, in order, once.

    The server refuses a call carrying more than ``SERVER_BATCH`` turns
    (``ingest_raw_turn``'s ``turns`` array, max 100). A first Stop on a busy
    session, or any read that resumes from offset 0, produces more than that in
    one region. Handing them over in one call would wedge the session forever;
    these prove the spine sends in runs the server accepts and never loses one.
    """

    async def test_more_than_one_call_worth_all_land_across_batches(
        self, tmp_path: Path
    ) -> None:
        count = SERVER_BATCH * 2 + 5
        path = tmp_path / "t.jsonl"
        write_lines(
            path,
            [operator_line(f"u{i}", f"turn {i}") for i in range(count)],
        )
        store = WatermarkStore(tmp_path / "wm.sqlite")
        lane = BoundedRecordingLane(accepts=SERVER_BATCH)

        result = await deliver_new_turns(path, "s1", store, lane)

        assert result.delivered == count
        # Every turn landed, in order, exactly once.
        assert [turn["turn_uuid"] for turn in lane.turns] == [
            f"u{i}" for i in range(count)
        ]
        # No single call exceeded what the server accepts.
        assert all(len(batch) <= SERVER_BATCH for batch in lane.batches)
        assert len(lane.batches) == 3
        # The watermark advanced to end-of-file: the whole region is consumed.
        assert await store.offset_for("s1") == result.next_offset
        assert result.next_offset == path.stat().st_size

    async def test_a_bounded_lane_rejects_an_unsplit_oversized_send(
        self, tmp_path: Path
    ) -> None:
        """Guard the guard: a single over-large call really would be refused.

        If the spine ever stopped splitting, this lane (like the server) raises
        on the oversized call and the assertion in the sibling test would fail.
        Proving the fake can fail is what keeps it honest (#275).
        """
        oversized = [
            {"turn_uuid": f"u{i}", "role": "user", "content": "x", "turn_index": i}
            for i in range(SERVER_BATCH + 1)
        ]
        lane = BoundedRecordingLane(accepts=SERVER_BATCH)

        with pytest.raises(BatchTooLargeError):
            lane.ingest_raw_turns(oversized)

        assert lane.batches == []

    async def test_a_mid_delivery_failure_advances_nothing(
        self, tmp_path: Path
    ) -> None:
        """A later chunk failing must not bank the earlier ones' offset.

        The watermark advances only after the WHOLE delivery returns. If a
        second call raises, the region re-reads next Stop, and the server's
        (namespace, turn_uuid) dedupe makes the already-landed first call a
        no-op -- no turn is lost and none is stored twice.
        """
        count = SERVER_BATCH + 10
        path = tmp_path / "t.jsonl"
        write_lines(
            path,
            [operator_line(f"u{i}", f"turn {i}") for i in range(count)],
        )
        store = WatermarkStore(tmp_path / "wm.sqlite")
        failing = FailAfterNBatchesLane(fail_on=2)

        with pytest.raises(LaneUnreachableError):
            await deliver_new_turns(path, "s1", store, failing)

        # The first call went out; the second raised. Watermark unmoved.
        assert len(failing.batches) == 2
        assert await store.offset_for("s1") == 0

        # The retry (an unadvanced watermark) re-reads the whole region and
        # this time every turn lands, in order.
        lane = BoundedRecordingLane(accepts=SERVER_BATCH)
        result = await deliver_new_turns(path, "s1", store, lane)
        assert result.delivered == count
        assert [turn["turn_uuid"] for turn in lane.turns] == [
            f"u{i}" for i in range(count)
        ]
        assert await store.offset_for("s1") == path.stat().st_size


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
