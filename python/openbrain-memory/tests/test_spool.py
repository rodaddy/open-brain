"""Tests for spool durability and grouped replay behavior."""

from __future__ import annotations

import json
import os
import threading
from typing import Any
from unittest.mock import patch

import pytest

import openbrain_memory.spool as spool_module
from openbrain_memory import (
    AgentMemory,
    JsonlSpool,
    RetryExhaustedError,
    RetryPolicy,
    SpoolRecord,
    replay_records,
)


def token_sample(*parts: str) -> str:
    return "".join(parts)


class FlakyClient:
    def __init__(self, failures: int = 0) -> None:
        self.failures = failures
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def session_start(self, **arguments: Any) -> dict[str, bool]:
        self.calls.append(("session_start", arguments))
        if self.failures:
            self.failures -= 1
            raise ConnectionError("temporary")
        return {"ok": True}

    def session_context(self, **arguments: Any) -> dict[str, bool]:
        self.calls.append(("session_context", arguments))
        return {"ok": True}

    def append_session_event(self, **arguments: Any) -> dict[str, bool]:
        self.calls.append(("append_session_event", arguments))
        if self.failures:
            self.failures -= 1
            raise ConnectionError("temporary")
        return {"ok": True}

    def search_all(self, **arguments: Any) -> dict[str, Any]:
        self.calls.append(("search_all", arguments))
        return {
            "results": [{"content": "x" * 100, "type": "thought", "source": "brain"}]
        }

    def brain_answer(self, **arguments: Any) -> dict[str, bool]:
        self.calls.append(("brain_answer", arguments))
        return {"ok": True}

    def lane_load(self, **arguments: Any) -> dict[str, bool]:
        self.calls.append(("lane_load", arguments))
        return {"ok": True}

    def lane_upsert(self, **arguments: Any) -> dict[str, bool]:
        self.calls.append(("lane_upsert", arguments))
        return {"ok": True}

    def list_repo_facts(self, **arguments: Any) -> dict[str, bool]:
        self.calls.append(("list_repo_facts", arguments))
        return {"ok": True}

    def log_thought(self, **arguments: Any) -> dict[str, bool]:
        self.calls.append(("log_thought", arguments))
        if self.failures:
            self.failures -= 1
            raise ConnectionError("temporary")
        return {"ok": True}

    def log_decision(self, **arguments: Any) -> dict[str, bool]:
        self.calls.append(("log_decision", arguments))
        if self.failures:
            self.failures -= 1
            raise ConnectionError("temporary")
        return {"ok": True}

    def session_wrap(self, **arguments: Any) -> dict[str, bool]:
        self.calls.append(("session_wrap", arguments))
        if self.failures:
            self.failures -= 1
            raise ConnectionError("temporary")
        return {"ok": True}

    def upsert_repo_fact(self, **arguments: Any) -> dict[str, bool]:
        self.calls.append(("upsert_repo_fact", arguments))
        return {"ok": True}


def test_retries_success_after_transient_failure_without_spooling(tmp_path):
    client = FlakyClient(failures=1)
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    memory = AgentMemory(
        client,
        agent="bilby",
        spool=spool,
        retry_policy=RetryPolicy(attempts=2, backoff_seconds=0),
    )

    memory.start_session("session")

    assert [name for name, _ in client.calls] == ["session_start", "session_start"]
    assert not spool.path.exists()


def test_non_idempotent_write_is_not_retried_but_is_spooled(tmp_path):
    client = FlakyClient(failures=1)
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    memory = AgentMemory(
        client,
        agent="bilby",
        spool=spool,
        retry_policy=RetryPolicy(attempts=2, backoff_seconds=0),
    )

    with pytest.raises(ConnectionError):
        memory.remember_fact("fact")

    assert [name for name, _ in client.calls] == ["log_thought"]
    assert spool.records()[0].operation == "log_thought"


def test_spool_records_skip_corrupted_jsonl_lines(tmp_path, caplog):
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    spool.path.write_text(
        "\n".join(
            [
                '{"created_at":1,"idempotency_key":"good-1","operation":"one","payload":{"content":"ok"}}',
                '{"created_at":2,"idempotency_key":"bad","operation":',
                "{}",
                "[]",
                '{"idempotency_key":"missing-operation"}',
                (
                    '{"created_at":"not-a-float","idempotency_key":"bad-time",'
                    '"operation":"bad","payload":{}}'
                ),
                (
                    '{"created_at":2,"idempotency_key":"bad-payload",'
                    '"operation":"bad","payload":[]}'
                ),
                (
                    '{"created_at":3,"idempotency_key":"good-2",'
                    '"operation":"two","payload":{"content":"still ok"}}'
                ),
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    records = spool.records()

    assert [record.idempotency_key for record in records] == ["good-1", "good-2"]
    assert [record.operation for record in records] == ["one", "two"]
    assert "Skipping corrupted spool record" in caplog.text
    assert caplog.text.count("Skipping corrupted spool record") == 6


def test_spool_status_missing_path_is_empty(tmp_path):
    spool = JsonlSpool(tmp_path / "missing.jsonl", max_lines=7, max_bytes=700)

    status = spool.status()

    assert status.path == str(spool.path)
    assert status.exists is False
    assert status.pending_count == 0
    assert status.max_lines == 7
    assert status.max_bytes == 700
    assert status.oldest_created_at is None
    assert status.newest_created_at is None
    assert status.operation_counts == {}
    assert status.corrupted_line_count == 0


def test_spool_status_empty_path_is_empty_but_existing(tmp_path):
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    spool.path.write_text("", encoding="utf-8")

    status = spool.status()

    assert status.exists is True
    assert status.pending_count == 0
    assert status.operation_counts == {}
    assert status.corrupted_line_count == 0


def test_spool_status_counts_records_without_payload_leakage(tmp_path):
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    secret = "password: " + token_sample("hunt", "er2")

    spool.append("log_thought", {"content": secret}, key="one")
    spool.append("log_thought", {"content": "safe"}, key="two")
    spool.append("session_start", {"topic": "canary"}, key="three")

    status = spool.status()

    assert status.exists is True
    assert status.pending_count == 3
    assert status.operation_counts == {"log_thought": 2, "session_start": 1}
    assert status.corrupted_line_count == 0
    assert status.oldest_created_at is not None
    assert status.newest_created_at is not None
    assert status.oldest_created_at <= status.newest_created_at
    assert token_sample("hunt", "er2") not in repr(status)
    assert "content" not in repr(status)
    assert "safe" not in repr(status)


def test_spool_status_counts_corrupted_lines_without_changing_records(tmp_path):
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    spool.path.write_text(
        "\n".join(
            [
                '{"created_at":1,"idempotency_key":"good-1","operation":"one","payload":{"content":"ok"}}',
                '{"created_at":2,"idempotency_key":"bad","operation":',
                "{}",
                "[]",
                '{"idempotency_key":"missing-operation"}',
                (
                    '{"created_at":"not-a-float","idempotency_key":"bad-time",'
                    '"operation":"bad","payload":{}}'
                ),
                (
                    '{"created_at":2,"idempotency_key":"bad-payload",'
                    '"operation":"bad","payload":[]}'
                ),
                (
                    '{"created_at":3,"idempotency_key":"good-2",'
                    '"operation":"two","payload":{"content":"still ok"}}'
                ),
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    status = spool.status()

    assert status.pending_count == 2
    assert status.operation_counts == {"one": 1, "two": 1}
    assert status.oldest_created_at == 1
    assert status.newest_created_at == 3
    assert status.corrupted_line_count == 6
    assert [record.idempotency_key for record in spool.records()] == [
        "good-1",
        "good-2",
    ]


def test_failed_write_spools_replayable_payload_with_redacted_diagnostic_view(tmp_path):
    client = FlakyClient(failures=3)
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    memory = AgentMemory(
        client,
        agent="bilby",
        spool=spool,
        retry_policy=RetryPolicy(attempts=2, backoff_seconds=0),
    )

    with pytest.raises(ConnectionError):
        memory.remember_fact(
            "token=" + token_sample("super", "secret"),
            tags=["incident", "memory"],
        )

    mode = os.stat(spool.path).st_mode & 0o777
    lock_mode = os.stat(spool.lock_path).st_mode & 0o777
    records = spool.records()
    replayed = []

    def dispatch(record: SpoolRecord):
        replayed.append(record)
        return {"ok": True}

    assert mode == 0o600
    assert lock_mode == 0o600
    assert len(records) == 1
    assert records[0].operation == "log_thought"
    assert records[0].payload == client.calls[0][1]
    assert records[0].payload["tags"] == [
        "fact",
        "incident",
        "memory",
        f"idempotency:{records[0].idempotency_key}",
    ]
    assert token_sample("super", "secret") in str(records[0].payload)
    assert token_sample("super", "secret") not in str(records[0].redacted_payload())
    assert token_sample("super", "secret") not in str(
        spool.redacted_records()[0].payload
    )
    assert records[0].idempotency_key
    assert spool.replay(dispatch) == [{"ok": True}]
    assert replayed[0].operation == records[0].operation
    assert replayed[0].idempotency_key == records[0].idempotency_key
    assert replayed[0].payload == records[0].payload


def test_live_write_payload_preserves_original_content():
    client = FlakyClient()
    memory = AgentMemory(client, agent="bilby")

    memory.remember_fact("password: " + token_sample("hunt", "er2"))

    assert token_sample("hunt", "er2") in client.calls[0][1]["content"]
    assert "[REDACTED]" not in client.calls[0][1]["content"]


def test_spool_trims_old_records_by_line_count(tmp_path):
    spool = JsonlSpool(tmp_path / "spool.jsonl", max_lines=2)

    spool.append("one", {"content": "1"}, key="one")
    spool.append("two", {"content": "2"}, key="two")
    spool.append("three", {"content": "3"}, key="three")

    assert [record.operation for record in spool.records()] == ["two", "three"]


def test_spool_replay_removes_successes_and_keeps_failures(tmp_path):
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    spool.append("ok", {"content": "1"}, key="ok-key")
    spool.append("fail", {"content": "2"}, key="fail-key")
    seen = []

    def dispatch(record: SpoolRecord):
        seen.append((record.idempotency_key, record.operation, dict(record.payload)))
        if record.operation == "fail":
            raise RuntimeError("still down")
        return {"ok": True}

    assert spool.replay(dispatch) == [{"ok": True}]
    assert seen == [
        ("ok-key", "ok", {"content": "1"}),
        ("fail-key", "fail", {"content": "2"}),
    ]
    assert [record.operation for record in spool.records()] == ["fail"]


def test_spool_replay_allows_appends_during_dispatch(tmp_path):
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    spool.append("ok", {"content": "1"}, key="ok-key")
    appended = threading.Event()

    def dispatch(record: SpoolRecord):
        thread = threading.Thread(
            target=lambda: (
                spool.append("new", {"content": "2"}, key="new-key"),
                appended.set(),
            )
        )
        thread.start()
        thread.join(timeout=1)
        assert appended.is_set()
        return {"ok": True}

    assert spool.replay(dispatch) == [{"ok": True}]
    assert [record.idempotency_key for record in spool.records()] == ["new-key"]


def test_spool_batch_is_atomic_and_preserves_order(tmp_path):
    spool = JsonlSpool(tmp_path / "spool.jsonl")

    keys = spool.append_batch(
        [
            ("session_start", {"session_key": "lane"}, "start-key"),
            ("session_wrap", {"session_key": "lane"}, "write-key"),
        ]
    )

    assert keys == ["start-key", "write-key"]
    records = spool.records()
    assert [record.operation for record in records] == [
        "session_start",
        "session_wrap",
    ]
    assert records[0].group_id
    assert [record.group_id for record in records] == [
        records[0].group_id,
        records[0].group_id,
    ]
    assert [record.group_index for record in records] == [0, 1]
    assert [record.group_size for record in records] == [2, 2]


def test_spool_completes_positive_short_writes(tmp_path):
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    real_write = os.write

    def short_write(fd, payload):
        return real_write(fd, payload[:7])

    with patch.object(spool_module.os, "write", side_effect=short_write):
        spool.append("event", {"content": "x" * 200}, key="event-key")

    assert [record.idempotency_key for record in spool.records()] == ["event-key"]
    assert spool.records()[0].payload == {"content": "x" * 200}


@pytest.mark.parametrize("failed_fsync", [1, 2])
def test_spool_durability_failure_preserves_valid_file(tmp_path, failed_fsync):
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    spool.append("existing", {"content": "safe"}, key="existing-key")
    original = spool.path.read_bytes()
    real_fsync = os.fsync
    calls = 0

    def fail_once(fd):
        nonlocal calls
        calls += 1
        if calls == failed_fsync:
            raise OSError("injected fsync failure")
        return real_fsync(fd)

    with patch.object(spool_module.os, "fsync", side_effect=fail_once):
        with pytest.raises(OSError, match="injected fsync failure"):
            spool.append("new", {"content": "unsafe"}, key="new-key")

    assert spool.path.read_bytes() == original
    assert [record.idempotency_key for record in spool.records()] == ["existing-key"]


def test_spool_later_append_evicts_whole_existing_batch(tmp_path):
    spool = JsonlSpool(tmp_path / "spool.jsonl", max_lines=2)
    spool.append_batch(
        [
            ("session_start", {"session_key": "lane"}, "start-key"),
            ("session_wrap", {"session_key": "lane"}, "write-key"),
        ]
    )

    spool.append("new", {"content": "safe"}, key="new-key")

    assert [record.idempotency_key for record in spool.records()] == ["new-key"]


def test_spool_replay_preserves_batch_for_later_group_eviction(tmp_path):
    spool = JsonlSpool(tmp_path / "spool.jsonl", max_lines=3)
    spool.append("old", {"content": "safe"}, key="old-key")
    spool.append_batch(
        [
            ("session_start", {"session_key": "lane"}, "start-key"),
            ("session_wrap", {"session_key": "lane"}, "write-key"),
        ]
    )
    seen = []

    def dispatch(record: SpoolRecord):
        seen.append(record.operation)
        if record.operation == "session_start":
            raise ConnectionError("still down")
        return {"ok": True}

    assert spool.replay(dispatch) == [{"ok": True}]
    assert seen == ["old", "session_start"]
    remaining = spool.records()
    assert [record.idempotency_key for record in remaining] == [
        "start-key",
        "write-key",
    ]
    assert remaining[0].group_id
    assert [record.group_id for record in remaining] == [
        remaining[0].group_id,
        remaining[0].group_id,
    ]

    spool.append("new-one", {"content": "1"}, key="new-one-key")
    spool.append("new-two", {"content": "2"}, key="new-two-key")

    assert [record.idempotency_key for record in spool.records()] == [
        "new-one-key",
        "new-two-key",
    ]


def test_spool_replay_retains_malformed_ordered_group_without_dispatch(tmp_path):
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    spool.append_batch(
        [
            ("session_start", {"session_key": "lane"}, "start-key"),
            ("session_wrap", {"session_key": "lane"}, "write-key"),
        ]
    )
    lines = spool.path.read_text(encoding="utf-8").splitlines()
    malformed = json.loads(lines[1])
    del malformed["operation"]
    lines[1] = json.dumps(malformed, separators=(",", ":"), sort_keys=True)
    spool.path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    original = spool.path.read_bytes()
    seen = []

    assert (
        spool.replay(lambda record: seen.append(record.operation) or {"ok": True}) == []
    )
    assert seen == []
    assert spool.path.read_bytes() == original
    assert spool.records() == []
    assert spool.status().corrupted_line_count == 1


@pytest.mark.parametrize(
    ("field", "malformed_value"),
    [
        ("operation", 7),
        ("operation", ""),
        ("operation", "  "),
        ("idempotency_key", 7),
        ("idempotency_key", ""),
        ("idempotency_key", "  "),
    ],
)
def test_spool_replay_rejects_raw_identity_coercion_and_retains_group(
    tmp_path,
    field,
    malformed_value,
):
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    spool.append_batch(
        [
            ("session_start", {"session_key": "lane"}, "start-key"),
            ("session_wrap", {"session_key": "lane"}, "write-key"),
        ]
    )
    lines = spool.path.read_text(encoding="utf-8").splitlines()
    malformed = json.loads(lines[1])
    malformed[field] = malformed_value
    lines[1] = json.dumps(malformed, separators=(",", ":"), sort_keys=True)
    spool.path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    original = spool.path.read_bytes()
    seen = []

    assert (
        spool.replay(lambda record: seen.append(record.operation) or {"ok": True}) == []
    )
    assert seen == []
    assert spool.path.read_bytes() == original
    assert spool.records() == []
    assert spool.status().corrupted_line_count == 1


def test_spool_replay_retains_incomplete_ordered_group_without_dispatch(tmp_path):
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    spool.append_batch(
        [
            ("session_start", {"session_key": "lane"}, "start-key"),
            ("session_wrap", {"session_key": "lane"}, "write-key"),
        ]
    )
    first_line = spool.path.read_text(encoding="utf-8").splitlines(keepends=True)[0]
    spool.path.write_text(first_line, encoding="utf-8")
    seen = []

    assert (
        spool.replay(lambda record: seen.append(record.operation) or {"ok": True}) == []
    )
    assert seen == []
    assert spool.path.read_text(encoding="utf-8") == first_line
    assert spool.status().corrupted_line_count == 1


def test_spool_replay_retains_whole_group_when_later_member_fails(tmp_path):
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    spool.append_batch(
        [
            ("session_start", {"session_key": "lane"}, "start-key"),
            ("session_wrap", {"session_key": "lane"}, "write-key"),
        ]
    )
    seen = []

    def dispatch(record):
        seen.append(record.operation)
        if record.operation == "session_wrap":
            raise ConnectionError("still down")
        return {"ok": True}

    assert spool.replay(dispatch) == []
    assert seen == ["session_start", "session_wrap"]
    assert [record.idempotency_key for record in spool.records()] == [
        "start-key",
        "write-key",
    ]


def test_spool_records_reject_malformed_group_metadata(tmp_path, caplog):
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    spool.path.write_text(
        '{"created_at":1,"group_id":"group","idempotency_key":"bad",'
        '"operation":"op","payload":{}}\n',
        encoding="utf-8",
    )

    assert spool.records() == []
    assert "Skipping corrupted spool record" in caplog.text
    status = spool.status()
    assert status.pending_count == 0
    assert status.corrupted_line_count == 1


def test_spool_replay_keeps_legacy_ungrouped_records_compatible(tmp_path):
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    spool.path.write_text(
        '{"created_at":1,"idempotency_key":"legacy-key",'
        '"operation":"legacy","payload":{"content":"safe"}}\n',
        encoding="utf-8",
    )

    record = spool.records()[0]
    assert (record.group_id, record.group_index, record.group_size) == (
        None,
        None,
        None,
    )

    def fail_dispatch(_: SpoolRecord):
        raise ConnectionError("down")

    assert spool.replay(fail_dispatch) == []
    rewritten = spool.records()[0]
    assert (rewritten.group_id, rewritten.group_index, rewritten.group_size) == (
        None,
        None,
        None,
    )


def test_spool_batch_limit_failure_leaves_existing_records_unchanged(tmp_path):
    spool = JsonlSpool(tmp_path / "spool.jsonl", max_lines=2)
    spool.append("existing", {"content": "safe"}, key="existing-key")

    with pytest.raises(ValueError, match="batch"):
        spool.append_batch(
            [
                ("session_start", {"session_key": "lane"}, "start-key"),
                ("session_wrap", {"session_key": "lane"}, "write-key"),
                ("extra", {"session_key": "lane"}, "extra-key"),
            ]
        )

    assert [record.idempotency_key for record in spool.records()] == ["existing-key"]


def test_spool_rejects_oversized_record_before_success(tmp_path):
    spool = JsonlSpool(tmp_path / "spool.jsonl", max_bytes=120)

    with pytest.raises(ValueError, match="max_bytes"):
        spool.append("large", {"content": "x" * 500}, key="large-key")

    assert spool.records() == []


def test_spool_failure_does_not_mask_original_write_error(tmp_path):
    client = FlakyClient(failures=1)
    spool = JsonlSpool(tmp_path / "spool.jsonl", max_bytes=120)
    memory = AgentMemory(client, agent="bilby", spool=spool)

    with pytest.raises(ConnectionError) as error:
        memory.remember_fact("x" * 500)

    assert any("Failed to spool log_thought" in note for note in error.value.__notes__)
    assert spool.records() == []


def test_spooled_operation_can_replay_through_real_client_method(tmp_path):
    client = FlakyClient(failures=1)
    spool = JsonlSpool(tmp_path / "spool.jsonl")
    memory = AgentMemory(client, agent="bilby", spool=spool)
    secret = "password: " + token_sample("hunt", "er2")

    with pytest.raises(ConnectionError):
        memory.remember_fact(secret, tags=["replay"])

    key = spool.records()[0].idempotency_key
    replay_client = FlakyClient()

    def dispatch(record: SpoolRecord):
        return getattr(replay_client, record.operation)(**record.payload)

    assert spool.replay(dispatch) == [{"ok": True}]
    assert replay_client.calls == [
        (
            "log_thought",
            {
                "content": secret,
                "tags": [
                    "fact",
                    "replay",
                    f"idempotency:{key}",
                ],
            },
        )
    ]


def test_replay_records_passes_full_record():
    records = [SpoolRecord("key", "op", {"content": "x"}, 1.0)]

    assert replay_records(records, lambda record: {"key": record.idempotency_key}) == [
        {"key": "key"}
    ]


def test_spool_rejects_symlink_path(tmp_path):
    target = tmp_path / "target.jsonl"
    link = tmp_path / "link.jsonl"
    target.write_text("", encoding="utf-8")
    link.symlink_to(target)

    with pytest.raises(OSError, match="symlink"):
        JsonlSpool(link).append("op", {"content": "x"})


def test_recall_context_is_bounded_by_count_and_character_budget():
    memory = AgentMemory(
        FlakyClient(),
        agent="bilby",
        policy={"max_items": 1, "max_chars": 20, "max_item_chars": 100},
    )

    context = memory.recall("bounded")

    assert len(context.items) == 1
    assert len(context.as_prompt_text()) <= 20
    assert context.raw == {}


def test_safety_exports_are_public():
    assert RetryExhaustedError
    assert replay_records
