"""Focused regressions for first-class runtime contract discovery."""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from openbrain_memory import FirstClassMemoryRuntime, ReceiptStatus
from openbrain_memory.client import FIRST_CLASS_RUNTIME_TOOL_VERSIONS

from ._runtime_fakes import (
    ContextClient,
    FakeRunner,
    FakeSpool,
    RunnerResult,
    StartThenFailClient,
    WriteResultClient,
    runtime_config,
    runtime_contract_manifest,
    runtime_scope,
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


class SequencedContractWriteClient(WriteResultClient):
    def __init__(self, manifests: list[dict[str, Any]]) -> None:
        super().__init__(
            append_result={
                "event_id": "event-1",
                "lane_id": "lane-1",
                "lane_created": False,
            }
        )
        self.manifests = manifests
        self.contract_calls = 0

    def get_contract(self, **arguments: Any) -> dict[str, Any]:
        manifest = self.manifests[min(self.contract_calls, len(self.manifests) - 1)]
        self.contract_calls += 1
        return dict(manifest)


class SequencedContractRunner(FakeRunner):
    def __init__(self, manifests: list[dict[str, Any]]) -> None:
        super().__init__()
        self.manifests = manifests
        self.contract_calls = 0

    def __call__(
        self,
        argv: Sequence[str],
        *,
        timeout: float,
    ) -> RunnerResult:
        call = tuple(argv)
        self.calls.append((call, timeout))
        tool = call[2]
        if tool == "get_contract":
            manifest = self.manifests[min(self.contract_calls, len(self.manifests) - 1)]
            self.contract_calls += 1
            response = {"success": True, "result": manifest}
        else:
            response = self._response(tool)
        return RunnerResult(stdout=json.dumps(response))


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


def test_direct_manifest_mutation_after_lane_start_spools_then_recovers() -> None:
    valid = runtime_contract_manifest()
    altered = runtime_contract_manifest()
    altered["schema_hash"] = "0" * 64
    client = SequencedContractWriteClient([valid, altered, valid])
    spool = FakeSpool()
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), client=client, spool=spool
    )

    rejected = runtime.capture_distilled("Spool after direct manifest mutation")
    recovered = runtime.capture_distilled("Save after direct manifest rollback")

    assert rejected.receipt.status is ReceiptStatus.SPOOLED
    assert rejected.receipt.durable is True
    assert recovered.receipt.status is ReceiptStatus.SAVED
    assert recovered.receipt.durable is True
    assert client.contract_calls == 3
    assert [operation for operation, _payload, _key in spool.calls] == [
        "append_session_event"
    ]


def test_fallback_manifest_mutation_after_lane_start_spools_then_recovers() -> None:
    valid = runtime_contract_manifest()
    altered = runtime_contract_manifest()
    altered["schema_hash"] = "0" * 64
    runner = SequencedContractRunner([valid, altered, valid])
    spool = FakeSpool()
    runtime = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        runtime_scope(),
        client=IncompatibleContractClient(),
        fallback_runner=runner,
        spool=spool,
    )

    rejected = runtime.capture_distilled("Spool after fallback manifest mutation")
    recovered = runtime.capture_distilled("Save after fallback manifest rollback")

    assert rejected.receipt.status is ReceiptStatus.SPOOLED
    assert rejected.receipt.durable is True
    assert recovered.receipt.status is ReceiptStatus.FALLBACK
    assert recovered.receipt.durable is True
    assert runner.contract_calls == 3
    assert [call[0][2] for call in runner.calls] == [
        "get_contract",
        "session_start",
        "get_contract",
        "get_contract",
        "append_session_event",
    ]
    assert [operation for operation, _payload, _key in spool.calls] == [
        "append_session_event"
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
        "get_contract",
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
