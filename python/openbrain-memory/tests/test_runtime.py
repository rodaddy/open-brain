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

import pytest

import openbrain_memory.__main__ as main_module
import openbrain_memory.runtime as runtime_module
from openbrain_memory import (
    FirstClassMemoryRuntime,
    JsonlSpool,
    ReceiptStatus,
    RuntimeConfig,
    RuntimeScope,
)
from openbrain_memory._runtime_spool import PARKED_NAMESPACE_KEY
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
    ForeignLaneTamperingTransport,
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
    assert [call["params"]["name"] for call in calls] == [
        "get_contract",
        "agent_context_pack",
    ]
    assert calls[1]["params"] == {
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
        "get_contract",
        "session_start",
        "get_contract",
        "append_session_event",
    ]
    start = calls[1]["params"]["arguments"]
    assert start == {
        "session_key": "repo/session-4",
        "agent": "bilby",
        "project": "open-brain",
        "platform": "discord",
        "server_id": "guild-1",
        "channel_id": "channel-2",
        "thread_id": "thread-3",
    }
    event = calls[3]["params"]["arguments"]
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
        "get_contract",
        "session_start",
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


def test_successful_direct_write_drains_spooled_unit_in_order(tmp_path: Path) -> None:
    transport = LaneAwareTransport(fail_session_start=True)
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl")
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        transport=transport,
        spool=spool,
    )

    queued = runtime.capture_distilled("Queued capture")
    transport.fail_session_start = False
    saved = runtime.capture_distilled("Recovery trigger")

    calls = [
        call["params"]
        for call in tool_calls(transport)
        if call["params"]["name"] != "get_contract"
    ]
    assert queued.receipt.status is ReceiptStatus.SPOOLED
    assert saved.receipt.status is ReceiptStatus.SAVED
    assert [call["name"] for call in calls[-2:]] == [
        "session_start",
        "append_session_event",
    ]
    assert calls[-1]["arguments"]["content"] == "Queued capture"
    assert spool.status().pending_count == 0
    assert spool.path.read_text(encoding="utf-8") == ""


def test_successful_direct_recall_drains_spooled_unit_in_order(tmp_path: Path) -> None:
    transport = LaneAwareTransport(fail_session_start=True)
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl")
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        transport=transport,
        spool=spool,
    )

    queued = runtime.capture_distilled("Queued before recall")
    transport.fail_session_start = False
    recalled = runtime.recall_context("Connectivity restored")

    calls = [
        call["params"]
        for call in tool_calls(transport)
        if call["params"]["name"] != "get_contract"
    ]
    assert queued.receipt.status is ReceiptStatus.SPOOLED
    assert recalled.receipt.status is ReceiptStatus.DIRECT
    assert [call["name"] for call in calls[-2:]] == [
        "session_start",
        "append_session_event",
    ]
    assert calls[-1]["arguments"]["content"] == "Queued before recall"
    assert spool.status().pending_count == 0


def test_spool_drain_retains_unknown_operation_and_replays_valid_unit(
    tmp_path: Path,
) -> None:
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl")
    spool.append("unknown_operation", {"value": "must stay"}, key="unknown-key")
    spool.append(
        "session_start",
        {
            **runtime_scope().start_metadata(),
            "session_key": runtime_scope().session_key,
            "agent": runtime_scope().agent,
        },
        key="valid-key",
    )
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        transport=transport,
        spool=spool,
    )

    recalled = runtime.recall_context("Drain valid records")

    dispatched = [call["params"]["name"] for call in tool_calls(transport)]
    assert recalled.receipt.status is ReceiptStatus.DIRECT
    assert "unknown_operation" not in dispatched
    assert dispatched[-1] == "session_start"
    remaining = spool.records()
    assert [record.idempotency_key for record in remaining] == ["unknown-key"]


def test_spool_drain_dispatches_every_allowlisted_operation(tmp_path: Path) -> None:
    scope = runtime_scope()
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl")
    records = [
        (
            "session_start",
            {
                **scope.start_metadata(),
                "session_key": scope.session_key,
                "agent": scope.agent,
            },
        ),
        ("lane_upsert", {"session_key": scope.session_key}),
        ("upsert_repo_fact", {"metadata": {"fact": "queued"}}),
        (
            "append_session_event",
            {
                **scope.start_metadata(),
                "session_key": scope.session_key,
                "agent": scope.agent,
                "content": "Queued event",
                "event_type": "fact",
                "source": scope.agent,
                "metadata": {"idempotency_key": "allowed-append"},
            },
        ),
        ("log_thought", {"content": "Queued thought"}),
        ("log_decision", {"content": "Queued decision"}),
        (
            "session_wrap",
            {
                **scope.start_metadata(),
                "session_key": scope.session_key,
                "agent": scope.agent,
                "summary": "Queued wrap",
            },
        ),
    ]
    for index, (operation, payload) in enumerate(records):
        spool.append(operation, payload, key=f"allowed-{index}")
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        scope,
        transport=transport,
        spool=spool,
    )

    recalled = runtime.recall_context("Drain allowlisted records")

    dispatched = [
        call["params"]["name"]
        for call in tool_calls(transport)
        if call["params"]["name"] != "get_contract"
    ]
    assert recalled.receipt.status is ReceiptStatus.DIRECT
    assert dispatched[1:] == [operation for operation, _payload in records]
    assert spool.status().pending_count == 0


def _parked_unit_scope() -> RuntimeScope:
    return RuntimeScope(
        agent="bilby",
        platform="discord",
        server_id="guild-9",
        channel_id="channel-parked",
        session_key="other-repo/session-9",
    )


def _park_unit(spool: JsonlSpool, scope: RuntimeScope, content: str) -> None:
    spool.append_batch(
        [
            (
                "session_start",
                {
                    **scope.start_metadata(),
                    "session_key": scope.session_key,
                    "agent": scope.agent,
                },
                None,
            ),
            (
                "append_session_event",
                {
                    **scope.start_metadata(),
                    "session_key": scope.session_key,
                    "agent": scope.agent,
                    "content": content,
                    "event_type": "fact",
                    "source": scope.agent,
                    "metadata": {"idempotency_key": f"parked-{content}"},
                },
                None,
            ),
        ]
    )


def test_spool_drain_replays_unit_parked_under_another_scope(tmp_path: Path) -> None:
    parked = _parked_unit_scope()
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl")
    _park_unit(spool, parked, "Parked in another project")
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        transport=transport,
        spool=spool,
    )

    saved = runtime.capture_distilled("Recovery trigger in current project")

    assert saved.receipt.status is ReceiptStatus.SAVED
    assert spool.status().pending_count == 0
    started = [
        call["params"]["arguments"]
        for call in tool_calls(transport)
        if call["params"]["name"] == "session_start"
    ]
    assert any(
        arguments["session_key"] == parked.session_key
        and arguments["channel_id"] == parked.channel_id
        for arguments in started
    )
    appended = [
        call["params"]["arguments"]
        for call in tool_calls(transport)
        if call["params"]["name"] == "append_session_event"
    ]
    assert any(
        arguments["content"] == "Parked in another project"
        and arguments["channel_id"] == parked.channel_id
        for arguments in appended
    )


def test_spool_drain_rejects_tampered_lane_echo_for_parked_scope(
    tmp_path: Path,
) -> None:
    parked = _parked_unit_scope()
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl")
    _park_unit(spool, parked, "Must stay parked")
    transport = ForeignLaneTamperingTransport(parked.session_key)
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        transport=transport,
        spool=spool,
    )

    saved = runtime.capture_distilled("Healthy current-scope write")

    assert saved.receipt.status is ReceiptStatus.SAVED
    # The replayed lane echo failed the parked unit's exact-scope proof, so the
    # unit stays parked and its write never dispatched.
    assert [record.operation for record in spool.records()] == [
        "session_start",
        "append_session_event",
    ]
    appended = [
        call["params"]["arguments"]
        for call in tool_calls(transport)
        if call["params"]["name"] == "append_session_event"
    ]
    assert all(
        arguments["content"] != "Must stay parked" for arguments in appended
    )


def test_spool_drain_retains_start_record_missing_scope_coordinates(
    tmp_path: Path,
) -> None:
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl")
    spool.append(
        "session_start",
        {"session_key": "other-repo/session-9", "agent": "bilby"},
        key="incomplete-start",
    )
    scope = runtime_scope()
    spool.append(
        "session_start",
        {
            **scope.start_metadata(),
            "session_key": scope.session_key,
            "agent": scope.agent,
        },
        key="valid-start",
    )
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        scope,
        transport=transport,
        spool=spool,
    )

    recalled = runtime.recall_context("Drain what can be proven")

    assert recalled.receipt.status is ReceiptStatus.DIRECT
    # The incomplete record cannot prove a parked scope: retained, and never
    # dispatched as a wasted live session_start.
    assert [record.idempotency_key for record in spool.records()] == [
        "incomplete-start"
    ]
    started_keys = [
        call["params"]["arguments"].get("session_key")
        for call in tool_calls(transport)
        if call["params"]["name"] == "session_start"
    ]
    assert "other-repo/session-9" not in started_keys


def test_live_write_after_foreign_unit_drain_validates_against_own_scope(
    tmp_path: Path,
) -> None:
    parked = _parked_unit_scope()
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl")
    _park_unit(spool, parked, "Parked in another project")
    transport = LaneAwareTransport()
    scope = runtime_scope()
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        scope,
        transport=transport,
        spool=spool,
    )

    recalled = runtime.recall_context("Drains the foreign unit")
    saved = runtime.capture_distilled("Live write after the drain")

    # A stale replay scope leaking past the drain would make this live
    # session_start validate against the parked scope and fail.
    assert recalled.receipt.status is ReceiptStatus.DIRECT
    assert saved.receipt.status is ReceiptStatus.SAVED
    assert spool.status().pending_count == 0
    started = [
        call["params"]["arguments"]
        for call in tool_calls(transport)
        if call["params"]["name"] == "session_start"
    ]
    assert started[-1]["session_key"] == scope.session_key
    assert started[-1]["channel_id"] == scope.channel_id


def test_spool_drain_retains_unit_parked_under_another_namespace(
    tmp_path: Path,
) -> None:
    parked = _parked_unit_scope()
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl")
    spool.append_batch(
        [
            (
                "session_start",
                {
                    **parked.start_metadata(),
                    "session_key": parked.session_key,
                    "agent": parked.agent,
                    PARKED_NAMESPACE_KEY: "other-namespace",
                },
                None,
            ),
            (
                "append_session_event",
                {
                    **parked.start_metadata(),
                    "session_key": parked.session_key,
                    "agent": parked.agent,
                    "content": "Parked by another namespace",
                    "event_type": "fact",
                    "source": parked.agent,
                    "metadata": {"idempotency_key": "parked-other-namespace"},
                },
                None,
            ),
        ]
    )
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        transport=transport,
        spool=spool,
    )

    saved = runtime.capture_distilled("Healthy current-scope write")

    assert saved.receipt.status is ReceiptStatus.SAVED
    # The unit was parked by a runtime bound to another namespace: retained,
    # with no live dispatch for any of its records.
    assert [record.operation for record in spool.records()] == [
        "session_start",
        "append_session_event",
    ]
    dispatched_keys = [
        call["params"]["arguments"].get("session_key")
        for call in tool_calls(transport)
        if call["params"]["name"] != "get_contract"
    ]
    assert parked.session_key not in dispatched_keys


def test_runtime_parked_start_record_carries_parking_namespace(
    tmp_path: Path,
) -> None:
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl")
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        client=StartThenFailClient(fail_start=True),
        spool=spool,
    )

    queued = runtime.capture_distilled("Parked by this runtime")

    assert queued.receipt.status is ReceiptStatus.SPOOLED
    records = spool.records()
    assert records[0].operation == "session_start"
    assert records[0].payload[PARKED_NAMESPACE_KEY] == "bilby"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("agent", "hijacked-agent"),
        ("source", "hijacked-source"),
        ("thread_id", "hijacked-thread"),
        ("namespace", "hijacked-namespace"),
        ("metadata.server_id", "hijacked-guild"),
    ],
)
def test_spool_drain_rejects_any_tampered_lane_field_for_parked_scope(
    tmp_path: Path,
    field: str,
    value: str,
) -> None:
    parked = _parked_unit_scope()
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl")
    _park_unit(spool, parked, "Must stay parked")
    transport = ForeignLaneTamperingTransport(
        parked.session_key, field=field, value=value
    )
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        transport=transport,
        spool=spool,
    )

    saved = runtime.capture_distilled("Healthy current-scope write")

    assert saved.receipt.status is ReceiptStatus.SAVED
    assert [record.operation for record in spool.records()] == [
        "session_start",
        "append_session_event",
    ]
    appended = [
        call["params"]["arguments"]
        for call in tool_calls(transport)
        if call["params"]["name"] == "append_session_event"
    ]
    assert all(
        arguments["content"] != "Must stay parked" for arguments in appended
    )


def test_flapping_provider_auto_drain_reports_replayed_receipts(
    tmp_path: Path,
) -> None:
    transport = LaneAwareTransport(fail_session_start=True)
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl")
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        transport=transport,
        spool=spool,
    )

    queued = runtime.capture_distilled("Queued while flapping")
    transport.fail_session_start = False
    saved = runtime.capture_distilled("Recovery trigger")

    assert queued.receipt.status is ReceiptStatus.SPOOLED
    assert queued.drain is None
    assert saved.receipt.status is ReceiptStatus.SAVED
    assert saved.drain is not None
    assert saved.drain is runtime.last_drain_report
    assert saved.drain.attempted_units == 1
    assert saved.drain.replayed_units == 1
    assert saved.drain.replayed_records == 2
    assert saved.drain.failed_units == 0
    assert saved.drain.quarantined_units == 0
    assert saved.drain.retained_foreign_units == 0
    statuses = [receipt.status for receipt in saved.drain.receipts]
    assert statuses == [ReceiptStatus.REPLAYED, ReceiptStatus.REPLAYED]
    assert [receipt.operation for receipt in saved.drain.receipts] == [
        "session_start",
        "append_session_event",
    ]
    for receipt in saved.drain.receipts:
        assert receipt.durable is True
        assert receipt.spool_key is not None
        assert receipt.error is None
    assert spool.status().pending_count == 0
    assert spool.status().last_success_at is not None
    rendered = saved.as_dict()
    assert rendered["drain"]["replayed_records"] == 2
    assert all(
        entry["status"] == "replayed" for entry in rendered["drain"]["receipts"]
    )


def test_drain_quarantines_poison_unit_and_skips_it_afterward(
    tmp_path: Path,
) -> None:
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl", quarantine_threshold=2)
    spool.append("unknown_operation", {"value": "poison"}, key="poison-key")
    scope = runtime_scope()
    spool.append(
        "session_start",
        {
            **scope.start_metadata(),
            "session_key": scope.session_key,
            "agent": scope.agent,
        },
        key="valid-key",
    )
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        scope,
        transport=transport,
        spool=spool,
    )

    first = runtime.recall_context("First healthy drain")

    assert first.receipt.status is ReceiptStatus.DIRECT
    assert first.drain is not None
    # Poison never blocks the valid unit.
    assert first.drain.replayed_units == 1
    assert first.drain.failed_units == 1
    assert first.drain.quarantined_units == 0
    assert [record.idempotency_key for record in spool.records()] == [
        "poison-key"
    ]
    assert spool.status().retry_counts == {"poison-key": 1}

    second = runtime.recall_context("Second healthy drain")

    assert second.drain is not None
    assert second.drain.quarantined_units == 1
    quarantined = [
        receipt
        for receipt in second.drain.receipts
        if receipt.status is ReceiptStatus.QUARANTINED
    ]
    assert len(quarantined) == 1
    assert quarantined[0].operation == "unknown_operation"
    assert quarantined[0].spool_key == "poison-key"
    assert quarantined[0].durable is True
    assert quarantined[0].error == "ValueError"
    assert spool.records() == []
    status = spool.status()
    assert status.quarantined_count == 1
    assert status.retry_counts == {}

    third = runtime.recall_context("Third healthy drain")

    # The quarantined unit is gone from the spool: nothing left to drain,
    # so the dispatcher is never called for it again.
    assert third.drain is None
    assert spool.status().quarantined_count == 1


def test_foreign_parked_unit_never_accrues_retries_or_quarantines(
    tmp_path: Path,
) -> None:
    parked = _parked_unit_scope()
    # Threshold 1 would quarantine on the first counted failure: proves the
    # retained path counts nothing.
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl", quarantine_threshold=1)
    spool.append_batch(
        [
            (
                "session_start",
                {
                    **parked.start_metadata(),
                    "session_key": parked.session_key,
                    "agent": parked.agent,
                    PARKED_NAMESPACE_KEY: "other-namespace",
                },
                None,
            ),
            (
                "append_session_event",
                {
                    **parked.start_metadata(),
                    "session_key": parked.session_key,
                    "agent": parked.agent,
                    "content": "Parked by another namespace",
                    "event_type": "fact",
                    "source": parked.agent,
                    "metadata": {"idempotency_key": "parked-other-namespace"},
                },
                None,
            ),
        ]
    )
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        transport=transport,
        spool=spool,
    )

    for attempt in range(3):
        saved = runtime.capture_distilled(f"Healthy write {attempt}")
        assert saved.receipt.status is ReceiptStatus.SAVED
        assert saved.drain is not None
        assert saved.drain.retained_foreign_units == 1
        assert saved.drain.quarantined_units == 0
        assert saved.drain.failed_units == 0

    assert [record.operation for record in spool.records()] == [
        "session_start",
        "append_session_event",
    ]
    status = spool.status()
    assert status.retry_counts == {}
    assert status.quarantined_count == 0
    dispatched_keys = [
        call["params"]["arguments"].get("session_key")
        for call in tool_calls(transport)
        if call["params"]["name"] != "get_contract"
    ]
    assert parked.session_key not in dispatched_keys


def test_spool_replay_failure_keeps_unit_without_changing_outer_receipt(
    tmp_path: Path,
) -> None:
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl")
    spool.append(
        "append_session_event",
        {
            **runtime_scope().start_metadata(),
            "session_key": runtime_scope().session_key,
            "agent": runtime_scope().agent,
            "content": "Queued event",
            "event_type": "fact",
            "source": runtime_scope().agent,
            "metadata": {"idempotency_key": "failed-key"},
        },
        key="failed-key",
    )
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        transport=LaneAwareTransport(),
        spool=spool,
    )

    recalled = runtime.recall_context("Outer operation succeeds")

    assert recalled.receipt.status is ReceiptStatus.DIRECT
    assert [record.idempotency_key for record in spool.records()] == ["failed-key"]


def test_corrupt_spool_never_raises_out_of_capture_or_recall(tmp_path: Path) -> None:
    spool = JsonlSpool(tmp_path / "runtime-spool.jsonl")
    spool.path.write_bytes(b"\xff\xfe")
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        transport=LaneAwareTransport(),
        spool=spool,
    )

    saved = runtime.capture_distilled("Direct write survives corrupt spool")
    recalled = runtime.recall_context("Direct recall survives corrupt spool")

    assert saved.receipt.status is ReceiptStatus.SAVED
    assert recalled.receipt.status is ReceiptStatus.DIRECT


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

    expected = ContextClient().agent_context_pack(
        **runtime_scope().context_pack_arguments("authorized context")
    )
    assert output["context"] == expected


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
