"""Tests for direct first-class local Open Brain runtime behavior."""

from __future__ import annotations

import io
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import openbrain_memory.__main__ as main_module
import openbrain_memory.runtime as runtime_module
from openbrain_memory import (
    FirstClassMemoryRuntime,
    JsonlSpool,
    ReceiptStatus,
    RuntimeConfig,
    RuntimeScope,
)
from openbrain_memory.cli import (
    MAX_JSON_INPUT_BYTES,
    encode_json_output,
    execute_json,
    parse_json_input,
)

from ._runtime_fakes import (
    ContextClient,
    FakeRunner,
    FakeSpool,
    LaneAwareTransport,
    StartThenFailClient,
    WriteResultClient,
    request_payload,
    runtime_config,
    runtime_scope,
    tool_calls,
)

MAX_DISTILLED_CONTENT_BYTES = 16 * 1024


def test_config_uses_canonical_environment_and_token_alias_only() -> None:
    config = RuntimeConfig.from_sources(
        {
            "base_url": "https://explicit.example",
            "token": "explicit-token",
            "namespace": "explicit-ns",
            "fallback_enabled": True,
        },
        environ={
            "OPENBRAIN_BASE_URL": "https://env.example",
            "OPENBRAIN_TOKEN": "env-token",
            "OPEN_BRAIN_TOKEN": "alias-token",
            "OPENBRAIN_NAMESPACE": "env-ns",
            "MCP2CLI_AUTH_TOKEN": "must-not-be-read",
        },
    )
    alias = RuntimeConfig.from_env(
        environ={
            "OPENBRAIN_BASE_URL": "https://brain.example",
            "OPEN_BRAIN_TOKEN": "alias-token",
            "OPENBRAIN_NAMESPACE": "bilby",
        }
    )

    assert config.base_url == "https://explicit.example"
    assert config.token == "explicit-token"
    assert config.namespace == "explicit-ns"
    assert config.fallback_enabled is True
    assert alias.token == "alias-token"
    assert "explicit-token" not in repr(config)


def test_config_rejects_fallback_argv_and_non_openbrain_local_route() -> None:
    for explicit in (
        {
            "base_url": "https://brain.example",
            "token": "token-value",
            "namespace": "bilby",
            "fallback_command": ["other-command"],
        },
        {
            "base_url": "http://127.0.0.1:8317",
            "token": "token-value",
            "namespace": "bilby",
        },
    ):
        try:
            RuntimeConfig.from_sources(explicit)
        except ValueError:
            pass
        else:
            raise AssertionError("unsafe runtime config was accepted")


def test_recall_uses_exact_scope_context_pack_and_validated_budget() -> None:
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), transport=transport
    )

    output = runtime.recall_context(
        "what changed?",
        max_tokens=400,
        max_latency_ms=250,
        requested_sections=["working_set"],
    )

    assert output.receipt.status is ReceiptStatus.DIRECT
    calls = tool_calls(transport)
    assert len(calls) == 1
    assert calls[0]["params"] == {
        "name": "agent_context_pack",
        "arguments": {
            "agent": "bilby",
            "platform": "discord",
            "server_id": "guild-1",
            "channel_id": "channel-2",
            "thread_id": "thread-3",
            "session_key": "repo/session-4",
            "query": "what changed?",
            "budget": {"max_tokens": 400, "max_latency_ms": 250},
            "requested_sections": ["working_set"],
        },
    }
    call_request = next(
        request
        for request in transport.requests
        if request["json"].get("method") == "tools/call"
    )
    assert call_request["headers"]["Authorization"] == "Bearer unit-test-token"
    assert call_request["headers"]["X-Agent-Id"] == "bilby"
    assert "X-Namespace" not in call_request["headers"]


def test_recall_rejects_schema_invalid_budget_and_sections_before_transport() -> None:
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), transport=transport
    )

    low_budget = runtime.recall_context("query", max_tokens=99)
    bad_section = runtime.recall_context("query", requested_sections=["unknown"])

    assert low_budget.receipt.status is ReceiptStatus.FAILED
    assert bad_section.receipt.status is ReceiptStatus.FAILED
    assert tool_calls(transport) == []


def test_first_capture_establishes_lane_before_append() -> None:
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(project="open-brain"),
        runtime_scope(),
        transport=transport,
    )

    output = runtime.capture_distilled(
        "Implemented the owned package runtime.",
        event_type="action",
    )

    assert output.receipt.status is ReceiptStatus.SAVED
    calls = tool_calls(transport)
    assert [call["params"]["name"] for call in calls] == [
        "session_start",
        "append_session_event",
    ]
    start = calls[0]["params"]["arguments"]
    assert start == {
        "session_key": "repo/session-4",
        "agent": "bilby",
        "project": "open-brain",
        "platform": "discord",
        "server_id": "guild-1",
        "channel_id": "channel-2",
        "thread_id": "thread-3",
    }
    event = calls[1]["params"]["arguments"]
    assert event["session_key"] == "repo/session-4"
    assert event["event_type"] == "action"
    assert event["agent"] == "bilby"
    assert event["platform"] == "discord"
    assert event["server_id"] == "guild-1"
    assert event["channel_id"] == "channel-2"
    assert event["thread_id"] == "thread-3"
    assert event["metadata"] == {
        "idempotency_key": event["metadata"]["idempotency_key"]
    }


def test_fresh_checkpoint_and_wrap_are_immediately_recallable() -> None:
    for operation, summary in (
        ("checkpoint", "  checkpoint summary\n"),
        ("wrap", "\twrap summary  "),
    ):
        transport = LaneAwareTransport()
        runtime = FirstClassMemoryRuntime(
            runtime_config(project="open-brain"),
            runtime_scope(),
            transport=transport,
        )

        saved = getattr(runtime, operation)(summary)
        recalled = runtime.recall_context(
            "resume",
            requested_sections=["durable_lane_context"],
        )

        assert saved.receipt.status is ReceiptStatus.SAVED
        assert recalled.receipt.status is ReceiptStatus.DIRECT
        assert recalled.context is not None
        assert (
            recalled.context["sections"]["durable_lane_context"]["lane"][
                "current_context_md"
            ]
            == summary
        )
        wrap_call = next(
            call
            for call in tool_calls(transport)
            if call["params"]["name"] == "session_wrap"
        )
        assert wrap_call["params"]["arguments"]["summary"] == summary
        assert (
            wrap_call["params"]["arguments"]
            | {
                "agent": "bilby",
                "platform": "discord",
                "server_id": "guild-1",
                "channel_id": "channel-2",
                "thread_id": "thread-3",
            }
            == wrap_call["params"]["arguments"]
        )


def test_checkpoint_first_lane_denies_hostile_same_namespace_claim() -> None:
    transport = LaneAwareTransport()
    owner = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), transport=transport
    )
    hostile = FirstClassMemoryRuntime(
        runtime_config(),
        RuntimeScope(
            agent="bilby",
            platform="discord",
            server_id="hostile-guild",
            channel_id="channel-2",
            thread_id="thread-3",
            session_key="repo/session-4",
        ),
        transport=transport,
    )

    assert owner.checkpoint("owner summary").receipt.status is ReceiptStatus.SAVED
    denied = hostile.wrap("hostile summary")

    assert denied.receipt.status is ReceiptStatus.LOST
    assert transport.started_sessions["repo/session-4"]["metadata"] == {
        "server_id": "guild-1"
    }
    assert transport.started_sessions["repo/session-4"]["current_context_md"] == (
        "owner summary"
    )


def test_same_session_key_with_different_scope_is_denied_by_transport_boundary() -> (
    None
):
    transport = LaneAwareTransport()
    first = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), transport=transport
    )
    conflicting_scope = RuntimeScope(
        agent="bilby",
        platform="discord",
        server_id="guild-1",
        channel_id="other-channel",
        thread_id="thread-3",
        session_key="repo/session-4",
    )
    second = FirstClassMemoryRuntime(
        runtime_config(),
        conflicting_scope,
        transport=transport,
    )

    assert (
        first.capture_distilled("First scoped event").receipt.status
        is ReceiptStatus.SAVED
    )
    conflict = second.capture_distilled("Conflicting scoped event")

    assert conflict.receipt.status is ReceiptStatus.LOST
    append_calls = [
        call["params"]["arguments"]
        for call in tool_calls(transport)
        if call["params"]["name"] == "append_session_event"
    ]
    assert len(append_calls) == 1
    assert append_calls[0]["channel_id"] == "channel-2"


def test_concurrent_writes_have_isolated_receipts_and_single_lane_start() -> None:
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), transport=transport
    )

    with ThreadPoolExecutor(max_workers=2) as executor:
        outputs = list(
            executor.map(runtime.capture_distilled, ["First event", "Second event"])
        )

    assert [output.receipt.status for output in outputs] == [
        ReceiptStatus.SAVED,
        ReceiptStatus.SAVED,
    ]
    assert [call["params"]["name"] for call in tool_calls(transport)].count(
        "session_start"
    ) == 1


def test_lane_creation_failure_does_not_attempt_unscoped_append() -> None:
    transport = LaneAwareTransport(fail_session_start=True)
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), transport=transport
    )

    output = runtime.capture_distilled("Distilled event")

    assert output.receipt.status is ReceiptStatus.LOST
    assert [call["params"]["name"] for call in tool_calls(transport)] == [
        "session_start"
    ]


def test_write_failure_is_spooled_only_when_requested_write_was_queued() -> None:
    spool = FakeSpool()
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        client=StartThenFailClient(),
        spool=spool,
    )

    output = runtime.checkpoint("Distilled checkpoint")

    assert output.receipt.status is ReceiptStatus.SPOOLED
    assert output.receipt.durable is True
    assert output.receipt.spool_key is not None
    assert "secret-value" not in (output.receipt.error or "")
    assert spool.calls[0][0] == "session_wrap"
    assert spool.calls[0][1]["session_key"] == "repo/session-4"


def test_failed_lane_start_queues_requested_write_with_replay_order() -> None:
    cases = (
        ("capture_distilled", "Distilled capture", "append_session_event"),
        ("checkpoint", "Distilled checkpoint", "session_wrap"),
        ("wrap", "Distilled wrap", "session_wrap"),
    )
    for method_name, content, expected_write in cases:
        spool = FakeSpool()
        runtime = FirstClassMemoryRuntime(
            runtime_config(),
            runtime_scope(),
            client=StartThenFailClient(fail_start=True),
            spool=spool,
        )

        output = getattr(runtime, method_name)(content)

        assert output.receipt.status is ReceiptStatus.SPOOLED
        assert output.receipt.durable is True
        assert [operation for operation, _payload, _key in spool.calls] == [
            "session_start",
            expected_write,
        ]
        assert output.receipt.spool_key == spool.calls[1][2]
        assert spool.calls[0][1]["session_key"] == "repo/session-4"
        assert spool.calls[1][1]["session_key"] == "repo/session-4"


def test_failed_lane_start_jsonl_spool_persists_ordered_replay_pair(
    tmp_path: Path,
) -> None:
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl")
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        client=StartThenFailClient(fail_start=True),
        spool=spool,
    )

    distilled = "  Distilled capture\n"
    output = runtime.capture_distilled(distilled)

    records = spool.records()
    assert output.receipt.status is ReceiptStatus.SPOOLED
    assert [record.operation for record in records] == [
        "session_start",
        "append_session_event",
    ]
    assert output.receipt.spool_key == records[1].idempotency_key
    assert records[1].payload["content"] == distilled


def test_failed_lane_start_batch_failure_leaves_no_orphaned_prerequisite() -> None:
    spool = FakeSpool(fail=True)
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        client=StartThenFailClient(fail_start=True),
        spool=spool,
    )

    output = runtime.capture_distilled("Distilled capture")

    assert output.receipt.status is ReceiptStatus.LOST
    assert output.receipt.durable is False
    assert spool.calls == []
    assert "spool unavailable" in (output.receipt.error or "")


def test_write_failure_reports_spool_failure_and_is_lost() -> None:
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        client=StartThenFailClient(),
        spool=FakeSpool(fail=True),
    )

    output = runtime.wrap("Distilled wrap")

    assert output.receipt.status is ReceiptStatus.LOST
    assert output.receipt.durable is False
    assert "spool unavailable" in (output.receipt.error or "")
    assert "secret-value" not in (output.receipt.error or "")


def test_recall_fails_open_with_safe_failed_receipt() -> None:
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        client=StartThenFailClient(),
    )

    output = runtime.recall_context("what changed?")

    assert output.context == {}
    assert output.receipt.status is ReceiptStatus.FAILED
    assert output.receipt.durable is False
    assert "secret-value" not in (output.receipt.error or "")


def test_authorized_recall_context_is_not_mutated_by_diagnostic_redaction() -> None:
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        client=ContextClient(),
    )

    output = runtime.recall_context("authorized context").as_dict()

    assert output["context"] == {"authorized_memory": "token=historical-value"}


def test_recall_latency_budget_clamps_local_direct_timeout_and_restores_it() -> None:
    client = ContextClient()
    runtime = FirstClassMemoryRuntime(runtime_config(), runtime_scope(), client=client)

    output = runtime.recall_context("bounded recall", max_latency_ms=250)

    assert output.receipt.status is ReceiptStatus.DIRECT
    assert client.observed_timeouts == [0.25]
    assert client.timeout == 30.0


def test_direct_write_results_require_created_or_duplicate_evidence() -> None:
    cases = (
        (
            "capture_distilled",
            WriteResultClient(append_result={}),
            "created or duplicate",
        ),
        (
            "checkpoint",
            WriteResultClient(wrap_result={"lane_id": "lane-1"}),
            "durable lane context update",
        ),
    )
    for operation, client, expected_error in cases:
        runtime = FirstClassMemoryRuntime(
            runtime_config(),
            runtime_scope(),
            client=client,
        )

        output = getattr(runtime, operation)("Distilled result validation")

        assert output.receipt.status is ReceiptStatus.LOST
        assert output.receipt.durable is False
        assert expected_error in (output.receipt.error or "")


def test_direct_write_results_accept_duplicate_evidence() -> None:
    append = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        client=WriteResultClient(append_result={"duplicate": True}),
    ).capture_distilled("Duplicate event")
    wrap = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        client=WriteResultClient(
            wrap_result={
                "duplicate": True,
                "lane_id": "lane-1",
                "context_updated": True,
            }
        ),
    ).checkpoint("Duplicate checkpoint")

    assert append.receipt.status is ReceiptStatus.SAVED
    assert wrap.receipt.status is ReceiptStatus.SAVED


def test_direct_success_does_not_invoke_fallback() -> None:
    runner = FakeRunner()
    runtime = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        runtime_scope(),
        transport=LaneAwareTransport(),
        fallback_runner=runner,
    )

    output = runtime.recall_context("direct path")

    assert output.receipt.status is ReceiptStatus.DIRECT
    assert output.receipt.fallback_attempted is False
    assert runner.calls == []


def test_wrap_metadata_scans_each_persisted_string_once() -> None:
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), transport=transport
    )

    with patch.object(
        runtime_module,
        "_reject_secret_payload",
        wraps=runtime_module._reject_secret_payload,
    ) as secret_scan:
        output = runtime.wrap(
            "Distilled summary",
            key_decisions=["Keep direct first"],
            next_steps=["Run validation"],
            receipt_refs=["receipt-1"],
        )

    assert output.receipt.status is ReceiptStatus.SAVED
    assert secret_scan.call_count == 4


def test_all_distilled_write_fields_fail_safely_before_persistence() -> None:
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), transport=transport
    )

    secret_capture = runtime.capture_distilled("token=super-secret-value")
    whitespace_only = runtime.capture_distilled(" \t\n")
    oversized_summary = runtime.checkpoint("x" * (MAX_DISTILLED_CONTENT_BYTES + 1))
    secret_auxiliary = runtime.wrap(
        "Distilled summary",
        next_steps=["password=super-secret-value"],
    )
    oversized_list = runtime.checkpoint(
        "Distilled summary",
        key_decisions=["x" * 9000, "y" * 9000],
    )

    for output in (
        secret_capture,
        whitespace_only,
        oversized_summary,
        secret_auxiliary,
        oversized_list,
    ):
        assert output.receipt.status is ReceiptStatus.FAILED
    assert tool_calls(transport) == []


def test_json_adapter_requires_distilled_for_every_write() -> None:
    for operation, field in (
        ("capture", {"content": "distilled event"}),
        ("checkpoint", {"summary": "distilled checkpoint"}),
        ("wrap", {"summary": "distilled wrap"}),
    ):
        output = execute_json(
            request_payload(operation, **field),
            transport=LaneAwareTransport(),
        )
        assert output["receipt"]["status"] == "failed"
        assert output["receipt"]["direct_attempted"] is False


def test_json_adapter_rejects_metadata_scope_and_config_overrides() -> None:
    payloads = [
        request_payload(
            "capture",
            distilled=True,
            content="distilled event",
            metadata={"namespace": "other"},
        ),
        request_payload("capture", distilled=True, content="event"),
        request_payload("capture", distilled=True, content="event"),
    ]
    payloads[1]["scope"]["namespace"] = "other"
    payloads[2]["config"]["fallback_command"] = ["other-command"]

    for payload in payloads:
        output = execute_json(payload, transport=LaneAwareTransport())
        assert output["receipt"]["status"] == "failed"
        assert output["receipt"]["direct_attempted"] is False


def test_execute_json_closes_package_owned_mcp_session() -> None:
    transport = LaneAwareTransport()

    output = execute_json(
        request_payload("recall", query="current task"),
        transport=transport,
    )

    assert output["receipt"]["status"] == "direct"
    assert transport.delete_calls == 1


def test_execute_json_does_not_close_caller_injected_client() -> None:
    client = ContextClient()

    output = execute_json(
        request_payload("recall", query="current task"),
        client=client,
    )

    assert output["receipt"]["status"] == "direct"
    assert client.closed is False


def test_json_input_and_output_are_bounded() -> None:
    assert parse_json_input(b'{"operation":"recall"}') == {"operation": "recall"}

    try:
        parse_json_input(b"x" * (MAX_JSON_INPUT_BYTES + 1))
    except ValueError as error:
        assert "exceeds" in str(error)
    else:
        raise AssertionError("oversized input was accepted")

    encoded = encode_json_output({"context": "x" * 1_000_001})
    decoded = json.loads(encoded)
    assert decoded["receipt"]["status"] == "failed"
    assert "context" not in decoded


def test_main_returns_nonzero_when_output_bound_replaces_success() -> None:
    stdout_buffer = io.BytesIO()
    oversized_output = {
        "receipt": {"status": ReceiptStatus.DIRECT},
        "context": "x" * 1_000_001,
    }

    with (
        patch.object(main_module, "execute_json", return_value=oversized_output),
        patch.object(
            main_module.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(b"{}"))
        ),
        patch.object(main_module.sys, "stdout", SimpleNamespace(buffer=stdout_buffer)),
    ):
        exit_code = main_module.main([])

    assert exit_code == 1
    emitted = json.loads(stdout_buffer.getvalue())
    assert emitted["receipt"]["status"] == "failed"
    assert emitted["receipt"]["operation"] == "output"


def test_module_entry_point_emits_json_for_malformed_input() -> None:
    completed = subprocess.run(
        [sys.executable, "-m", "openbrain_memory"],
        input="not-json",
        text=True,
        capture_output=True,
        check=False,
        cwd=Path(__file__).resolve().parents[1],
    )

    assert completed.returncode == 2
    assert completed.stderr == ""
    output = json.loads(completed.stdout)
    assert output["receipt"]["status"] == "failed"
    assert output["receipt"]["operation"] == "input"


def test_module_entry_point_returns_nonzero_for_lost_write() -> None:
    payload = request_payload(
        "capture",
        distilled=True,
        content="distilled event",
    )
    payload["config"]["base_url"] = "http://127.0.0.1:1"

    completed = subprocess.run(
        [sys.executable, "-m", "openbrain_memory"],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
        cwd=Path(__file__).resolve().parents[1],
    )

    assert completed.returncode != 0
    assert completed.stderr == ""
    output = json.loads(completed.stdout)
    assert output["receipt"]["status"] == "lost"
    assert output["receipt"]["durable"] is False
