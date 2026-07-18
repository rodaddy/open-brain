"""Regressions for exact-scope proof on primary runtime responses."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

from openbrain_memory import FirstClassMemoryRuntime, ReceiptStatus, RuntimeScope

from ._runtime_fakes import (
    FakeRunner,
    FakeSpool,
    StartThenFailClient,
    runtime_config,
    runtime_scope,
)


class ScopeResponseClient(StartThenFailClient):
    """Direct client with caller-controlled start and context scope receipts."""

    def __init__(
        self,
        *,
        start_thread: str | None | object = "thread-3",
        context_result: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__()
        self.start_thread = start_thread
        self.context_result = dict(context_result or {})

    def session_start(self, **arguments: Any) -> dict[str, Any]:
        result = super().session_start(**arguments)
        lane = result["lane"]
        if self.start_thread is MISSING:
            lane.pop("thread_id")
        else:
            lane["thread_id"] = self.start_thread
        return result

    def append_session_event(self, **arguments: Any) -> dict[str, Any]:
        return {
            "event_id": "event-1",
            "lane_id": "lane-1",
            "lane_created": False,
        }

    def agent_context_pack(self, **arguments: Any) -> dict[str, Any]:
        return dict(self.context_result)


class UnthreadedRunner(FakeRunner):
    """Fallback runner whose receipts explicitly prove an unthreaded scope."""

    @staticmethod
    def _response(tool: str) -> dict[str, Any]:
        response = FakeRunner._response(tool)
        if tool == "session_start":
            response["result"]["lane"]["thread_id"] = None
        elif tool == "agent_context_pack":
            response["result"]["scope"]["thread_id"] = None
        return response


MISSING = object()


def unthreaded_scope() -> RuntimeScope:
    return RuntimeScope(
        agent="bilby",
        platform="discord",
        server_id="guild-1",
        channel_id="channel-2",
        session_key="repo/session-4",
    )


def exact_scope(scope: RuntimeScope) -> dict[str, Any]:
    return {
        "namespace": "bilby",
        "session_key": scope.session_key,
        "agent": scope.agent,
        "platform": scope.platform,
        "server_id": scope.server_id,
        "channel_id": scope.channel_id,
        "thread_id": scope.thread_id,
    }


@pytest.mark.parametrize("direct_thread", [MISSING, "wrong-thread"])
def test_unthreaded_direct_start_invalid_thread_recovers_to_fallback(
    direct_thread: str | object,
) -> None:
    runner = UnthreadedRunner()
    runtime = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        unthreaded_scope(),
        client=ScopeResponseClient(start_thread=direct_thread),
        fallback_runner=runner,
    )

    output = runtime.capture_distilled("Exact nullable start scope")

    assert output.receipt.status is ReceiptStatus.FALLBACK
    assert output.receipt.fallback_attempted is True
    assert [call[0][2] for call in runner.calls] == ["get_contract", "session_start"]


def test_unthreaded_direct_start_accepts_explicit_null_thread() -> None:
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        unthreaded_scope(),
        client=ScopeResponseClient(start_thread=None),
    )

    output = runtime.capture_distilled("Explicit null start scope")

    assert output.receipt.status is ReceiptStatus.SAVED
    assert output.receipt.fallback_attempted is False


def test_wrong_direct_start_scope_continues_to_ordered_spool() -> None:
    spool = FakeSpool()
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        unthreaded_scope(),
        client=ScopeResponseClient(start_thread="wrong-thread"),
        spool=spool,
    )

    output = runtime.capture_distilled("Spool after invalid direct start")

    assert output.receipt.status is ReceiptStatus.SPOOLED
    assert [operation for operation, _payload, _key in spool.calls] == [
        "session_start",
        "append_session_event",
    ]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("namespace", "other"),
        ("session_key", "other"),
        ("agent", "other"),
        ("platform", "other"),
        ("server_id", "other"),
        ("channel_id", "other"),
        ("thread_id", "other"),
    ],
)
def test_wrong_direct_context_scope_recovers_to_validated_fallback(
    field: str,
    value: str,
) -> None:
    scope = runtime_scope()
    candidate = exact_scope(scope)
    candidate[field] = value
    runner = FakeRunner()
    runtime = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        scope,
        client=ScopeResponseClient(context_result={"scope": candidate}),
        fallback_runner=runner,
    )

    output = runtime.recall_context("Wrong direct context scope")

    assert output.receipt.status is ReceiptStatus.FALLBACK
    assert output.receipt.fallback_attempted is True
    assert [call[0][2] for call in runner.calls] == [
        "get_contract",
        "agent_context_pack",
    ]


@pytest.mark.parametrize("context_result", [{}, {"scope": {}}])
def test_missing_direct_context_scope_recovers_to_fallback(
    context_result: Mapping[str, Any],
) -> None:
    runtime = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        runtime_scope(),
        client=ScopeResponseClient(context_result=context_result),
        fallback_runner=FakeRunner(),
    )

    output = runtime.recall_context("Missing direct context scope")

    assert output.receipt.status is ReceiptStatus.FALLBACK


@pytest.mark.parametrize("thread", [MISSING, "wrong-thread"])
def test_unthreaded_direct_context_invalid_thread_recovers_to_fallback(
    thread: str | object,
) -> None:
    scope = unthreaded_scope()
    candidate = exact_scope(scope)
    if thread is MISSING:
        candidate.pop("thread_id")
    else:
        candidate["thread_id"] = thread
    runtime = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        scope,
        client=ScopeResponseClient(context_result={"scope": candidate}),
        fallback_runner=UnthreadedRunner(),
    )

    output = runtime.recall_context("Exact nullable context scope")

    assert output.receipt.status is ReceiptStatus.FALLBACK


def test_unthreaded_direct_context_accepts_explicit_null_thread() -> None:
    scope = unthreaded_scope()
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        scope,
        client=ScopeResponseClient(context_result={"scope": exact_scope(scope)}),
    )

    output = runtime.recall_context("Explicit null context scope")

    assert output.receipt.status is ReceiptStatus.DIRECT


def test_invalid_direct_context_without_fallback_fails_open() -> None:
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        client=ScopeResponseClient(context_result={}),
    )

    output = runtime.recall_context("Fail-open invalid direct context")

    assert output.receipt.status is ReceiptStatus.FAILED
    assert output.context == {}
