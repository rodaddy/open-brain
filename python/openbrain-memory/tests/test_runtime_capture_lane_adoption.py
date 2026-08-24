"""A distilled capture must ADOPT an existing lane's stored scope (dev#267).

Reproduced 2026-08-23 from a Development head session: the SessionStart
adapter opened the `dev:development` lane under its own coordinates, and a
`capture` from the head, claiming the documented Claude Code scope, was
LOST with

    Existing lane exact scope does not match session_start request

`wrap` and `checkpoint` already adopt through that refusal (#724 item 4,
`test_runtime_wrap_lane_adoption.py`); `capture_distilled` did not pass
`adopt_lane_scope=True` and sent the requester's own coordinates. Same
fixture and fake transport as the wrap tests.
"""

from __future__ import annotations

from typing import Any

from openbrain_memory.cli import execute_json

from ._runtime_fakes import LaneAwareTransport, request_payload, tool_calls

CAPTURE_AGENT = "openbrain-capture"
SESSION_KEY = "session"


def _capture_hook_lane() -> dict[str, Any]:
    return {
        "namespace": "bilby",
        "session_key": SESSION_KEY,
        "agent": CAPTURE_AGENT,
        "source": None,
        "channel_id": None,
        "thread_id": None,
        "project": None,
        "current_context_md": None,
        "metadata": {"server_id": None},
    }


def _transport_with_capture_lane() -> LaneAwareTransport:
    transport = LaneAwareTransport()
    transport.started_sessions[SESSION_KEY] = _capture_hook_lane()
    return transport


def _capture_request() -> dict[str, Any]:
    return request_payload(
        "capture",
        distilled=True,
        event_type="receipt",
        content="Head-session capture against a lane another process opened.",
    )


def test_capture_adopts_an_existing_lane_scope() -> None:
    transport = _transport_with_capture_lane()

    output = execute_json(_capture_request(), transport=transport)

    receipt = output["receipt"]
    assert receipt["operation"] == "capture"
    assert receipt["status"] == "saved", receipt.get("error")
    assert receipt["durable"] is True


def test_capture_writes_under_the_lanes_stored_scope() -> None:
    transport = _transport_with_capture_lane()

    execute_json(_capture_request(), transport=transport)

    writes = [
        call["params"]["arguments"]
        for call in tool_calls(transport)
        if call["params"]["name"] == "append_session_event"
    ]
    assert writes, "capture did not reach append_session_event"
    sent = writes[-1]
    assert sent["agent"] == CAPTURE_AGENT
    assert sent.get("platform") is None
    assert sent.get("server_id") is None
    assert sent.get("channel_id") is None


def test_capture_lane_scope_is_not_rewritten() -> None:
    transport = _transport_with_capture_lane()

    execute_json(_capture_request(), transport=transport)

    lane = transport.started_sessions[SESSION_KEY]
    assert lane["agent"] == CAPTURE_AGENT
    assert lane["source"] is None
    assert lane["metadata"]["server_id"] is None
