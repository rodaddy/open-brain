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
    - each observed source format normalizes through the same staging spine.

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
    InputFormat,
    MalformedCodexRecordError,
    MalformedHermesRecordError,
    adapter_for,
    codex_raw_turn_from_line,
    hermes_raw_turn_from_line,
)
from openbrain.apps.bulk.ingest import ingest, stage_file
from openbrain.apps.bulk.staging import StagingStore
from openbrain.apps.capture.records import raw_turn_from_line
from openbrain.models.turn import TurnRole

FIXTURE = Path(__file__).parent / "fixtures" / "bulk" / "claude-transcript.jsonl"
CODEX_FIXTURE = (
    Path(__file__).parent / "fixtures" / "bulk" / "codex-rollout-sanitized.jsonl"
)
HERMES_FIXTURE = (
    Path(__file__).parent / "fixtures" / "bulk" / "hermes-messages-sanitized.jsonl"
)

#: The CONVERSATION the fixture contains, in file order, with exact text.
#:
#: BOTH SIDES since #447: the operator's three turns and the assistant's one
#: reply. The bulk ingester shares ``raw_turn_from_line`` with the live capture
#: path, so restoring the agent side there restored it here too -- which is the
#: point. A bulk-ingested corpus that held only the operator's half would grade
#: the same one-sided material the live path was producing.
#:
#: The fixture also carries markers, a tool result, a system-injected prompt, and
#: a compaction summary -- none of which either participant SAID -- so a run
#: returning exactly these four has declined all the non-turns correctly.
EXPECTED_TURNS = (
    ("op-1", "port the bulk ingester from the spec"),
    ("as-1", "working on it"),
    ("op-2", "y"),
    ("op-3", "use SQLite staging, not an in-memory list, and yield each turn whole"),
)

#: How each expected turn is attributed: ``(role, is_human_prompt)`` by uuid.
#:
#: Asserted separately from the text because #447's defect was never that content
#: was wrong -- it was that a whole speaker was missing, and a restored speaker
#: mislabelled as the operator would corrupt the health check that watches for
#: operator-side loss (``docs/decisions/capture-never-drops-a-turn.md``).
EXPECTED_ATTRIBUTION = {
    "op-1": (TurnRole.USER, True),
    "as-1": (TurnRole.ASSISTANT, False),
    "op-2": (TurnRole.USER, True),
    "op-3": (TurnRole.USER, True),
}


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


class TestEveryTurnReachesTheLane:
    """A giant file in, the whole conversation out -- and nothing that is not it."""

    def test_all_turns_land_in_file_order(self, tmp_path: Path) -> None:
        store = stage_fixture(tmp_path)
        lane = RecordingLane()

        result = ingest(store, lane)

        assert result.sent == len(EXPECTED_TURNS)
        assert result.quarantined == 0
        landed = [(turn["turn_uuid"], turn["content"]) for turn in lane.turns]
        assert landed == list(EXPECTED_TURNS)

    def test_each_turn_is_attributed_to_the_side_that_said_it(
        self, tmp_path: Path
    ) -> None:
        """Both speakers land, and each is labelled as itself (#447)."""
        store = stage_fixture(tmp_path)
        lane = RecordingLane()

        ingest(store, lane)

        attribution = {
            turn["turn_uuid"]: (turn["role"], turn["is_human_prompt"])
            for turn in lane.turns
        }
        assert attribution == EXPECTED_ATTRIBUTION

    def test_records_neither_side_said_are_declined_not_stored(
        self, tmp_path: Path
    ) -> None:
        # The fixture's tool result, system-injected prompt, markers, and
        # compaction summary must all be absent -- staging carries only speech.
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
        # First run rejects op-2: everything before and after it still lands,
        # including the assistant's reply -- quarantine is per turn, and it is
        # not allowed to take a whole speaker down with it.
        rejecting = RejectingLane(reject_uuid="op-2")
        first = ingest(store, rejecting)
        assert first.sent == len(EXPECTED_TURNS) - 1
        assert first.quarantined == 1
        assert rejecting.accepted == ["op-1", "as-1", "op-3"]

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

        assert result.sent == len(EXPECTED_TURNS) - 1
        assert result.quarantined == 1
        quarantined = list(store.quarantined())
        assert len(quarantined) == 1
        turn, error = quarantined[0]
        assert turn.turn_uuid == "op-2"
        # The turn is held WHOLE, and the error is the class NAME only -- never a
        # value, so no turn text or token is written into the quarantine record.
        assert turn.content == "y"
        assert error == "TurnRejectedError"


class TestHermesObservedSQLiteAdapter:
    """Observed Hermes message rows normalize through the existing bulk spine."""

    def test_sanitized_schema_sample_reaches_fake_lane(self, tmp_path: Path) -> None:
        assert adapter_for(InputFormat.HERMES) is hermes_raw_turn_from_line
        store = StagingStore(tmp_path / "hermes.sqlite")
        staged = stage_file(HERMES_FIXTURE, InputFormat.HERMES, store)
        lane = RecordingLane()

        result = ingest(store, lane)

        assert staged.staged == 3
        assert result.sent == 3
        assert result.quarantined == 0
        user_turn, assistant_turn, tool_turn = lane.turns
        assert user_turn == {
            "turn_uuid": "hermes:fixture-hermes-session:4101",
            "content": "structural Hermes user sample",
            "role": TurnRole.USER,
            "is_human_prompt": True,
            "occurred_at": "2026-07-13T14:22:01.000Z",
            "session_ref": "fixture-hermes-session",
            "turn_index": 0,
        }
        assert assistant_turn["turn_uuid"] == "hermes:fixture-hermes-session:4102"
        assert assistant_turn["content"] == "structural Hermes assistant sample"
        assert assistant_turn["role"] == TurnRole.ASSISTANT
        assert assistant_turn["is_human_prompt"] is False
        assert tool_turn["turn_uuid"] == "hermes:fixture-hermes-session:4103"
        assert tool_turn["content"] == '{"status":"fixture-ok"}'
        assert tool_turn["role"] == TurnRole.TOOL
        assert tool_turn["is_human_prompt"] is False

    def test_identity_includes_session_and_nonturn_rows_are_declined(self) -> None:
        def row(session_id: str, role: str, content: str | None) -> str:
            return json.dumps({
                "id": 7,
                "session_id": session_id,
                "role": role,
                "content": content,
                "timestamp": "2026-07-13T14:22:00.000Z",
            })

        first = hermes_raw_turn_from_line(row("session-a", "user", "same row id"))
        second = hermes_raw_turn_from_line(row("session-b", "user", "same row id"))
        assert first is not None
        assert second is not None
        assert first.turn_uuid != second.turn_uuid
        assert hermes_raw_turn_from_line(row("session-a", "system", "context")) is None
        assert hermes_raw_turn_from_line(row("session-a", "assistant", None)) is None

    def test_malformed_row_names_location_without_content(self, tmp_path: Path) -> None:
        source = tmp_path / "broken-hermes.jsonl"
        source.write_text(
            HERMES_FIXTURE.read_text(encoding="utf-8").splitlines()[0]
            + '\n{"id":4102,"content":"must not appear"}\n',
            encoding="utf-8",
        )
        store = StagingStore(tmp_path / "stage.sqlite")

        with pytest.raises(MalformedHermesRecordError) as raised:
            stage_file(source, InputFormat.HERMES, store)

        message = str(raised.value)
        assert f"{source}:2" in message
        assert "ACTION REQUIRED" in message
        assert "must not appear" not in message
        assert store.counts().staged == 0


class TestCodexObservedRolloutAdapter:
    """Observed Codex events become normalized turns through the existing spine."""

    def test_factory_returns_the_codex_adapter(self) -> None:
        assert adapter_for(InputFormat.CODEX) is codex_raw_turn_from_line

    def test_sanitized_observed_sample_reaches_fake_lane(self, tmp_path: Path) -> None:
        store = StagingStore(tmp_path / "codex.sqlite")
        staged = stage_file(CODEX_FIXTURE, InputFormat.CODEX, store)
        lane = RecordingLane()

        result = ingest(store, lane)

        assert staged.staged == 2
        assert result.sent == 2
        assert result.quarantined == 0
        user_turn, assistant_turn = lane.turns

        # The human event normalizes to a USER turn, whole, at its own timestamp.
        assert user_turn["content"] == "structural user sample"
        assert user_turn["role"] == TurnRole.USER
        assert user_turn["is_human_prompt"] is True
        assert user_turn["occurred_at"] == "2026-08-02T03:11:24.000Z"

        # The completed task carries its final answer as the ASSISTANT turn, and
        # keeps Codex's own turn_id as identity rather than minting a new one.
        assert assistant_turn["turn_uuid"] == "fixture-turn-1"
        assert assistant_turn["content"] == "structural assistant sample"
        assert assistant_turn["role"] == TurnRole.ASSISTANT
        assert assistant_turn["is_human_prompt"] is False
        assert assistant_turn["occurred_at"] == "2026-08-02T03:11:27.000Z"

    def test_user_turn_identity_is_unique_per_record_not_per_timestamp(self) -> None:
        # Observed on the real 2026-08-02 corpus: several user_message events
        # share one timestamp to the millisecond, so a timestamp-derived id
        # COLLIDES and the second turn overwrites the first. Identity is derived
        # from the whole record instead, which keeps same-instant turns distinct
        # while staying deterministic across re-runs of the same file.
        def user_line(message: str) -> str:
            return json.dumps(
                {
                    "timestamp": "2026-08-02T03:11:24.000Z",
                    "type": "event_msg",
                    "payload": {
                        "type": "user_message",
                        "message": message,
                        "images": [],
                        "local_images": [],
                        "audio": [],
                        "local_audio": [],
                        "text_elements": [],
                    },
                }
            )

        first = codex_raw_turn_from_line(user_line("first at this instant"))
        second = codex_raw_turn_from_line(user_line("second at this instant"))
        assert first is not None
        assert second is not None
        assert first.turn_uuid != second.turn_uuid

        # Deterministic: the same record re-parsed keeps the same identity, so a
        # re-run of the same file resumes instead of duplicating every turn.
        repeat = codex_raw_turn_from_line(user_line("first at this instant"))
        assert repeat is not None
        assert repeat.turn_uuid == first.turn_uuid

    @pytest.mark.parametrize(
        "line",
        [
            (
                '{"timestamp":"2026-08-02T03:11:22.000Z","type":"event_msg",'
                '"payload":{"type":"task_started","turn_id":"t1",'
                '"started_at":1,"model_context_window":1000,'
                '"collaboration_mode_kind":"default"}}'
            ),
            (
                '{"timestamp":"2026-08-02T03:11:26.000Z","type":"event_msg",'
                '"payload":{"type":"token_count","info":{'
                '"total_token_usage":{},"last_token_usage":{},'
                '"model_context_window":1000},"rate_limits":{}}}'
            ),
            (
                '{"timestamp":"2026-08-02T03:11:25.000Z","type":"event_msg",'
                '"payload":{"type":"agent_message","message":"valid non-turn",'
                '"phase":"commentary","memory_citation":null}}'
            ),
            (
                '{"timestamp":"2026-08-02T03:11:27.000Z","type":"event_msg",'
                '"payload":{"type":"task_complete","turn_id":"t1",'
                '"last_agent_message":null,"started_at":1,"completed_at":2,'
                '"duration_ms":1,"time_to_first_token_ms":1}}'
            ),
        ],
    )
    def test_valid_metadata_and_nonfinal_events_are_declined(self, line: str) -> None:
        assert codex_raw_turn_from_line(line) is None


class TestMalformedCodexLinesFailLoud:
    """Malformed rollout data names its shape and source line, never vanishing."""

    @pytest.mark.parametrize(
        "line",
        [
            "",
            "{not json",
            (
                '{"timestamp":"2026-08-02T03:11:27.000Z","type":"event_msg",'
                '"payload":{"type":"task_complete","turn_id":"t1"}}'
            ),
            (
                '{"timestamp":"2026-08-02T03:11:24.000Z","type":"event_msg",'
                '"payload":{"type":"user_message","message":[],'
                '"images":[],"local_images":[],"audio":[],"local_audio":[],'
                '"text_elements":[]}}'
            ),
        ],
    )
    def test_adapter_raises_actionable_content_free_error(self, line: str) -> None:
        with pytest.raises(MalformedCodexRecordError) as raised:
            codex_raw_turn_from_line(line)

        message = str(raised.value)
        assert "malformed Codex rollout record" in message
        assert "ACTION REQUIRED" in message
        assert "No message content is included" in message

    def test_stage_file_names_the_bad_jsonl_line_and_stages_nothing(
        self, tmp_path: Path
    ) -> None:
        source = tmp_path / "broken-codex.jsonl"
        source.write_text(
            CODEX_FIXTURE.read_text(encoding="utf-8").splitlines()[0]
            + "\n{not json\n",
            encoding="utf-8",
        )
        store = StagingStore(tmp_path / "stage.sqlite")

        with pytest.raises(MalformedCodexRecordError) as raised:
            stage_file(source, InputFormat.CODEX, store)

        assert f"{source}:2" in str(raised.value)
        assert store.counts().staged == 0


class TestClaudeAdapterIsTheReusedPureFunction:
    """The Claude adapter is imported from capture, not reimplemented here."""

    def test_claude_adapter_is_records_raw_turn_from_line(self) -> None:
        # Reuse by IMPORT, not by copy: the factory hands back the exact pure
        # function the live adapter parses lines with (operator: "reuse already
        # working code, good.").
        assert adapter_for(InputFormat.CLAUDE) is raw_turn_from_line
