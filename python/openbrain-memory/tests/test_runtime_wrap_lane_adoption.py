"""Manual wrap/checkpoint must ADOPT an existing capture lane's stored scope.

RED-FIRST (#724 item 4). Measured failure, 2026-08-17: a manual
`openbrain-memory --event wrap` (and `--event checkpoint`) against a session
whose lane was created by the capture hook fails with

    Existing lane exact scope does not match session_start request

The chain, verified in source:

* the capture hook opens the BASE lane with `agent='openbrain-capture'` and
  every other exact-scope field NULL
  (`python/openbrain/src/openbrain/config.py:517`);
* the client runtime makes `session_start` claim the CALLER's own full exact
  scope — `RuntimeScope.start_metadata()` via `_ensure_lane()`
  (`src/openbrain_memory/runtime.py:1194-1200`);
* the server's #646 one-way fill refuses to re-point an already-set `agent`
  and returns the refusal above
  (`server/tools/session-lifecycle.ts:61-100,151-166`).

Operator ruling 2026-08-17: **wrap adopts the lane's existing scope.** The
server's refusal is an isolation boundary and MUST NOT change; the client is
what has to stop claiming a scope it does not own. Validation of a wrap/
checkpoint lane binds on `session_key` + `namespace` — the coordinates the
caller genuinely owns — not on the requester's exact scope.

Modeled on `tests/test_runtime_ingest.py`, which drives the same
`execute_json` + `LaneAwareTransport` + `request_payload` fake-transport path;
`LaneAwareTransport` already reproduces the server's one-way-fill refusal
verbatim (`tests/_runtime_fakes.py:120-136`), so no new fake is introduced.

Status: PROPOSED behavior. On current code these tests are RED with the
scope-mismatch error, which is the proof the check can fail.
"""

from __future__ import annotations

from typing import Any

import pytest

from openbrain_memory.cli import execute_json

from ._runtime_fakes import LaneAwareTransport, request_payload, tool_calls

CAPTURE_AGENT = "openbrain-capture"
SESSION_KEY = "session"


def _capture_hook_lane(session_key: str = SESSION_KEY) -> dict[str, Any]:
    """The lane shape the capture hook actually creates.

    `agent` set, every other exact-scope coordinate NULL — the 2009-lane class
    #646 was measured against.
    """
    return {
        "namespace": "bilby",
        "session_key": session_key,
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


def _wrap_request(operation: str) -> dict[str, Any]:
    """A manual wrap/checkpoint from a session scoped as a DIFFERENT agent.

    `request_payload` supplies `agent='bilby'`, `platform='discord'`,
    `server_id='guild'`, `channel_id='channel'` — i.e. a full exact scope that
    disagrees with the capture lane's `agent` and fills its NULL fields. That
    disagreement is the whole defect.
    """
    return request_payload(
        operation,
        distilled=True,
        summary=(
            "Lane B authored the red-first proof for #724 item 4; no fix applied."
        ),
    )


@pytest.mark.parametrize("operation", ["wrap", "checkpoint"])
def test_wrap_adopts_an_existing_capture_lane_scope(operation: str) -> None:
    """Post-fix: the write lands instead of failing on scope mismatch."""
    transport = _transport_with_capture_lane()

    output = execute_json(_wrap_request(operation), transport=transport)

    receipt = output["receipt"]
    assert receipt["operation"] == operation
    assert receipt["status"] == "saved", receipt.get("error")
    assert receipt["durable"] is True


@pytest.mark.parametrize("operation", ["wrap", "checkpoint"])
def test_wrap_session_start_binds_on_session_key_and_namespace_only(
    operation: str,
) -> None:
    """Post-fix: session_start for a wrap claims no exact-scope coordinates.

    The caller owns `session_key` (and, through its token, the namespace). It
    does NOT own `agent`/`platform`/`server_id`/`channel_id` for a lane another
    process opened, so it must not assert them — asserting them is what trips
    the server's one-way fill.
    """
    transport = _transport_with_capture_lane()

    execute_json(_wrap_request(operation), transport=transport)

    starts = [
        call["params"]["arguments"]
        for call in tool_calls(transport)
        if call["params"]["name"] == "session_start"
    ]
    assert starts, "wrap did not reach session_start"
    claimed = starts[-1]
    assert claimed["session_key"] == SESSION_KEY
    for owned_by_the_lane in ("agent", "platform", "server_id", "channel_id"):
        assert claimed.get(owned_by_the_lane) is None, (
            f"session_start for a {operation} claimed {owned_by_the_lane!r}, "
            "which belongs to the existing lane"
        )


@pytest.mark.parametrize("operation", ["wrap", "checkpoint"])
def test_wrap_writes_under_the_lanes_stored_scope(operation: str) -> None:
    """Post-fix: the write verb carries the LANE's scope, not the requester's.

    Adoption is not "send nothing" — the wrap/checkpoint tool call still has to
    satisfy the server's lane-scope predicate, and the only scope that can
    satisfy it is the one already stored on the lane.
    """
    transport = _transport_with_capture_lane()

    execute_json(_wrap_request(operation), transport=transport)

    writes = [
        call["params"]["arguments"]
        for call in tool_calls(transport)
        if call["params"]["name"] == "session_wrap"
    ]
    assert writes, f"{operation} did not reach session_wrap"
    sent = writes[-1]
    assert sent["agent"] == CAPTURE_AGENT
    assert sent.get("platform") is None
    assert sent.get("server_id") is None
    assert sent.get("channel_id") is None


def test_capture_lane_scope_is_not_rewritten_by_a_wrap() -> None:
    """Adoption must never re-point the lane — the isolation boundary holds."""
    transport = _transport_with_capture_lane()

    execute_json(_wrap_request("wrap"), transport=transport)

    lane = transport.started_sessions[SESSION_KEY]
    assert lane["agent"] == CAPTURE_AGENT
    assert lane["source"] is None
    assert lane["channel_id"] is None
    assert lane["metadata"]["server_id"] is None
