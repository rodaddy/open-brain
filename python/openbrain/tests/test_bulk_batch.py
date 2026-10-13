"""Functional tests for recursive Claude-history bulk ingestion."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from openbrain.apps.bulk.batch import DEFAULT_STAGING_NAME, run
from openbrain.apps.bulk.ingest import ingest
from openbrain.apps.bulk.staging import (
    ConflictingStagedTurnError,
    StagingStore,
    StagingTargetMismatchError,
)
from openbrain.models.turn import RawTurn


def _turn(turn_uuid: str, timestamp: str, content: str = "text") -> str:
    return json.dumps({
        "type": "user",
        "uuid": turn_uuid,
        "promptSource": "typed",
        "sessionId": "batch-session",
        "timestamp": timestamp,
        "message": {"role": "user", "content": content},
    })


@dataclass
class RecordingLane:
    """Record every turn handed to the existing raw lane contract."""

    turns: list[dict[str, Any]] = field(default_factory=list)

    def ingest_raw_turns(self, turns: Any) -> dict[str, Any]:
        self.turns.extend(dict(turn) for turn in turns)
        return {
            "ingested": len(turns),
            "duplicates": 0,
            "filtered": 0,
            "namespace": "rico",
        }


@dataclass
class ReceiptLane:
    """Return one fixed server receipt for every attempted turn."""

    receipt: dict[str, Any]

    def ingest_raw_turns(self, _: Any) -> dict[str, Any]:
        return self.receipt


def test_recursive_scan_includes_parent_and_subagent_files(
    tmp_path: Path, monkeypatch: Any, capsys: Any
) -> None:
    root = tmp_path / "projects"
    parent = root / "project" / "parent.jsonl"
    child = root / "project" / "parent" / "subagents" / "child.jsonl"
    parent.parent.mkdir(parents=True)
    child.parent.mkdir(parents=True)
    parent.write_text(_turn("parent", "2026-09-01T00:00:00Z") + "\n")
    child.write_text(_turn("child", "2026-09-02T00:00:00Z") + "\n")
    lane = RecordingLane()
    monkeypatch.setattr(
        "openbrain.apps.bulk.batch._runtime",
        lambda _: (lane, "https://brain.example/v1"),
    )

    result = run([str(root), "--from-date", "2026-09-01", "--to-date", "2026-09-02"])

    assert result == 0
    assert [turn["turn_uuid"] for turn in lane.turns] == ["parent", "child"]
    staging = tmp_path / f"projects{DEFAULT_STAGING_NAME}"
    assert StagingStore(staging).bound_namespace() == "rico"
    assert (
        "discovered=2 parsed=2 eligible=2 undated=0 delivered=2 deduped=0 filtered=0 failures=0"
        in capsys.readouterr().out
    )


def test_missing_root_fails_before_runtime_or_staging(
    tmp_path: Path, monkeypatch: Any
) -> None:
    missing = tmp_path / "missing"

    def forbidden(*_: Any, **__: Any) -> Any:
        raise AssertionError

    monkeypatch.setattr("openbrain.apps.bulk.batch._runtime", forbidden)
    monkeypatch.setattr("openbrain.apps.bulk.batch.StagingStore", forbidden)

    with pytest.raises(ValueError, match="history root must be an existing directory"):
        run([
            str(missing),
            "--from-date",
            "2026-09-01",
            "--to-date",
            "2026-09-02",
        ])


def test_date_boundaries_are_inclusive(tmp_path: Path, monkeypatch: Any) -> None:
    root = tmp_path / "projects"
    source = root / "history.jsonl"
    root.mkdir()
    source.write_text(
        "\n".join((
            _turn("before", "2026-08-31T23:59:59Z"),
            _turn("start", "2026-09-01T00:00:00Z"),
            _turn("end", "2026-09-02T23:59:59-04:00"),
            _turn("after", "2026-09-03T00:00:00-04:00"),
        ))
        + "\n"
    )
    lane = RecordingLane()
    monkeypatch.setattr(
        "openbrain.apps.bulk.batch._runtime",
        lambda _: (lane, "https://brain.example/v1"),
    )

    assert run([str(root), "--from-date", "2026-09-01", "--to-date", "2026-09-02"]) == 0
    assert [turn["turn_uuid"] for turn in lane.turns] == ["start", "end"]


def test_dry_run_opens_neither_client_nor_staging(
    tmp_path: Path, monkeypatch: Any, capsys: Any
) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    (root / "history.jsonl").write_text(_turn("dry", "2026-09-01T12:00:00Z") + "\n")
    staging = tmp_path / "must-not-exist.sqlite"

    class DryRunSideEffectError(AssertionError):
        """A dependency forbidden to parse-only dry-run was opened."""

    def forbidden(*_: Any, **__: Any) -> Any:
        raise DryRunSideEffectError

    monkeypatch.setattr("openbrain.apps.bulk.batch._runtime", forbidden)
    monkeypatch.setattr("openbrain.apps.bulk.batch.load_capture_settings", forbidden)
    monkeypatch.setattr("openbrain.apps.bulk.batch.StagingStore", forbidden)

    result = run([
        str(root),
        "--from-date",
        "2026-09-01",
        "--to-date",
        "2026-09-01",
        "--staging-path",
        str(staging),
        "--dry-run",
    ])

    assert result == 0
    assert not staging.exists()
    assert (
        "discovered=1 parsed=1 eligible=1 undated=0 invalid=0 delivered=0 deduped=0 "
        "filtered=0 failures=0" in capsys.readouterr().out
    )


def test_repeating_same_source_with_same_staging_dedupes(
    tmp_path: Path, monkeypatch: Any, capsys: Any
) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    (root / "history.jsonl").write_text(_turn("repeat", "2026-09-01T12:00:00Z") + "\n")
    staging = tmp_path / "resume.sqlite"
    lane = RecordingLane()
    monkeypatch.setattr(
        "openbrain.apps.bulk.batch._runtime",
        lambda _: (lane, "https://brain.example/v1"),
    )
    argv = [
        str(root),
        "--from-date",
        "2026-09-01",
        "--to-date",
        "2026-09-01",
        "--staging-path",
        str(staging),
    ]

    assert run(argv) == 0
    assert run(argv) == 0

    assert [turn["turn_uuid"] for turn in lane.turns] == ["repeat"]
    assert (
        "discovered=1 parsed=1 eligible=1 undated=0 delivered=0 deduped=1 filtered=0 failures=0"
        in capsys.readouterr().out
    )


def test_undated_turn_is_held_and_makes_dry_run_non_successful(
    tmp_path: Path, capsys: Any
) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    record = json.loads(_turn("undated", "2026-09-01T12:00:00Z"))
    del record["timestamp"]
    (root / "undated.jsonl").write_text(json.dumps(record) + "\n")

    result = run([
        str(root),
        "--from-date",
        "2026-09-01",
        "--to-date",
        "2026-09-01",
        "--dry-run",
    ])

    assert result == 1
    assert "parsed=1 eligible=0 undated=1" in capsys.readouterr().out


def test_staging_refuses_a_different_source_selection(
    tmp_path: Path, monkeypatch: Any
) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    for root, turn_uuid in ((first, "first"), (second, "second")):
        (root / "history.jsonl").write_text(
            _turn(turn_uuid, "2026-09-01T12:00:00Z") + "\n"
        )
    lane = RecordingLane()
    monkeypatch.setattr(
        "openbrain.apps.bulk.batch._runtime",
        lambda _: (lane, "https://brain.example/v1"),
    )
    staging = tmp_path / "selection.sqlite"
    common = [
        "--from-date",
        "2026-09-01",
        "--to-date",
        "2026-09-01",
        "--staging-path",
        str(staging),
    ]
    assert run([str(first), *common]) == 0

    with pytest.raises(StagingTargetMismatchError):
        run([str(second), *common])


def test_same_uuid_with_different_content_is_not_treated_as_replay(
    tmp_path: Path,
) -> None:
    store = StagingStore(tmp_path / "conflict.sqlite")
    store.stage([RawTurn(turn_uuid="same", content="first")])

    with pytest.raises(ConflictingStagedTurnError):
        store.stage([RawTurn(turn_uuid="same", content="changed")])


def test_staging_refuses_a_different_delivery_target(tmp_path: Path) -> None:
    store = StagingStore(tmp_path / "target.sqlite")
    store.bind_target("https://first.example/v1", "rico")

    with pytest.raises(StagingTargetMismatchError):
        store.bind_target("https://second.example/v1", "rico")


@pytest.mark.parametrize(
    ("receipt", "expected_filtered", "expected_failed"),
    [
        ({"ingested": 1, "duplicates": 0, "filtered": 0}, 0, 1),
        ({"ingested": 1, "duplicates": 0, "filtered": 0, "namespace": "other"}, 0, 1),
        ({"ingested": 0, "duplicates": 0, "filtered": 0, "namespace": "rico"}, 0, 1),
        ({"ingested": 0, "duplicates": 0, "filtered": 1, "namespace": "rico"}, 1, 0),
    ],
)
def test_invalid_or_non_durable_server_receipt_is_not_marked_sent(
    tmp_path: Path,
    receipt: dict[str, Any],
    expected_filtered: int,
    expected_failed: int,
) -> None:
    store = StagingStore(tmp_path / "receipt.sqlite")
    store.stage([RawTurn(turn_uuid="receipt", content="eligible")])

    result = ingest(store, ReceiptLane(receipt), expected_namespace="rico")

    assert result.sent == 0
    assert result.duplicates == 0
    assert result.filtered == expected_filtered
    assert result.quarantined == expected_failed
    assert store.counts().sent == 0


def test_server_duplicate_is_accounted_and_marked_complete(tmp_path: Path) -> None:
    store = StagingStore(tmp_path / "duplicate.sqlite")
    store.stage([RawTurn(turn_uuid="duplicate", content="already there")])
    receipt = {
        "ingested": 0,
        "duplicates": 1,
        "filtered": 0,
        "namespace": "rico",
    }

    result = ingest(store, ReceiptLane(receipt), expected_namespace="rico")

    assert result.sent == 0
    assert result.duplicates == 1
    assert result.quarantined == 0
    assert store.counts().sent == 1


def test_negative_server_counts_are_refused(tmp_path: Path) -> None:
    store = StagingStore(tmp_path / "negative.sqlite")
    store.stage([RawTurn(turn_uuid="negative", content="invalid receipt")])
    receipt = {
        "ingested": -1,
        "duplicates": 2,
        "filtered": 0,
        "namespace": "rico",
    }

    result = ingest(store, ReceiptLane(receipt), expected_namespace="rico")

    assert result.sent == 0
    assert result.duplicates == 0
    assert result.quarantined == 1
    assert store.counts().sent == 0


def test_dry_run_counts_invalid_timestamp_file_instead_of_crashing(
    tmp_path: Path, capsys: Any
) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    (root / "a-bad.jsonl").write_text(_turn("bad", "not-a-timestamp") + "\n")
    (root / "b-good.jsonl").write_text(_turn("good", "2026-09-01T12:00:00Z") + "\n")

    result = run([
        str(root),
        "--from-date",
        "2026-09-01",
        "--to-date",
        "2026-09-01",
        "--dry-run",
    ])

    assert result == 1
    assert "discovered=2 parsed=2 eligible=1 undated=0 invalid=1" in (
        capsys.readouterr().out
    )


def test_default_staging_is_created_outside_the_scanned_root(
    tmp_path: Path, monkeypatch: Any
) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    (root / "history.jsonl").write_text(_turn("one", "2026-09-01T12:00:00Z") + "\n")
    lane = RecordingLane()
    monkeypatch.setattr(
        "openbrain.apps.bulk.batch._runtime",
        lambda _: (lane, "https://brain.example/v1"),
    )

    assert run([str(root), "--from-date", "2026-09-01", "--to-date", "2026-09-01"]) == 0

    assert list(root.rglob("*.sqlite*")) == []
    assert (tmp_path / f"projects{DEFAULT_STAGING_NAME}").is_file()
