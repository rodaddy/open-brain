"""N-1 compatibility tests for the runtime adapter JSON console boundary."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

import pytest

from openbrain_memory.cli import execute_json

from ._runtime_fakes import LaneAwareTransport, tool_calls

FIXTURE_PATH = (
    Path(__file__).parent
    / "fixtures"
    / "cli-compat"
    / "adapter-0.1.17-requests.json"
)
CLI_0_1_17_WHEEL = Path(
    "/Users/rico/.local/share/openbrain-memory/wheels/"
    "openbrain_memory-0.1.17-py3-none-any.whl"
)
RUN_0_1_17_COMPAT_ENV = "OPENBRAIN_RUN_0_1_17_CLI_COMPAT"
CURRENT_ADAPTER_BASE_KEYS = {
    "recall": {
        "config",
        "max_latency_ms",
        "max_tokens",
        "operation",
        "query",
        "requested_sections",
        "scope",
    },
    "capture": {
        "config",
        "content",
        "distilled",
        "event_type",
        "operation",
        "scope",
    },
    "checkpoint": {
        "config",
        "distilled",
        "key_decisions",
        "next_steps",
        "operation",
        "receipt_refs",
        "scope",
        "summary",
    },
    "wrap": {
        "config",
        "distilled",
        "key_decisions",
        "next_steps",
        "operation",
        "receipt_refs",
        "scope",
        "summary",
    },
}


def _requests() -> dict[str, dict[str, Any]]:
    loaded = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


def test_current_adapter_base_surface_matches_immutable_0_1_17_requests() -> None:
    """Prove the fixture is also the current adapter's base request shape.

    Version 0.1.18 adds tolerant reading and receipt metadata, not request
    fields. Therefore these exact base envelopes are the payloads exercised in
    the current-adapter-to-0.1.17-CLI direction below.
    """
    requests = _requests()

    assert set(requests) == set(CURRENT_ADAPTER_BASE_KEYS)
    for operation, expected_keys in CURRENT_ADAPTER_BASE_KEYS.items():
        assert set(requests[operation]) == expected_keys


@pytest.mark.parametrize("operation", ["recall", "capture", "checkpoint", "wrap"])
def test_0_1_18_cli_dispatches_immutable_0_1_17_requests(operation: str) -> None:
    request = _requests()[operation]
    transport = LaneAwareTransport()

    output = execute_json(request, transport=transport)

    expected_status = "direct" if operation == "recall" else "saved"
    assert output["receipt"]["operation"] == operation
    assert output["receipt"]["status"] == expected_status
    assert "compatibility_note" not in output["receipt"]
    calls = tool_calls(transport)
    dispatched = calls[-1]["params"]
    expected_tool = {
        "recall": "agent_context_pack",
        "capture": "append_session_event",
        "checkpoint": "session_wrap",
        "wrap": "session_wrap",
    }[operation]
    assert dispatched["name"] == expected_tool
    arguments = dispatched["arguments"]
    if operation == "recall":
        assert arguments["query"] == request["query"]
        assert arguments["budget"] == {
            "max_tokens": request["max_tokens"],
            "max_latency_ms": request["max_latency_ms"],
        }
        assert arguments["requested_sections"] == request["requested_sections"]
    elif operation == "capture":
        assert arguments["content"] == request["content"]
        assert arguments["event_type"] == request["event_type"]
    else:
        assert arguments["summary"] == request["summary"]
        assert arguments["key_decisions"] == request["key_decisions"]
        assert arguments["next_steps"] == [
            *request["next_steps"],
            *(f"Receipt ref: {ref}" for ref in request["receipt_refs"]),
        ]


@pytest.mark.parametrize("operation", ["recall", "capture", "checkpoint", "wrap"])
def test_0_1_18_cli_tolerates_future_field_on_0_1_17_requests(
    operation: str,
) -> None:
    request = {**_requests()[operation], "future_optional": "not-forwarded"}
    transport = LaneAwareTransport()

    output = execute_json(request, transport=transport)

    assert (
        output["receipt"]["compatibility_note"]
        == "ignored_optional_request_keys"
    )
    assert output["receipt"]["ignored_optional_key_count"] == 1
    assert "future_optional" not in json.dumps(tool_calls(transport))
    assert "not-forwarded" not in json.dumps(tool_calls(transport))


def test_0_1_18_cli_still_rejects_invalid_known_optional_type() -> None:
    request = {**_requests()["recall"], "max_tokens": "400"}
    transport = LaneAwareTransport()

    output = execute_json(request, transport=transport)

    assert output["receipt"]["status"] == "failed"
    assert output["receipt"]["error"] == "max_tokens must be an integer"
    assert tool_calls(transport) == []


@pytest.mark.skipif(
    os.environ.get(RUN_0_1_17_COMPAT_ENV) != "1",
    reason=f"set {RUN_0_1_17_COMPAT_ENV}=1 for the local wheel proof",
)
@pytest.mark.parametrize("operation", ["recall", "capture", "checkpoint", "wrap"])
def test_current_base_requests_remain_accepted_by_0_1_17_cli(
    operation: str,
    tmp_path: Path,
) -> None:
    if not CLI_0_1_17_WHEEL.is_file():
        pytest.skip("the reviewed 0.1.17 wheel is unavailable")
    request = _requests()[operation]
    request["config"] = {
        **request["config"],
        "base_url": "https://127.0.0.1:9",
    }

    completed = subprocess.run(
        [
            "uv",
            "run",
            "--isolated",
            "--with",
            str(CLI_0_1_17_WHEEL),
            "--",
            "python",
            "-m",
            "openbrain_memory",
        ],
        input=json.dumps(request),
        text=True,
        capture_output=True,
        cwd=tmp_path,
        check=False,
        timeout=30,
    )

    assert completed.returncode in {0, 1}, completed.stderr
    output = json.loads(completed.stdout)
    assert output["receipt"]["operation"] == operation
    assert "contains unsupported keys" not in (output["receipt"].get("error") or "")
