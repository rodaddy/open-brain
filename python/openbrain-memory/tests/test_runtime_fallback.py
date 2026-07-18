"""Tests for runtime fallback routing and subprocess behavior."""

from __future__ import annotations

import json
import sys
import time

import pytest

import openbrain_memory._runtime_router as router_module
from openbrain_memory import FirstClassMemoryRuntime, ReceiptStatus, RuntimeScope

from ._runtime_fakes import (
    FakeRunner,
    RunnerResult,
    StartThenFailClient,
    ToolResultRunner,
    WriteResultRunner,
    runtime_config,
    runtime_scope,
)


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

    distilled = "  Distilled fallback event\n"
    output = runtime.capture_distilled(distilled)

    assert output.receipt.status is ReceiptStatus.FALLBACK
    assert output.receipt.direct_attempted is True
    assert output.receipt.fallback_attempted is True
    assert output.result == {
        "event_id": "event-1",
        "lane_id": "lane-1",
        "lane_created": False,
    }
    assert len(runner.calls) == 4
    tools = []
    expected_tools = (
        "get_contract",
        "session_start",
        "get_contract",
        "append_session_event",
    )
    for (argv, timeout), expected_tool in zip(
        runner.calls,
        expected_tools,
        strict=True,
    ):
        assert argv[:4] == ("mcp2cli", "open-brain", expected_tool, "--params")
        assert len(argv) == 5
        assert isinstance(json.loads(argv[4]), dict)
        assert timeout == 30.0
        tools.append(expected_tool)
    assert tools == list(expected_tools)
    assert json.loads(runner.calls[3][0][4])["content"] == distilled


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
        assert output.result == {
            "session_id": "session-1",
            "lane_id": "lane-1",
            "context_updated": True,
        }
        assert [call[0][2] for call in runner.calls] == [
            "get_contract",
            "session_start",
            "get_contract",
            "session_wrap",
        ]


def test_direct_lane_then_failed_write_starts_fallback_lane_before_write() -> None:
    for operation, expected_tool in (
        ("capture_distilled", "append_session_event"),
        ("checkpoint", "session_wrap"),
    ):
        runner = FakeRunner()
        runtime = FirstClassMemoryRuntime(
            runtime_config(fallback_enabled=True),
            runtime_scope(),
            client=StartThenFailClient(),
            fallback_runner=runner,
        )

        output = getattr(runtime, operation)("Direct lane then fallback write")

        assert output.receipt.status is ReceiptStatus.FALLBACK
        assert output.receipt.durable is True
        assert [call[0][2] for call in runner.calls] == [
            "get_contract",
            "session_start",
            "get_contract",
            expected_tool,
        ]


def test_fallback_write_rejects_empty_success_result() -> None:
    runner = WriteResultRunner({})
    runtime = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        runtime_scope(),
        client=StartThenFailClient(fail_start=True),
        fallback_runner=runner,
    )

    output = runtime.capture_distilled("Malformed fallback result")

    assert output.receipt.status is ReceiptStatus.LOST
    assert output.receipt.durable is False
    assert "created or duplicate" in (output.receipt.error or "")


def test_fallback_without_scope_proof_cannot_claim_durable_success() -> None:
    runner = ToolResultRunner("session_start", {"is_new": True})
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


def test_unthreaded_fallback_rejects_threaded_scope_responses() -> None:
    scope = RuntimeScope(
        agent="bilby",
        platform="discord",
        server_id="guild-1",
        channel_id="channel-2",
        session_key="repo/session-4",
    )
    recall = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        scope,
        client=StartThenFailClient(),
        fallback_runner=FakeRunner(),
    ).recall_context("unthreaded recall")
    capture = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        scope,
        client=StartThenFailClient(fail_start=True),
        fallback_runner=FakeRunner(),
    ).capture_distilled("unthreaded capture")

    assert recall.receipt.status is ReceiptStatus.FAILED
    assert capture.receipt.status is ReceiptStatus.LOST
    assert "thread_id" in (recall.receipt.error or "")
    assert "thread_id" in (capture.receipt.error or "")


def test_unthreaded_fallback_requires_explicit_null_scope_key() -> None:
    scope = RuntimeScope(
        agent="bilby",
        platform="discord",
        server_id="guild-1",
        channel_id="channel-2",
        session_key="repo/session-4",
    )
    omitted_thread_scope = {
        "namespace": "bilby",
        "session_key": "repo/session-4",
        "agent": "bilby",
        "platform": "discord",
        "server_id": "guild-1",
        "channel_id": "channel-2",
    }
    recall_runner = ToolResultRunner(
        "agent_context_pack",
        {"scope": omitted_thread_scope, "sections": {}},
    )
    lane = {
        "namespace": "bilby",
        "session_key": "repo/session-4",
        "agent": "bilby",
        "source": "discord",
        "channel_id": "channel-2",
        "metadata": {"server_id": "guild-1"},
    }
    capture_runner = ToolResultRunner("session_start", {"lane": lane, "is_new": True})

    recall = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        scope,
        client=StartThenFailClient(),
        fallback_runner=recall_runner,
    ).recall_context("unthreaded recall")
    capture = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        scope,
        client=StartThenFailClient(fail_start=True),
        fallback_runner=capture_runner,
    ).capture_distilled("unthreaded capture")

    assert recall.receipt.status is ReceiptStatus.FAILED
    assert capture.receipt.status is ReceiptStatus.LOST
    assert "thread_id" in (recall.receipt.error or "")
    assert "thread_id" in (capture.receipt.error or "")


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


def test_run_subprocess_caps_output_before_child_exit() -> None:
    started = time.monotonic()
    with pytest.raises(router_module.RuntimeCallError, match="response limit"):
        router_module.run_subprocess(
            (
                sys.executable,
                "-c",
                "import sys,time;sys.stdout.write('x'*1000001);"
                "sys.stdout.flush();time.sleep(10)",
            ),
            timeout=5,
        )

    assert time.monotonic() - started < 3


def test_run_subprocess_times_out_and_redacts_child_output() -> None:
    runner = router_module.Mcp2CliFallback(
        lambda argv, *, timeout: router_module.run_subprocess(
            (
                sys.executable,
                "-c",
                "import sys,time;sys.stderr.write('token=super-secret-value');"
                "sys.stderr.flush();time.sleep(10)",
            ),
            timeout=timeout,
        ),
        namespace="bilby",
        scope=runtime_scope(),
        timeout=0.1,
    )

    with pytest.raises(router_module.RuntimeCallError) as error:
        runner.call("agent_context_pack", runtime_scope().context_pack_arguments("x"))

    assert "timed out" in str(error.value)
    assert "super-secret-value" not in str(error.value)
