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


def test_redaction_scrubs_stripe_style_underscore_keys():
    stripe_live = token_sample("sk", "_live_", "a" * 24)
    stripe_test = token_sample("pk", "_test_", "b" * 24)

    redacted = redact_text(f"stripe {stripe_live} and {stripe_test}")

    assert stripe_live not in redacted
    assert stripe_test not in redacted
    assert redacted.count("[REDACTED]") == 2


def test_redaction_scrubs_url_embedded_credentials():
    url = token_sample("postgres://", "admin:", "hunter2pw", "@10.0.0.1:5432/app")

    redacted = redact_text(f"db at {url}")

    assert "hunter2pw" not in redacted
    assert "[REDACTED]" in redacted


def test_redaction_scrubs_url_credentials_uppercase_scheme():
    # URI schemes are case-insensitive; keep 1:1 with the TS /i-compiled pattern.
    url = token_sample("HTTPS://", "admin:", "hunter2pw", "@host/x")

    redacted = redact_text(f"db at {url}")

    assert "hunter2pw" not in redacted
    assert "[REDACTED]" in redacted


def test_redaction_scans_large_input_in_linear_time():
    # ReDoS regression: the URL credential pattern once backtracked O(n^2) on
    # long input via an unanchored scheme prefix. A fixed scheme alternation
    # fixed it. 80k chars must redact well under a second.
    import time

    start = time.perf_counter()
    redact_text("a" * 80_000)
    redact_text("http" + ":x" * 40_000)
    assert time.perf_counter() - start < 1.0


def test_redaction_scrubs_labeled_long_secret():
    secret = token_sample("client_secret=", "Ab9" * 8, "xyz")

    redacted = redact_text(secret)

    assert "[REDACTED]" in redacted


def test_redaction_keeps_plain_url_without_credentials_visible():
    url = "https://github.com/rodaddy/open-brain"

    redacted = redact_text(f"see {url}")

    assert url in redacted
    assert "[REDACTED]" not in redacted


def test_redaction_keeps_benign_40_character_hex_ids_visible():
    sha_like_id = token_sample("0123456789", "abcdef0123", "456789abcd", "ef01234567")

    redacted = redact_text(f"commit {sha_like_id}")

    assert sha_like_id in redacted
    assert "[REDACTED]" not in redacted


def test_redaction_scrubs_bare_three_segment_non_jwt_token():
    # Non-`eyJ` opaque `token.a.sig` shape (#92 superset parity with the
    # rtech-hermes fork). JWTs are already covered; this is the bare sibling.
    token = token_sample(
        "AbCdEfGhIjKlMnOpQrStUv",  # 20+ head
        ".abcdef",  # 6+ middle
        ".WxYzWxYzWxYzWxYzWxYzWx",  # 20+ tail
    )

    redacted = redact_text(f"opaque token {token}")

    assert token not in redacted
    assert "[REDACTED]" in redacted


def test_redaction_scrubs_unlabeled_high_entropy_blob_with_dash():
    blob = token_sample("a" * 20, "-", "b" * 25)

    redacted = redact_text(f"opaque {blob}")

    assert blob not in redacted
    assert "[REDACTED]" in redacted


def test_redaction_scrubs_unlabeled_high_entropy_blob_with_underscore():
    blob = token_sample("a" * 20, "_", "b" * 25)

    redacted = redact_text(f"opaque {blob}")

    assert blob not in redacted
    assert "[REDACTED]" in redacted


def test_redaction_scrubs_unlabeled_high_entropy_blob_with_base64_symbols():
    blob = token_sample("a" * 20, "+/=", "b" * 25)

    redacted = redact_text(f"opaque {blob}")

    assert blob not in redacted
    assert "[REDACTED]" in redacted


def test_redaction_keeps_benign_64_character_git_sha_visible():
    # ANTI-SHA GUARD regression: a full-length content hash / git object SHA is
    # pure hex (no `- _ + / =` symbol), so the unlabeled high-entropy detector
    # must leave it in the clear even though it is well over 40 chars.
    sha = token_sample(
        "68be7d3fa4",
        "6ec75266ea",
        "f407a4ed91",
        "1ac046588e",
        "a1148136a3",
        "2a516aca79",
        "6120",
    )
    assert len(sha) == 64

    redacted = redact_text(f"schema_hash {sha}")

    assert sha in redacted
    assert "[REDACTED]" not in redacted


def test_redaction_keeps_benign_40_character_hex_sha_visible():
    # 40-char short git SHA -- exactly the length of the high-entropy blob
    # trigger but with no symbol, so the anti-SHA guard keeps it visible.
    sha = token_sample("0123456789", "abcdef0123", "456789abcd", "ef01234567")
    assert len(sha) == 40

    redacted = redact_text(f"commit {sha}")

    assert sha in redacted
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
