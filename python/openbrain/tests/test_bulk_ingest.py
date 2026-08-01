"""Functional tests for the bulk ingester at its public boundary.

The bulk app (#454) is the second application: a giant session file goes in, and
every operator turn comes out the raw lane, whole. These tests feed a
real-shaped Claude transcript fixture through the public entry points
(``stage_file`` / ``ingest``) and assert every turn lands via a fake client --
black-box, at the boundary, never asserting SQL shape.

The properties proved here:

    - every operator turn in the file reaches the lane, and only operator turns;
    - content arrives whole, byte for byte, at every input size;
    - a re-run RESUMES -- already-sent turns are not sent again;
    - a turn the server rejects is QUARANTINED, not dropped, and the rest land;
    - an unbuilt format fails LOUD the moment it is selected.

Only the ``-m live`` suite (``test_bulk_ingest_live``) proves a write survives
Postgres; here a recording lane proves order and payload shape.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from openbrain.apps.bulk.formats import (
    FormatNotImplementedError,
    InputFormat,
    adapter_for,
)
from openbrain.apps.bulk.ingest import ingest, stage_file
from openbrain.apps.bulk.staging import StagingStore
from openbrain.apps.capture.records import raw_turn_from_line

FIXTURE = Path(__file__).parent / "fixtures" / "bulk" / "claude-transcript.jsonl"

#: The operator turns the fixture contains, in order, with their exact text. The
#: fixture also carries markers, an assistant line, a tool result, a system
#: prompt, and a compaction summary -- none of which is an operator turn -- so a
#: run that returns exactly these three has declined all the non-turns correctly.
EXPECTED_TURNS = (
    ("op-1", "port the bulk ingester from the spec"),
    ("op-2", "y"),
    ("op-3", "use SQLite staging, not an in-memory list, and yield each turn whole"),
)


class TurnRejectedError(RuntimeError):
    """The fake server refused a turn. Its class name is what quarantine records."""


@dataclass
class RecordingLane:
    """A ``BulkLane`` that remembers every batch it was handed."""

    batches: list[list[dict[str, Any]]] = field(default_factory=list)

    def ingest_raw_turns(self, turns: Any) -> object:
        self.batches.append([dict(turn) for turn in turns])
        return {"ingested": len(self.batches[-1])}

    @property
    def turns(self) -> list[dict[str, Any]]:
        return [turn for batch in self.batches for turn in batch]


@dataclass
class RejectingLane:
    """A ``BulkLane`` that rejects one named turn and accepts the rest."""

    reject_uuid: str
    accepted: list[str] = field(default_factory=list)

    def ingest_raw_turns(self, turns: Any) -> object:
        batch = [dict(turn) for turn in turns]
        for turn in batch:
            if turn["turn_uuid"] == self.reject_uuid:
                raise TurnRejectedError
            self.accepted.append(turn["turn_uuid"])
        return {"ingested": len(batch)}


def stage_fixture(tmp_path: Path) -> StagingStore:
    """Stage the Claude fixture into a fresh store and return it."""
    store = StagingStore(tmp_path / "stage.sqlite")
    stage_file(FIXTURE, InputFormat.CLAUDE, store)
    return store


class TestEveryOperatorTurnReachesTheLane:
    """A giant file in, every operator turn out -- and nothing that is not one."""

    def test_all_operator_turns_land_in_file_order(self, tmp_path: Path) -> None:
        store = stage_fixture(tmp_path)
        lane = RecordingLane()

        result = ingest(store, lane)

        assert result.sent == len(EXPECTED_TURNS)
        assert result.quarantined == 0
        landed = [(turn["turn_uuid"], turn["content"]) for turn in lane.turns]
        assert landed == list(EXPECTED_TURNS)

    def test_non_operator_records_are_declined_not_stored(
        self, tmp_path: Path
    ) -> None:
        # The fixture's tool result, assistant line, system prompt, markers, and
        # compaction summary must all be absent -- staging carries only turns.
        store = stage_fixture(tmp_path)
        assert store.counts().staged == len(EXPECTED_TURNS)
        landed_ids = {turn.turn_uuid for turn in store.pending()}
        assert landed_ids == {uuid for uuid, _ in EXPECTED_TURNS}


class TestContentIsCarriedWhole:
    """No cap, no truncation -- every size lands byte for byte."""

    #: INPUT SIZES, never bounds: they straddle the two shortenings this port
    #: buried (1,500 and 200,000) and go past both, so a reintroduced cut at any
    #: threshold makes some turn fail. A number in a test is an INPUT SIZE.
    SIZES = (1, 1_499, 1_501, 200_001, 300_001)

    def test_every_size_reaches_the_lane_unshortened(self, tmp_path: Path) -> None:
        session = "bulk-size"
        lines = "".join(
            json.dumps(
                {
                    "type": "user",
                    "uuid": f"size-{size}",
                    "promptSource": "typed",
                    "sessionId": session,
                    "timestamp": "2026-08-01T06:00:00.000Z",
                    "message": {"role": "user", "content": "x" * size},
                }
            )
            + "\n"
            for size in self.SIZES
        )
        source = tmp_path / "sized.jsonl"
        source.write_text(lines, encoding="utf-8")
        store = StagingStore(tmp_path / "stage.sqlite")
        stage_file(source, InputFormat.CLAUDE, store)
        lane = RecordingLane()

        ingest(store, lane)

        by_id = {turn["turn_uuid"]: turn["content"] for turn in lane.turns}
        for size in self.SIZES:
            content = by_id[f"size-{size}"]
            assert len(content) == size, f"size {size}: stored {len(content)} chars"
            assert content == "x" * size, f"size {size}: content changed"


class TestResumeDoesNotResend:
    """A re-run over the same store sends only what has not landed yet."""

    def test_second_run_sends_nothing_when_all_sent(self, tmp_path: Path) -> None:
        store = stage_fixture(tmp_path)
        first = ingest(store, RecordingLane())
        assert first.sent == len(EXPECTED_TURNS)

        # Same store, a fresh lane: every turn is already marked sent, so the
        # resume delivers nothing rather than re-sending the whole file.
        second_lane = RecordingLane()
        second = ingest(store, second_lane)
        assert second.sent == 0
        assert second_lane.turns == []

    def test_resume_after_a_rejection_sends_only_the_remainder(
        self, tmp_path: Path
    ) -> None:
        store = stage_fixture(tmp_path)
        # First run rejects op-2: op-1 lands, op-2 quarantines, op-3 still lands.
        rejecting = RejectingLane(reject_uuid="op-2")
        first = ingest(store, rejecting)
        assert first.sent == 2
        assert first.quarantined == 1
        assert rejecting.accepted == ["op-1", "op-3"]

        # A resume with an accepting lane sends ONLY the still-pending op-2 --
        # the two already-sent turns are not re-sent.
        recovering = RecordingLane()
        second = ingest(store, recovering)
        assert [turn["turn_uuid"] for turn in recovering.turns] == ["op-2"]
        assert second.sent == 1


class TestRejectedTurnsAreQuarantinedNotDropped:
    """The operator failure mode: a bad turn is set aside, whole, with its error."""

    def test_a_rejected_turn_is_quarantined_and_the_rest_land(
        self, tmp_path: Path
    ) -> None:
        store = stage_fixture(tmp_path)
        result = ingest(store, RejectingLane(reject_uuid="op-2"))

        assert result.sent == 2
        assert result.quarantined == 1
        quarantined = list(store.quarantined())
        assert len(quarantined) == 1
        turn, error = quarantined[0]
        assert turn.turn_uuid == "op-2"
        # The turn is held WHOLE, and the error is the class NAME only -- never a
        # value, so no turn text or token is written into the quarantine record.
        assert turn.content == "y"
        assert error == "TurnRejectedError"


class TestUnbuiltFormatsFailLoud:
    """Code and Hermes are follow-on tickets -- selecting them raises, not skips."""

    @pytest.mark.parametrize("input_format", [InputFormat.CODE, InputFormat.HERMES])
    def test_selecting_an_unbuilt_format_raises(
        self, tmp_path: Path, input_format: InputFormat
    ) -> None:
        store = StagingStore(tmp_path / "stage.sqlite")
        with pytest.raises(FormatNotImplementedError):
            stage_file(FIXTURE, input_format, store)


class TestClaudeAdapterIsTheReusedPureFunction:
    """The Claude adapter is imported from capture, not reimplemented here."""

    def test_claude_adapter_is_records_raw_turn_from_line(self) -> None:
        # Reuse by IMPORT, not by copy: the factory hands back the exact pure
        # function the live adapter parses lines with (operator: "reuse already
        # working code, good.").
        assert adapter_for(InputFormat.CLAUDE) is raw_turn_from_line
