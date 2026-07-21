"""Runtime-neutral memory-contract fixture consumers for the Python package."""

from __future__ import annotations

import json
import stat
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from openbrain_memory import (
    COMPATIBLE_CONTRACT_VERSIONS,
    CURRENT_CONTRACT_HEADER,
    CURRENT_CONTRACT_SCHEMA_HASH,
    CURRENT_CONTRACT_SCHEMA_VERSION,
    CURRENT_CONTRACT_VERSION,
    AgentMemory,
    FirstClassMemoryRuntime,
    JsonlSpool,
    OpenBrainClient,
    ReceiptStatus,
    RuntimeReceipt,
)
from openbrain_memory.spool import SpoolFullError

from ._runtime_fakes import (
    LaneAwareTransport,
    StartThenFailClient,
    runtime_config,
    runtime_scope,
    tool_calls,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_DIR = REPO_ROOT / "contracts" / "memory"


def _load_fixtures() -> list[dict[str, Any]]:
    fixtures = []
    for path in sorted(FIXTURE_DIR.glob("*.fixture.json")):
        value = json.loads(path.read_text(encoding="utf-8"))
        if value.get("runtime") in {"both", "python"}:
            fixtures.append(value)
    return fixtures


PYTHON_FIXTURES = _load_fixtures()


class ScopeProofClient(StartThenFailClient):
    def __init__(self, scope_result: Mapping[str, Any]) -> None:
        super().__init__()
        self.scope_result = dict(scope_result)

    def agent_context_pack(self, **arguments: Any) -> dict[str, Any]:
        return {"scope": dict(self.scope_result)}


class ReceiptClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def session_start(self, **arguments: Any) -> dict[str, Any]:
        self.calls.append(("session_start", dict(arguments)))
        return {"lane": {"session_key": arguments["session_key"]}}

    def append_session_event(self, **arguments: Any) -> dict[str, Any]:
        self.calls.append(("append_session_event", dict(arguments)))
        return {"event_id": "event-fixture"}


def _assert_contract_value(actual: Any, expected: Any) -> None:
    if expected == "<non-empty-string>":
        assert isinstance(actual, str) and actual
        return
    if isinstance(expected, dict):
        assert isinstance(actual, Mapping)
        assert set(actual) == set(expected)
        for key, value in expected.items():
            _assert_contract_value(actual[key], value)
        return
    if isinstance(expected, list):
        assert isinstance(actual, list)
        assert len(actual) == len(expected)
        for actual_item, expected_item in zip(actual, expected, strict=True):
            _assert_contract_value(actual_item, expected_item)
        return
    assert actual == expected


@pytest.mark.parametrize(
    "fixture",
    PYTHON_FIXTURES,
    ids=[fixture["id"] for fixture in PYTHON_FIXTURES],
)
def test_python_consumes_memory_contract_fixture(
    fixture: dict[str, Any],
    tmp_path: Path,
) -> None:
    assert "python" in fixture["consumers"]
    handlers = {
        "contract-declaration": _consume_contract_declaration,
        "session-lifecycle": _consume_session_lifecycle,
        "exact-scope-proof": _consume_exact_scope_proof,
        "spool-backpressure": _consume_spool_backpressure,
        "redact-before-persist": _consume_redact_before_persist,
        "auto-drain-allowlist": _consume_auto_drain_allowlist,
        "receipt-shapes": _consume_receipt_shapes,
    }
    handlers[fixture["capability"]](fixture, tmp_path)


def _consume_contract_declaration(
    fixture: dict[str, Any],
    _tmp_path: Path,
) -> None:
    request = fixture["request"]
    expectation = fixture["expectation"]
    assert CURRENT_CONTRACT_VERSION == request["contract_id"]
    assert CURRENT_CONTRACT_SCHEMA_VERSION == request["schema_version"]
    assert CURRENT_CONTRACT_SCHEMA_HASH == request["schema_hash"]
    assert list(COMPATIBLE_CONTRACT_VERSIONS) == expectation[
        "compatible_contract_ids"
    ]
    assert CURRENT_CONTRACT_HEADER == expectation["client_header"]


def _consume_session_lifecycle(
    fixture: dict[str, Any],
    _tmp_path: Path,
) -> None:
    request = fixture["request"]
    expectation = fixture["expectation"]
    transport = LaneAwareTransport()
    entrypoint = request["entrypoint"]

    if entrypoint == "client.session_start":
        client = OpenBrainClient(
            "https://brain.example",
            token="unit-test-token",
            namespace="bilby",
            agent_id="bilby",
            transport=transport,
        )
        result = client.session_start(**request["arguments"])
        status = "direct" if result.get("lane") else "failed"
        durable = None
    else:
        runtime = FirstClassMemoryRuntime(
            runtime_config(),
            runtime_scope(),
            transport=transport,
        )
        method = getattr(runtime, entrypoint.removeprefix("runtime."))
        output = method(**request["arguments"])
        status = output.receipt.status.value
        durable = output.receipt.durable

    calls = [
        call["params"]
        for call in tool_calls(transport)
        if call["params"]["name"] != "get_contract"
    ]
    assert len(calls) == len(expectation["tool_calls"])
    for actual, expected in zip(calls, expectation["tool_calls"], strict=True):
        _assert_contract_value(actual, expected)
    assert status == expectation["status"]
    if "durable" in expectation:
        assert durable is expectation["durable"]
    assert all(
        http_request["headers"]["X-OB-Contract"] == CURRENT_CONTRACT_HEADER
        for http_request in transport.requests
    )


def _consume_exact_scope_proof(
    fixture: dict[str, Any],
    _tmp_path: Path,
) -> None:
    request = fixture["request"]
    expectation = fixture["expectation"]
    exact = dict(request["scope"])
    accepted = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        client=ScopeProofClient(exact),
    ).recall_context("Exact scope fixture")
    assert accepted.receipt.status.value == expectation["exact_status"]

    for field in request["mismatch_fields"]:
        mismatched = dict(exact)
        mismatched[field] = "other"
        output = FirstClassMemoryRuntime(
            runtime_config(),
            runtime_scope(),
            client=ScopeProofClient(mismatched),
        ).recall_context(f"Mismatch fixture: {field}")
        assert output.receipt.status.value == expectation[
            "mismatch_status_without_fallback"
        ]
        assert output.context == expectation["mismatch_context_without_fallback"]


def _consume_spool_backpressure(
    fixture: dict[str, Any],
    tmp_path: Path,
) -> None:
    request = fixture["request"]
    expectation = fixture["expectation"]
    spool = JsonlSpool(tmp_path / "backpressure.jsonl", max_lines=request["max_lines"])
    records = request["records"]
    for record in records[:2]:
        spool.append(record["operation"], record["payload"], key=record["key"])
    original = spool.path.read_bytes()
    with pytest.raises(SpoolFullError):
        record = records[2]
        spool.append(record["operation"], record["payload"], key=record["key"])
    assert expectation["rejected_error"] == "SpoolFullError"
    assert spool.path.read_bytes() == original
    assert [record.operation for record in spool.records()] == expectation[
        "retained_operations"
    ]
    replayed = spool.replay(lambda record: record.operation)
    assert replayed == expectation["replay_operations"]


def _consume_redact_before_persist(
    fixture: dict[str, Any],
    tmp_path: Path,
) -> None:
    request = fixture["request"]
    expectation = fixture["expectation"]
    spool = JsonlSpool(tmp_path / "redacted.jsonl")
    spool.append(request["operation"], request["payload"], key=request["key"])
    persisted = spool.path.read_text(encoding="utf-8")
    record = spool.records()[0]
    assert record.payload == expectation["persisted_payload"]
    for forbidden in expectation["forbidden_substrings"]:
        assert forbidden not in persisted
        assert forbidden not in str(record.payload)
    mode = stat.S_IMODE(spool.path.stat().st_mode)
    assert f"{mode:04o}" == expectation["file_mode"]


def _consume_auto_drain_allowlist(
    fixture: dict[str, Any],
    tmp_path: Path,
) -> None:
    request = fixture["request"]
    expectation = fixture["expectation"]
    spool = JsonlSpool(tmp_path / "drain.jsonl")
    for index, record in enumerate(request["operations"]):
        spool.append(
            record["operation"],
            record["payload"],
            key=f"fixture-allowed-{index}",
        )
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        transport=transport,
        spool=spool,
    )
    output = runtime.recall_context("Drain fixture")
    dispatched = [
        call["params"]["name"]
        for call in tool_calls(transport)
        if call["params"]["name"] not in {"get_contract", "agent_context_pack"}
    ]
    assert output.receipt.status.value == expectation["trigger_status"]
    assert dispatched == expectation["dispatched_operations"]
    assert spool.status().pending_count == expectation["pending_count"]


def _consume_receipt_shapes(
    fixture: dict[str, Any],
    _tmp_path: Path,
) -> None:
    request = fixture["request"]
    expectation = fixture["expectation"]
    runtime_request = request["runtime_receipt"]
    runtime_receipt = RuntimeReceipt(
        operation=runtime_request["operation"],
        status=ReceiptStatus(runtime_request["status"]),
        durable=runtime_request["durable"],
        direct_attempted=runtime_request["direct_attempted"],
        fallback_attempted=runtime_request["fallback_attempted"],
        spool_key=runtime_request["spool_key"],
        error=runtime_request["error"],
    ).as_dict()
    assert runtime_receipt["schema"] == expectation["runtime_schema"]
    for key, value in runtime_request.items():
        assert runtime_receipt[key] == value

    client = ReceiptClient()
    memory = AgentMemory(client, agent="bilby", project="open-brain")
    memory.start_session("repo/session-4")
    memory.record_receipt(**request["agent_receipt"])
    name, payload = client.calls[-1]
    assert name == "append_session_event"
    assert payload["event_type"] == expectation["agent_event_type"]
    receipt = payload["metadata"]["receipt"]
    assert receipt["schema"] == expectation["agent_schema"]
    for key, value in request["agent_receipt"].items():
        assert receipt[key] == value
