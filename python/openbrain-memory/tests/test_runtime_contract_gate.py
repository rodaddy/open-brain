"""Focused regressions for first-class runtime contract discovery."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from openbrain_memory import FirstClassMemoryRuntime, ReceiptStatus
from openbrain_memory.client import FIRST_CLASS_RUNTIME_TOOL_VERSIONS

from ._runtime_fakes import (
    ContextClient,
    FakeRunner,
    FakeSpool,
    LaneAwareTransport,
    StartThenFailClient,
    runtime_config,
    runtime_contract_manifest,
    runtime_scope,
    tool_calls,
)


def test_runtime_tool_versions_match_server_contract_source() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    source = (repo_root / "src" / "contract-schemas.ts").read_text(encoding="utf-8")
    actual: dict[str, int] = {}
    for tool_name in FIRST_CLASS_RUNTIME_TOOL_VERSIONS:
        match = re.search(rf"\n  {tool_name}: \{{\n    version: (\d+),", source)
        assert match, f"could not find {tool_name} version in src/contract-schemas.ts"
        actual[tool_name] = int(match.group(1))

    assert dict(FIRST_CLASS_RUNTIME_TOOL_VERSIONS) == actual


class MissingContractClient(ContextClient):
    """Intentionally lacks get_contract to exercise the injected-client boundary."""

    get_contract = None  # type: ignore[assignment]


class UnavailableContractClient(StartThenFailClient):
    def get_contract(self, **arguments: Any) -> dict[str, Any]:
        raise ConnectionError("contract discovery unavailable")


class RecoveringContractClient(ContextClient):
    def __init__(self) -> None:
        super().__init__()
        self.contract_calls = 0

    def get_contract(self, **arguments: Any) -> dict[str, Any]:
        self.contract_calls += 1
        if self.contract_calls == 1:
            raise ConnectionError("contract discovery unavailable")
        return runtime_contract_manifest()


class IncompatibleContractClient(ContextClient):
    def get_contract(self, **arguments: Any) -> dict[str, Any]:
        manifest = runtime_contract_manifest()
        manifest["contract_version"] = "2026-07-13.memory-tools.v21"
        return manifest


class MalformedLaneClient(StartThenFailClient):
    def session_start(self, **arguments: Any) -> dict[str, Any]:
        return {
            "lane": {
                "namespace": "bilby",
                "session_key": arguments["session_key"],
                "agent": arguments["agent"],
                "source": arguments["platform"],
                "channel_id": "wrong-channel",
                "thread_id": arguments.get("thread_id"),
                "metadata": {"server_id": arguments["server_id"]},
            }
        }


def test_runtime_discovers_contract_once_before_first_semantic_call() -> None:
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), transport=transport
    )

    first = runtime.recall_context("first")
    second = runtime.recall_context("second")

    assert first.receipt.status is ReceiptStatus.DIRECT
    assert second.receipt.status is ReceiptStatus.DIRECT
    assert [call["params"]["name"] for call in tool_calls(transport)] == [
        "get_contract",
        "agent_context_pack",
        "agent_context_pack",
    ]


def test_injected_client_without_get_contract_is_not_silently_accepted() -> None:
    client = MissingContractClient()
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        client=client,  # type: ignore[arg-type]
    )

    output = runtime.recall_context("must validate")

    assert output.receipt.status is ReceiptStatus.FAILED
    assert output.receipt.direct_attempted is True
    assert client.observed_timeouts == []
    assert "get_contract" in (output.receipt.error or "")


def test_transient_contract_discovery_failure_is_retried() -> None:
    client = RecoveringContractClient()
    runtime = FirstClassMemoryRuntime(runtime_config(), runtime_scope(), client=client)

    unavailable = runtime.recall_context("first attempt")
    recovered = runtime.recall_context("second attempt")

    assert unavailable.receipt.status is ReceiptStatus.FAILED
    assert recovered.receipt.status is ReceiptStatus.DIRECT
    assert client.contract_calls == 2
    assert client.observed_timeouts == [30.0]


def test_incompatible_direct_contract_routes_to_validated_fallback() -> None:
    client = IncompatibleContractClient()
    runner = FakeRunner()
    runtime = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        runtime_scope(),
        client=client,
        fallback_runner=runner,
    )

    output = runtime.recall_context("fallback after incompatible contract")

    assert output.receipt.status is ReceiptStatus.FALLBACK
    assert client.observed_timeouts == []
    assert [call[0][2] for call in runner.calls] == [
        "get_contract",
        "agent_context_pack",
    ]


def test_unavailable_contract_discovery_preserves_ordered_spool() -> None:
    spool = FakeSpool()
    client = UnavailableContractClient()
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), client=client, spool=spool
    )

    output = runtime.capture_distilled("Durable after discovery outage")

    assert output.receipt.status is ReceiptStatus.SPOOLED
    assert output.receipt.durable is True
    assert client.started is False
    assert [operation for operation, _payload, _key in spool.calls] == [
        "session_start",
        "append_session_event",
    ]


def test_malformed_direct_lane_response_routes_to_fallback() -> None:
    runner = FakeRunner()
    runtime = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        runtime_scope(),
        client=MalformedLaneClient(),
        fallback_runner=runner,
    )

    output = runtime.capture_distilled("Fallback after malformed lane")

    assert output.receipt.status is ReceiptStatus.FALLBACK
    assert output.receipt.durable is True
    assert [call[0][2] for call in runner.calls] == [
        "get_contract",
        "session_start",
        "append_session_event",
    ]


def test_malformed_direct_lane_response_can_spool_requested_write() -> None:
    spool = FakeSpool()
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), client=MalformedLaneClient(), spool=spool
    )

    output = runtime.checkpoint("Spool after malformed lane")

    assert output.receipt.status is ReceiptStatus.SPOOLED
    assert output.receipt.durable is True
    assert [operation for operation, _payload, _key in spool.calls] == [
        "session_start",
        "session_wrap",
    ]
