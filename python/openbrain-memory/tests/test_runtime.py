"""Tests for the first-class local Open Brain runtime facade."""

from __future__ import annotations

import json
import subprocess
import sys
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from unittest.mock import patch

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
from openbrain_memory.client import TransportResponse

MAX_DISTILLED_CONTENT_BYTES = 16 * 1024


class LaneAwareTransport:
    """Fake MCP boundary that rejects writes before session_start."""

    def __init__(self, *, fail_session_start: bool = False) -> None:
        self.fail_session_start = fail_session_start
        self.requests: list[dict[str, Any]] = []
        self.started_sessions: dict[str, dict[str, Any]] = {}
        self.delete_calls = 0

    def get(self, url: str, *, headers: Mapping[str, str], timeout: float) -> Any:
        raise AssertionError("GET not expected")

    def delete(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> TransportResponse:
        self.delete_calls += 1
        return TransportResponse(status_code=200, headers={}, text="")

    def post(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        json_body: Mapping[str, Any],
        timeout: float,
    ) -> TransportResponse:
        self.requests.append(
            {
                "url": url,
                "headers": dict(headers),
                "json": dict(json_body),
                "timeout": timeout,
            }
        )
        method = json_body.get("method")
        if method == "initialize":
            return TransportResponse(
                status_code=200,
                headers={
                    "content-type": "application/json",
                    "mcp-session-id": "runtime-session",
                },
                text=json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": json_body["id"],
                        "result": {"protocolVersion": "2025-03-26"},
                    }
                ),
            )
        if method == "notifications/initialized":
            return TransportResponse(status_code=202, headers={}, text="")
        if method != "tools/call":
            raise AssertionError(f"unexpected method: {method}")

        params = json_body["params"]
        tool = params["name"]
        arguments = params["arguments"]
        if tool == "session_start":
            if self.fail_session_start:
                return self._tool_error(json_body["id"], "lane creation failed")
            self.started_sessions.setdefault(
                arguments["session_key"],
                {
                    key: arguments.get(key)
                    for key in ("agent", "channel_id", "thread_id", "project")
                },
            )
        elif tool in {"append_session_event", "session_wrap"}:
            session_key = arguments.get("session_key")
            lane = self.started_sessions.get(session_key)
            if lane is None:
                return self._tool_error(json_body["id"], "session lane does not exist")
            if tool == "append_session_event":
                for key in ("agent", "channel_id", "thread_id", "project"):
                    if lane.get(key) != arguments.get(key):
                        return self._tool_error(
                            json_body["id"],
                            "existing lane scope does not match requested append scope",
                        )
                lane["platform"] = arguments.get("platform")
                lane["server_id"] = arguments.get("server_id")
        body = {
            "tool": tool,
            "arguments": arguments,
            "sections": {"working_set": {"items": []}},
        }
        return self._tool_result(json_body["id"], body)

    @staticmethod
    def _tool_result(request_id: int, body: Mapping[str, Any]) -> TransportResponse:
        return TransportResponse(
            status_code=200,
            headers={"content-type": "application/json"},
            text=json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {"content": [{"type": "text", "text": json.dumps(body)}]},
                }
            ),
        )

    @staticmethod
    def _tool_error(request_id: int, message: str) -> TransportResponse:
        return TransportResponse(
            status_code=200,
            headers={"content-type": "application/json"},
            text=json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "isError": True,
                        "content": [{"type": "text", "text": message}],
                    },
                }
            ),
        )


class StartThenFailClient:
    def __init__(self, *, fail_start: bool = False) -> None:
        self.fail_start = fail_start
        self.timeout = 30.0
        self.started = False
        self.closed = False

    def session_start(self, **arguments: Any) -> dict[str, Any]:
        if self.fail_start:
            raise ConnectionError("session start failed with token=secret-value")
        self.started = True
        return {"started": True}

    def append_session_event(self, **arguments: Any) -> dict[str, Any]:
        if not self.started:
            raise RuntimeError("lane missing")
        raise ConnectionError("append failed with token=secret-value")

    def session_wrap(self, **arguments: Any) -> dict[str, Any]:
        if not self.started:
            raise RuntimeError("lane missing")
        raise ConnectionError("wrap failed with token=secret-value")

    def agent_context_pack(self, **arguments: Any) -> dict[str, Any]:
        raise ConnectionError("recall failed with token=secret-value")

    def close(self) -> None:
        self.closed = True


class ContextClient(StartThenFailClient):
    def __init__(self) -> None:
        super().__init__()
        self.observed_timeouts: list[float] = []

    def agent_context_pack(self, **arguments: Any) -> dict[str, Any]:
        self.observed_timeouts.append(self.timeout)
        return {"authorized_memory": "token=historical-value"}


class FakeSpool:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[tuple[str, dict[str, Any], str | None]] = []

    def append(
        self,
        operation: str,
        payload: Mapping[str, Any],
        *,
        key: str | None = None,
    ) -> str:
        if self.fail:
            raise OSError("spool unavailable")
        self.calls.append((operation, dict(payload), key))
        return key or "spool-key"

    def append_batch(
        self,
        records: Sequence[tuple[str, Mapping[str, Any], str | None]],
    ) -> list[str]:
        if self.fail:
            raise OSError("spool unavailable")
        keys = []
        for operation, payload, key in records:
            self.calls.append((operation, dict(payload), key))
            keys.append(key or f"spool-key-{len(keys)}")
        return keys


@dataclass(frozen=True)
class RunnerResult:
    returncode: int = 0
    stdout: str = ""
    stderr: str = ""


class FakeRunner:
    def __init__(self, result: RunnerResult | None = None) -> None:
        self.result = result
        self.calls: list[tuple[tuple[str, ...], float]] = []

    def __call__(
        self,
        argv: Sequence[str],
        *,
        timeout: float,
    ) -> RunnerResult:
        call = tuple(argv)
        self.calls.append((call, timeout))
        if self.result is not None:
            return self.result
        return RunnerResult(stdout=json.dumps(self._response(call[2])))

    @staticmethod
    def _response(tool: str) -> dict[str, Any]:
        scope = {
            "namespace": "bilby",
            "session_key": "repo/session-4",
            "agent": "bilby",
            "platform": "discord",
            "server_id": "guild-1",
            "channel_id": "channel-2",
            "thread_id": "thread-3",
        }
        if tool == "session_start":
            lane = {
                key: scope[key]
                for key in (
                    "namespace",
                    "session_key",
                    "agent",
                )
            }
            return {"success": True, "result": {"lane": lane, "is_new": True}}
        if tool == "agent_context_pack":
            return {
                "success": True,
                "result": {
                    "schema": "openbrain.agent_context_pack.v1",
                    "status": "ok",
                    "scope": scope,
                    "sections": {},
                },
            }
        if tool == "append_session_event":
            return {
                "success": True,
                "result": {"event_id": "event-1", "lane_id": "lane-1"},
            }
        if tool == "session_wrap":
            return {
                "success": True,
                "result": {"session_id": "lane-1", "lane_id": "lane-1"},
            }
        raise AssertionError(f"unexpected fallback tool: {tool}")


def runtime_config(**overrides: Any) -> RuntimeConfig:
    values: dict[str, Any] = {
        "base_url": "https://brain.example",
        "token": "unit-test-token",
        "namespace": "bilby",
    }
    values.update(overrides)
    return RuntimeConfig(**values)


def runtime_scope() -> RuntimeScope:
    return RuntimeScope(
        agent="bilby",
        platform="discord",
        server_id="guild-1",
        channel_id="channel-2",
        thread_id="thread-3",
        session_key="repo/session-4",
    )


def tool_calls(transport: LaneAwareTransport) -> list[dict[str, Any]]:
    return [
        request["json"]
        for request in transport.requests
        if request["json"].get("method") == "tools/call"
    ]


def request_payload(operation: str, **values: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "operation": operation,
        "scope": {
            "agent": "bilby",
            "platform": "discord",
            "server_id": "guild",
            "channel_id": "channel",
            "session_key": "session",
        },
        "config": {
            "base_url": "https://brain.example",
            "token": "unit-test-token",
            "namespace": "bilby",
        },
    }
    payload.update(values)
    return payload


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
    assert append_calls[-1]["channel_id"] == "other-channel"


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

    output = runtime.capture_distilled("Distilled capture")

    records = spool.records()
    assert output.receipt.status is ReceiptStatus.SPOOLED
    assert [record.operation for record in records] == [
        "session_start",
        "append_session_event",
    ]
    assert output.receipt.spool_key == records[1].idempotency_key


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


def test_recall_fallback_unwraps_live_result_scope_and_clamps_timeout() -> None:
    runner = FakeRunner()
    runtime = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        runtime_scope(),
        client=StartThenFailClient(),
        fallback_runner=runner,
    )

    output = runtime.recall_context("bounded fallback", max_latency_ms=250)

    assert output.receipt.status is ReceiptStatus.FALLBACK
    assert output.context == {
        "schema": "openbrain.agent_context_pack.v1",
        "status": "ok",
        "scope": {
            "namespace": "bilby",
            "session_key": "repo/session-4",
            "agent": "bilby",
            "platform": "discord",
            "server_id": "guild-1",
            "channel_id": "channel-2",
            "thread_id": "thread-3",
        },
        "sections": {},
    }
    assert runner.calls[0][1] == 0.25


def test_fallback_capture_accepts_live_lane_shape_without_channel_thread() -> None:
    runner = FakeRunner()
    runtime = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        runtime_scope(),
        client=StartThenFailClient(fail_start=True),
        fallback_runner=runner,
    )

    output = runtime.capture_distilled("Distilled fallback event")

    assert output.receipt.status is ReceiptStatus.FALLBACK
    assert output.receipt.direct_attempted is True
    assert output.receipt.fallback_attempted is True
    assert output.result == {"event_id": "event-1", "lane_id": "lane-1"}
    assert len(runner.calls) == 2
    tools = []
    for (argv, timeout), expected_tool in zip(
        runner.calls,
        ("session_start", "append_session_event"),
        strict=True,
    ):
        assert argv[:4] == ("mcp2cli", "open-brain", expected_tool, "--params")
        assert len(argv) == 5
        assert isinstance(json.loads(argv[4]), dict)
        assert timeout == 30.0
        tools.append(expected_tool)
    assert tools == ["session_start", "append_session_event"]
    assert json.loads(runner.calls[1][0][4])["content"] == "Distilled fallback event"


def test_mcp2cli_wrapper_supports_checkpoint_and_wrap_after_verified_lane() -> None:
    for operation in ("checkpoint", "wrap"):
        runner = FakeRunner()
        runtime = FirstClassMemoryRuntime(
            runtime_config(fallback_enabled=True),
            runtime_scope(),
            client=StartThenFailClient(fail_start=True),
            fallback_runner=runner,
        )

        output = getattr(runtime, operation)(f"Distilled {operation}")

        assert output.receipt.status is ReceiptStatus.FALLBACK
        assert output.result == {"session_id": "lane-1", "lane_id": "lane-1"}
        assert [call[0][2] for call in runner.calls] == [
            "session_start",
            "session_wrap",
        ]


def test_fallback_write_requires_fallback_verified_lane() -> None:
    runner = FakeRunner()
    runtime = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        runtime_scope(),
        client=StartThenFailClient(),
        fallback_runner=runner,
    )

    output = runtime.capture_distilled("Direct lane then fallback append")

    assert output.receipt.status is ReceiptStatus.LOST
    assert output.receipt.durable is False
    assert [call[0][2] for call in runner.calls] == ["append_session_event"]
    assert "lacked a verified fallback lane" in (output.receipt.error or "")


def test_fallback_without_scope_proof_cannot_claim_durable_success() -> None:
    runner = FakeRunner(
        RunnerResult(stdout='{"success":true,"result":{"is_new":true}}')
    )
    runtime = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        runtime_scope(),
        client=StartThenFailClient(fail_start=True),
        fallback_runner=runner,
    )

    output = runtime.capture_distilled("Distilled fallback event")

    assert output.receipt.status is ReceiptStatus.LOST
    assert output.receipt.durable is False
    assert "session_start result missing lane object" in (output.receipt.error or "")


def test_fallback_rejects_unsuccessful_or_missing_result_envelopes() -> None:
    cases = (
        ('{"success":false,"error":"denied"}', "success=true"),
        ('{"success":true}', "missing result object"),
    )
    for stdout, expected_error in cases:
        runner = FakeRunner(RunnerResult(stdout=stdout))
        runtime = FirstClassMemoryRuntime(
            runtime_config(fallback_enabled=True),
            runtime_scope(),
            client=StartThenFailClient(),
            fallback_runner=runner,
        )

        output = runtime.recall_context("fallback envelope")

        assert output.receipt.status is ReceiptStatus.FAILED
        assert expected_error in (output.receipt.error or "")


def test_fallback_rejects_oversized_captured_output() -> None:
    runner = FakeRunner(RunnerResult(stdout="x" * 1_000_001))
    runtime = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        runtime_scope(),
        client=StartThenFailClient(),
        fallback_runner=runner,
    )

    output = runtime.recall_context("oversized fallback")

    assert output.receipt.status is ReceiptStatus.FAILED
    assert "response limit" in (output.receipt.error or "")


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
