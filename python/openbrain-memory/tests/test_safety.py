from __future__ import annotations

import os
import threading

import pytest

from openbrain_memory import (
    AgentMemory,
    JsonlSpool,
    RetryExhaustedError,
    RetryPolicy,
    SpoolRecord,
    redact_text,
    redact_value,
    replay_records,
)


def token_sample(*parts: str) -> str:
    return "".join(parts)


class FlakyClient:
    def __init__(self, failures: int = 0) -> None:
        self.failures = failures
        self.calls = []

    def session_start(self, **arguments):
        self.calls.append(("session_start", arguments))
        if self.failures:
            self.failures -= 1
            raise ConnectionError("temporary")
        return {"ok": True}

    def append_session_event(self, **arguments):
        self.calls.append(("append_session_event", arguments))
        if self.failures:
            self.failures -= 1
            raise ConnectionError("temporary")
        return {"ok": True}

    def search_all(self, **arguments):
        self.calls.append(("search_all", arguments))
        return {
            "results": [{"content": "x" * 100, "type": "thought", "source": "brain"}]
        }

    def log_thought(self, **arguments):
        self.calls.append(("log_thought", arguments))
        if self.failures:
            self.failures -= 1
            raise ConnectionError("temporary")
        return {"ok": True}

    def log_decision(self, **arguments):
        self.calls.append(("log_decision", arguments))
        if self.failures:
            self.failures -= 1
            raise ConnectionError("temporary")
        return {"ok": True}

    def session_wrap(self, **arguments):
        self.calls.append(("session_wrap", arguments))
        if self.failures:
            self.failures -= 1
            raise ConnectionError("temporary")
        return {"ok": True}


def test_redaction_scrubs_common_secret_shapes():
    text = "\n".join(
        [
            "Authorization: Bearer " + token_sample("abcdefgh", "ijklmnop"),
            token_sample("OPENAI_", "API_", "KEY=") + token_sample("sk", "-secret"),
            "password: " + token_sample("hunt", "er2"),
            '"api_key": "json-secret"',
            "token: " + token_sample("sk", "-abcdefghijklmnopqrstuvwxyz"),
            token_sample("GITHUB_", "TOKEN=")
            + token_sample("ghp", "_abcdefghijklmnopqrstuvwxyz"),
            token_sample(
                "-----BEGIN ",
                "PRIVATE ",
                "KEY-----\nabc\n-----END ",
                "PRIVATE ",
                "KEY-----",
            ),
        ]
    )

    redacted = redact_text(text)

    assert "abcdefghijklmnop" not in redacted
    assert token_sample("sk", "-secret") not in redacted
    assert token_sample("hunt", "er2") not in redacted
    assert "json-secret" not in redacted
    assert token_sample("sk", "-abcdefghijklmnopqrstuvwxyz") not in redacted
    assert token_sample("ghp", "_") not in redacted
    assert token_sample("PRIVATE ", "KEY") not in redacted
    assert redacted.count("[REDACTED]") >= 4


def test_redaction_scrubs_unlabelled_cloud_and_token_shapes():
    aws_access_key = token_sample("AKIA", "ABCDEFGHIJKLMNOP")
    aws_secret = token_sample(
        "abcdEFGH", "ijklMNOP", "qrstUVWX", "yz012345", "6789+/ab"
    )
    slack_token = token_sample("xoxb-", "123456789012-", "abcdefghijklmnop")
    google_key = token_sample("AIza", "ABCDEFGHIJKLMNOPQRSTUVWX", "YZabcdefghi")
    jwt_token = token_sample(
        "eyJ",
        "hbGciOiJIUzI1NiJ9.",
        "eyJzdWIiOiJvcGVuLWJyYWluIn0.",
        "c2lnbmF0dXJlX3ZhbHVl",
    )
    text = "\n".join(
        [
            f"aws access {aws_access_key}",
            f"aws secret {aws_secret}",
            f"slack {slack_token}",
            f"google {google_key}",
            f"jwt {jwt_token}",
            "plain sentence with punctuation should stay visible",
        ]
    )

    redacted = redact_text(text)

    assert aws_access_key not in redacted
    assert aws_secret not in redacted
    assert slack_token not in redacted
    assert google_key not in redacted
    assert jwt_token not in redacted
    assert "plain sentence with punctuation should stay visible" in redacted
    assert redacted.count("[REDACTED]") == 5


def test_redaction_scrubs_labelled_alphanumeric_aws_secret():
    aws_secret = token_sample("abcdEFGH", "ijklMNOP", "qrstUVWX", "yz012345", "6789")

    redacted = redact_text(f"aws_secret_access_key={aws_secret}")

    assert aws_secret not in redacted
    assert "[REDACTED]" in redacted


def test_redaction_keeps_benign_40_character_hex_ids_visible():
    sha_like_id = token_sample("0123456789", "abcdef0123", "456789abcd", "ef01234567")

    redacted = redact_text(f"commit {sha_like_id}")

    assert sha_like_id in redacted
    assert "[REDACTED]" not in redacted


def test_redact_value_recurses_sensitive_keys():
    value = {
        "nested": {
            "access_token": "secret-token",
            "session_id": "session-123",
            "mcp_session_id": "session-456",
        },
        "safe": "visible",
    }

    assert redact_value(value) == {
        "nested": {
            "access_token": "[REDACTED]",
            "session_id": "[REDACTED]",
            "mcp_session_id": "[REDACTED]",
        },
        "safe": "visible",
    }


def test_redact_value_bounds_deeply_nested_values():
    value = "secret"
    for _ in range(1200):
        value = {"safe": value}

    redacted = redact_value(value)

    cursor = redacted
    for _ in range(32):
        assert isinstance(cursor, dict)
        cursor = cursor["safe"]
    assert cursor == "[REDACTED:depth]"


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
