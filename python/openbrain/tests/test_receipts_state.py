"""The receipt writer's own behaviour, without the gate in the loop.

The cross-language proof (``test_receipts_gate_crosslang``) shows the gate accepts
what this package writes. These tests cover what that one cannot: the properties
that only matter when something ELSE has already written the file -- a TypeScript
writer, a crashed process, a future version -- and which show up as a corrupted or
silently-emptied shared file rather than as a failed assertion.

See Also:
    - ``openbrain.receipts.state`` - the module under test
"""

from __future__ import annotations

import json
import os
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from openbrain.receipts import (
    RECEIPT_STATE_SCHEMA,
    ProviderReceiptEvidence,
    ReceiptStateError,
    default_receipt_state_path,
    ensure_compact_cycle,
    open_compact_cycle,
    receipt_mode,
    record_provider_receipt,
    start_compact_cycle,
)
from openbrain.receipts.filelock import LockTimeoutError, receipt_lock

SESSION_ID = "unit-session"
PROJECT = "open-brain"


def _now_iso() -> str:
    """A timestamp in the shape the gate parses."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _capture_receipt(**overrides: object) -> ProviderReceiptEvidence:
    """A well-formed capture receipt, with fields overridable per test."""
    fields: dict[str, object] = {
        "operation": "capture",
        "mode": receipt_mode(
            "capture",
            "saved",
            durable=True,
            direct_attempted=True,
            fallback_attempted=False,
        ),
        "status": "saved",
        "project": PROJECT,
        "session_id": SESSION_ID,
        "trigger": "explicit",
        "direct_attempted": True,
        "recorded_at": _now_iso(),
    }
    fields.update(overrides)
    return ProviderReceiptEvidence.model_validate(fields)


def _document(path: Path) -> dict[str, object]:
    """The state file, decoded."""
    decoded = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(decoded, dict)
    return decoded


def _sessions(path: Path) -> dict[str, object]:
    """The ``sessions`` index."""
    sessions = _document(path)["sessions"]
    assert isinstance(sessions, dict)
    return sessions


def _cycles(path: Path) -> dict[str, object]:
    """The ``compactCycles`` index."""
    cycles = _document(path)["compactCycles"]
    assert isinstance(cycles, dict)
    return cycles


def test_default_path_follows_xdg_state_home(monkeypatch: pytest.MonkeyPatch) -> None:
    """The file location tracks ``XDG_STATE_HOME`` exactly as TypeScript's does."""
    monkeypatch.setenv("XDG_STATE_HOME", "/somewhere/state")

    assert default_receipt_state_path() == Path(
        "/somewhere/state/agent-runtime/openbrain-memory/receipts.json"
    )


def test_empty_xdg_state_home_falls_back_to_home(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An EMPTY ``XDG_STATE_HOME`` means "unset", as JavaScript's ``||`` treats it.

    An ``os.environ.get(..., default)`` would return the empty string here and
    resolve the receipt file relative to the current directory, putting the Python
    writer and the TypeScript reader on different files. That failure presents as
    the gate simply never unblocking, with a perfectly valid receipt on disk.
    """
    monkeypatch.setenv("XDG_STATE_HOME", "")

    assert default_receipt_state_path() == (
        Path.home() / ".local/state/agent-runtime/openbrain-memory/receipts.json"
    )


def test_receipt_lands_in_both_indexes_the_gate_reads(tmp_path: Path) -> None:
    """A receipt is filed per-operation AND per-trigger, the two queries the gate makes."""
    path = tmp_path / "receipts.json"

    record_provider_receipt(path, _capture_receipt())

    document = _document(path)
    assert document["schema"] == RECEIPT_STATE_SCHEMA

    per_operation = _sessions(path)[SESSION_ID]
    assert isinstance(per_operation, dict)
    assert set(per_operation) == {"capture"}

    trigger_receipts = document["triggerReceipts"]
    assert isinstance(trigger_receipts, dict)
    assert set(trigger_receipts[SESSION_ID]) == {"capture:explicit:uncorrelated"}


def test_serialised_keys_are_camel_case(tmp_path: Path) -> None:
    """Every field name on disk is the one the TypeScript reader looks up.

    A snake_case key here is not a style difference: the gate reads
    ``fallbackAttempted`` and ``contractSchemaHash`` by exact name, and a receipt
    spelling them otherwise is skipped as not matching the contract.
    """
    path = tmp_path / "receipts.json"

    record_provider_receipt(path, _capture_receipt())

    stored = _sessions(path)[SESSION_ID]
    assert isinstance(stored, dict)
    capture = stored["capture"]
    assert isinstance(capture, dict)
    assert {
        "sessionId",
        "directAttempted",
        "recordedAt",
        "fallbackAttempted",
        "contractSchemaVersion",
        "contractSchemaHash",
    } <= set(capture)
    assert not [key for key in capture if "_" in key]


def test_contract_triple_cannot_be_overridden_by_a_caller() -> None:
    """A caller cannot claim a contract this package does not implement.

    The triple is what the gate uses to decide a receipt came from something
    speaking its protocol. If a caller could set it, a component could write a
    receipt asserting compliance it does not have, and the gate would unblock on
    it.
    """
    with pytest.raises(ValueError, match="contract"):
        _capture_receipt(contract="something-else")

    with pytest.raises(ValueError, match="fallbackAttempted|fallback_attempted"):
        _capture_receipt(fallback_attempted=True)


def test_unrecognised_sections_survive_a_write(tmp_path: Path) -> None:
    """A section this package does not model is written back untouched.

    ``reflexSuppression`` is written by the TypeScript reflex path into this same
    file. Dropping it while recording an unrelated receipt would silently delete
    another component's state, and nothing would report it.
    """
    path = tmp_path / "receipts.json"
    path.write_text(
        json.dumps(
            {
                "schema": RECEIPT_STATE_SCHEMA,
                "sessions": {},
                "compactCycles": {},
                "reflexSuppression": {
                    "other-session": {
                        "project": "elsewhere",
                        "refs": ["brain_record:thought:" + "0" * 8 + "-0000-4000-8000-" + "0" * 12],
                        "updatedAt": _now_iso(),
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    record_provider_receipt(path, _capture_receipt())

    assert "reflexSuppression" in _document(path)


def test_existing_receipts_from_another_session_are_preserved(tmp_path: Path) -> None:
    """Recording a receipt merges into the file rather than replacing it.

    Two sessions share this file. A write that dropped the other session's
    receipts would unblock nothing for it and would look like the gate spuriously
    re-arming.
    """
    path = tmp_path / "receipts.json"
    record_provider_receipt(path, _capture_receipt(session_id="first-session"))

    record_provider_receipt(path, _capture_receipt(session_id="second-session"))

    assert set(_sessions(path)) == {"first-session", "second-session"}


def test_corrupt_file_is_replaced_rather_than_raising(tmp_path: Path) -> None:
    """Unparseable JSON reads as empty, so one bad write does not wedge the hook.

    The TypeScript reader behaves the same way. Raising instead would mean every
    subsequent hook invocation failed on state a crashed writer left behind, with
    no path back to a working file.
    """
    path = tmp_path / "receipts.json"
    path.write_text("{not json at all", encoding="utf-8")

    record_provider_receipt(path, _capture_receipt())

    assert set(_sessions(path)) == {SESSION_ID}


def test_foreign_schema_is_not_merged_into(tmp_path: Path) -> None:
    """A file declaring a schema this version does not know reads as empty.

    Matching ``loadReceiptState``: merging into a document whose shape is unknown
    would produce a file neither version can read.
    """
    path = tmp_path / "receipts.json"
    path.write_text(
        json.dumps({"schema": "some.future.schema.v9", "sessions": {"old": {}}}),
        encoding="utf-8",
    )

    record_provider_receipt(path, _capture_receipt())

    document = _document(path)
    assert document["schema"] == RECEIPT_STATE_SCHEMA
    assert set(_sessions(path)) == {SESSION_ID}


def test_state_file_and_parent_are_owner_only(tmp_path: Path) -> None:
    """Receipts name sessions and projects, so nothing here is group- or world-readable."""
    path = tmp_path / "nested" / "receipts.json"

    record_provider_receipt(path, _capture_receipt())

    assert path.stat().st_mode & 0o077 == 0
    assert path.parent.stat().st_mode & 0o077 == 0


def test_no_staging_files_are_left_behind(tmp_path: Path) -> None:
    """The atomic write cleans up after itself, leaving only the state file.

    A staging file surviving means ``os.replace`` did not run -- the write was not
    atomic, and a reader could have seen a partial document.
    """
    path = tmp_path / "receipts.json"

    record_provider_receipt(path, _capture_receipt())

    assert sorted(entry.name for entry in tmp_path.iterdir()) == ["receipts.json"]


def test_unusable_coordinates_are_refused(tmp_path: Path) -> None:
    """A session id or project that could not be a JSON key the gate matches is refused.

    Silently filing it would produce a receipt nothing ever looks up, which reads
    as "no receipt was written" and is far harder to trace than a named error.
    """
    path = tmp_path / "receipts.json"

    with pytest.raises(ReceiptStateError, match="session_id"):
        record_provider_receipt(path, _capture_receipt(session_id="has a space"))

    with pytest.raises(ReceiptStateError, match="project"):
        record_provider_receipt(path, _capture_receipt(project=""))


def test_lifecycle_hooks_share_one_cycle(tmp_path: Path) -> None:
    """PreCompact, PostCompact, and SessionStart join a single correlation id.

    That shared id is the whole mechanism: it is what lets the gate require the
    recall it is waiting for to belong to THIS compaction rather than an earlier
    one.
    """
    path = tmp_path / "receipts.json"

    opened = open_compact_cycle(path, session_id=SESSION_ID, project=PROJECT)
    started = start_compact_cycle(path, session_id=SESSION_ID, project=PROJECT)
    ensured = ensure_compact_cycle(path, session_id=SESSION_ID, project=PROJECT)

    assert opened.id == started.id == ensured.id
    assert set(ensured.attempted_participants) == {
        "pre-compact",
        "post-compact",
        "session-start",
    }


def test_a_second_precompact_opens_a_second_cycle(tmp_path: Path) -> None:
    """A repeated ``PreCompact`` is a NEW compaction, not a retry of the last one.

    ``PreCompact`` fires once before each compaction, so seeing it twice means two
    compactions. Reusing the cycle would let a recall for the first satisfy the
    read-back armed by the second.
    """
    path = tmp_path / "receipts.json"
    first = open_compact_cycle(path, session_id=SESSION_ID, project=PROJECT)

    second = open_compact_cycle(path, session_id=SESSION_ID, project=PROJECT)

    assert second.id != first.id


def test_a_stale_cycle_is_not_joined(tmp_path: Path) -> None:
    """A cycle older than the gate would accept is replaced rather than joined.

    Joining it would hand the gate a correlation id it treats as expired, so the
    read-back could never be cleared by a recall naming it.
    """
    path = tmp_path / "receipts.json"
    long_ago = datetime.now(UTC) - timedelta(hours=2)
    stale = ensure_compact_cycle(
        path, session_id=SESSION_ID, project=PROJECT, now=long_ago
    )

    fresh = ensure_compact_cycle(path, session_id=SESSION_ID, project=PROJECT)

    assert fresh.id != stale.id


def test_a_cycle_from_another_project_is_not_joined(tmp_path: Path) -> None:
    """The same session id in a different project gets its own cycle."""
    path = tmp_path / "receipts.json"
    elsewhere = ensure_compact_cycle(
        path, session_id=SESSION_ID, project="other-repo"
    )

    here = ensure_compact_cycle(path, session_id=SESSION_ID, project=PROJECT)

    assert here.id != elsewhere.id
    assert here.project == PROJECT


def test_verified_recall_is_stamped_only_by_a_matching_recall(tmp_path: Path) -> None:
    """The cycle's ``verifiedRecallAt`` -- the unblock itself -- has four conditions.

    Operation, trigger, mode, and correlation id must all line up. Each of the
    three near-misses here would, if it stamped the field, let something that is
    not a fresh direct recall of THIS compaction release the gate.
    """
    path = tmp_path / "receipts.json"
    cycle = ensure_compact_cycle(path, session_id=SESSION_ID, project=PROJECT)
    near_misses = [
        {"operation": "capture", "trigger": "compact", "mode": "verified-remote"},
        {"operation": "recall", "trigger": "explicit", "mode": "verified-remote"},
        {"operation": "recall", "trigger": "compact", "mode": "failed"},
    ]

    for fields in near_misses:
        record_provider_receipt(
            path,
            _capture_receipt(status="direct", correlation_id=cycle.id, **fields),
        )
        stored = _cycles(path)[SESSION_ID]
        assert isinstance(stored, dict)
        assert "verifiedRecallAt" not in stored, fields

    record_provider_receipt(
        path,
        _capture_receipt(
            operation="recall",
            trigger="compact",
            mode="verified-remote",
            status="direct",
            correlation_id=cycle.id,
        ),
    )

    stamped = _cycles(path)[SESSION_ID]
    assert isinstance(stamped, dict)
    assert "verifiedRecallAt" in stamped


def test_a_failed_receipt_credits_no_participant(tmp_path: Path) -> None:
    """``participants`` records what SUCCEEDED; the attempt is already recorded elsewhere."""
    path = tmp_path / "receipts.json"
    cycle = start_compact_cycle(path, session_id=SESSION_ID, project=PROJECT)

    record_provider_receipt(
        path,
        _capture_receipt(
            operation="checkpoint",
            trigger="post-compact",
            mode="failed",
            status="failed",
            correlation_id=cycle.id,
        ),
    )

    stored = _cycles(path)[SESSION_ID]
    assert isinstance(stored, dict)
    assert stored["participants"] == []
    assert stored["attemptedParticipants"] == ["post-compact"]


def test_the_lock_is_released_when_the_block_raises(tmp_path: Path) -> None:
    """A failure inside the lock must not leave the file wedged for every later hook."""
    path = tmp_path / "receipts.json"

    with pytest.raises(RuntimeError, match="deliberate"), receipt_lock(path):
        raise RuntimeError("deliberate")

    with receipt_lock(path):
        pass


def test_a_held_lock_blocks_a_second_writer(tmp_path: Path) -> None:
    """The lock actually excludes, rather than being a file that is merely created.

    Asserting the timeout rather than trusting the constant: a lock that does not
    exclude is indistinguishable from one that does until two writers race, and by
    then the symptom is a lost receipt.
    """
    path = tmp_path / "receipts.json"

    def take_it_again() -> None:
        """Contend for the lock the caller already holds.

        A fresh lockfile is not yet stale, so this waits the full window and then
        gives up -- which is why nothing else shares this test.
        """
        with receipt_lock(path):
            pass

    with receipt_lock(path):
        pytest.raises(LockTimeoutError, take_it_again)


def test_an_abandoned_lock_is_reclaimed(tmp_path: Path) -> None:
    """A lock left by a killed process is stolen rather than wedging the file forever.

    Without reclamation one crashed hook would stop every later receipt from being
    written, and the gate would block a session with no way to clear it.
    """
    path = tmp_path / "receipts.json"
    lock_path = path.with_name(path.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text("someone-else:0:dead", encoding="utf-8")
    long_ago = time.time() - 3600
    os.utime(lock_path, (long_ago, long_ago))

    record_provider_receipt(path, _capture_receipt())

    assert set(_sessions(path)) == {SESSION_ID}
