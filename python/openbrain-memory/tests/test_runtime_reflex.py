"""Functional tests for the first-class reflex-pointer runtime operation."""

from __future__ import annotations

from typing import Any

from openbrain_memory import FirstClassMemoryRuntime, ReceiptStatus
from openbrain_memory.cli import execute_json

from ._runtime_fakes import (
    FakeRunner,
    LaneAwareTransport,
    ReflexClient,
    StartThenFailClient,
    request_payload,
    runtime_config,
    runtime_scope,
    tool_calls,
)


def test_reflex_sends_exact_scope_query_and_bounded_budget() -> None:
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), transport=transport
    )

    output = runtime.reflex(
        "how does spool replay work",
        max_tokens=400,
        max_latency_ms=250,
    )

    assert output.receipt.operation == "reflex"
    assert output.receipt.status is ReceiptStatus.DIRECT
    assert output.result is not None
    assert output.result["schema"] == "openbrain.agent_reflex_pointers.v1"
    # A reflex is a read: the receipt is content-free (no durable claim, no body).
    assert output.receipt.durable is False
    assert "context" not in output.as_dict()

    calls = tool_calls(transport)
    assert [call["params"]["name"] for call in calls] == [
        "get_contract",
        "agent_reflex_pointers",
    ]
    assert calls[1]["params"]["arguments"] == {
        "agent": "bilby",
        "platform": "discord",
        "server_id": "guild-1",
        "channel_id": "channel-2",
        "thread_id": "thread-3",
        "session_key": "repo/session-4",
        "query": "how does spool replay work",
        "budget": {"max_tokens": 400, "max_latency_ms": 250},
    }
    # The reflex is namespace-free on the wire; the server derives it from auth.
    assert "namespace" not in calls[1]["params"]["arguments"]


def test_reflex_binds_auth_headers_through_existing_transport() -> None:
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), transport=transport
    )

    runtime.reflex("auth binding")

    call_request = next(
        request
        for request in transport.requests
        if request["json"].get("method") == "tools/call"
    )
    assert call_request["headers"]["Authorization"] == "Bearer unit-test-token"
    assert call_request["headers"]["X-Agent-Id"] == "bilby"
    assert "X-Namespace" not in call_request["headers"]


def test_reflex_forwards_body_free_prior_context_references() -> None:
    client = ReflexClient()
    runtime = FirstClassMemoryRuntime(runtime_config(), runtime_scope(), client=client)

    output = runtime.reflex(
        "net-new pointers only",
        prior_context=[
            {"citation_id": "cit-1"},
            {
                "source_ref": {
                    "source": "thoughts",
                    "type": "thought",
                    "id": "abc",
                    "namespace": "bilby",
                }
            },
            {"source_ref": "session_event:abc"},
        ],
    )

    assert output.receipt.status is ReceiptStatus.DIRECT
    prior_context = client.observed_arguments[-1]["prior_context"]
    assert prior_context == [
        {"citation_id": "cit-1"},
        {
            "source_ref": {
                "source": "thoughts",
                "type": "thought",
                "id": "abc",
                "namespace": "bilby",
            }
        },
        {"source_ref": "session_event:abc"},
    ]


def test_reflex_rejects_body_bearing_prior_context_before_transport() -> None:
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), transport=transport
    )

    body_bearing = runtime.reflex(
        "hostile prior context",
        prior_context=[{"citation_id": "cit-1", "body": "raw remembered text"}],
    )
    raw_text = runtime.reflex(
        "raw text prior context",
        prior_context=["a whole remembered paragraph"],
    )
    missing_identity = runtime.reflex(
        "identity-free prior context",
        prior_context=[{}],
    )

    for rejected in (body_bearing, raw_text, missing_identity):
        assert rejected.receipt.status is ReceiptStatus.FAILED
    # No reflex reached the transport; only rejections happened locally.
    assert tool_calls(transport) == []


def test_reflex_rejects_secret_like_extra_prior_context_field() -> None:
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), transport=transport
    )

    rejected = runtime.reflex(
        "secret-like extra field",
        prior_context=[{"citation_id": "cit-1", "token": "sk-secret-value"}],
    )

    assert rejected.receipt.status is ReceiptStatus.FAILED
    assert rejected.receipt.error is not None
    assert "sk-secret-value" not in (rejected.receipt.error or "")
    assert tool_calls(transport) == []


def test_reflex_rejects_schema_invalid_budget_before_transport() -> None:
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), transport=transport
    )

    low = runtime.reflex("query", max_tokens=99)
    high_latency = runtime.reflex("query", max_latency_ms=100_000)

    assert low.receipt.status is ReceiptStatus.FAILED
    assert high_latency.receipt.status is ReceiptStatus.FAILED
    assert tool_calls(transport) == []


def test_reflex_rejects_server_oversize_query_and_prior_identities() -> None:
    transport = LaneAwareTransport()
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), transport=transport
    )

    outputs = [
        runtime.reflex("q" * 4_001),
        runtime.reflex("query", prior_context=[{"citation_id": "c" * 501}]),
        runtime.reflex("query", prior_context=[{"source_ref": "r" * 1_001}]),
        runtime.reflex(
            "query",
            prior_context=[
                {
                    "source_ref": {
                        "source": "s" * 201,
                        "type": "thought",
                        "id": "id",
                    }
                }
            ],
        ),
        runtime.reflex(
            "query",
            prior_context=[
                {
                    "source_ref": {
                        "source": "thoughts",
                        "type": "thought",
                        "id": "i" * 501,
                    }
                }
            ],
        ),
        runtime.reflex(
            "query",
            prior_context=[
                {
                    "source_ref": {
                        "source": "thoughts",
                        "type": "thought",
                        "id": "id",
                        "namespace": "n" * 201,
                    }
                }
            ],
        ),
    ]

    assert all(output.receipt.status is ReceiptStatus.FAILED for output in outputs)
    assert tool_calls(transport) == []


def test_reflex_rejects_exact_scope_mismatch_from_server() -> None:
    class WrongScopeClient(StartThenFailClient):
        def agent_reflex_pointers(self, **arguments: Any) -> dict[str, Any]:
            return {
                "schema": "openbrain.agent_reflex_pointers.v1",
                "status": "ok",
                "scope": {
                    "namespace": "bilby",
                    "session_key": arguments["session_key"],
                    "agent": arguments["agent"],
                    "platform": arguments["platform"],
                    "server_id": arguments["server_id"],
                    "channel_id": "hijacked-channel",
                    "thread_id": arguments.get("thread_id"),
                },
                "pointers": {"label": "pointers", "items": [], "item_count": 0},
                "warnings": {},
                "budget": {},
                "citations": [],
                "query": arguments["query"],
            }

    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), client=WrongScopeClient()
    )

    output = runtime.reflex("scope proof required")

    assert output.receipt.status is ReceiptStatus.FAILED
    assert output.result == {}


def test_reflex_rejects_wrong_envelope_schema_from_server() -> None:
    class WrongSchemaClient(StartThenFailClient):
        def agent_reflex_pointers(self, **arguments: Any) -> dict[str, Any]:
            return {
                "schema": "openbrain.agent_context_pack.v1",
                "scope": {
                    "namespace": "bilby",
                    "session_key": arguments["session_key"],
                    "agent": arguments["agent"],
                    "platform": arguments["platform"],
                    "server_id": arguments["server_id"],
                    "channel_id": arguments["channel_id"],
                    "thread_id": arguments.get("thread_id"),
                },
            }

    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), client=WrongSchemaClient()
    )

    output = runtime.reflex("wrong envelope")

    assert output.receipt.status is ReceiptStatus.FAILED
    assert output.result == {}


def test_reflex_redacts_raw_remote_error_and_never_falls_back() -> None:
    runner = FakeRunner()
    runtime = FirstClassMemoryRuntime(
        # Fallback is enabled, yet a reflex must never route through it: a read
        # is direct-only and never spools or reads through mcp2cli.
        runtime_config(fallback_enabled=True),
        runtime_scope(),
        client=StartThenFailClient(),
        fallback_runner=runner,
    )

    output = runtime.reflex("remote failure")

    assert output.receipt.status is ReceiptStatus.FAILED
    assert output.receipt.fallback_attempted is False
    assert output.receipt.error is not None
    assert "secret-value" not in (output.receipt.error or "")
    # The mcp2cli fallback runner was never invoked for the read.
    assert runner.calls == []


def test_reflex_cli_returns_validated_envelope_with_content_free_receipt() -> None:
    transport = LaneAwareTransport()

    output = execute_json(
        request_payload(
            "reflex",
            query="cli reflex",
            prior_context=[{"citation_id": "cit-1"}],
        ),
        transport=transport,
    )

    assert output["receipt"]["operation"] == "reflex"
    assert output["receipt"]["status"] == "direct"
    assert output["receipt"]["durable"] is False
    assert output["result"]["schema"] == "openbrain.agent_reflex_pointers.v1"
    assert "context" not in output


def test_reflex_cli_rejects_unsupported_and_body_bearing_input() -> None:
    transport = LaneAwareTransport()

    unsupported_key = execute_json(
        request_payload("reflex", query="cli reflex", requested_sections=["pointers"]),
        transport=transport,
    )
    body_bearing = execute_json(
        request_payload(
            "reflex",
            query="cli reflex",
            prior_context=[{"citation_id": "cit-1", "body": "raw text"}],
        ),
        transport=transport,
    )
    non_object_reference = execute_json(
        request_payload("reflex", query="cli reflex", prior_context=["raw text"]),
        transport=transport,
    )

    assert unsupported_key["receipt"]["status"] == "failed"
    assert body_bearing["receipt"]["status"] == "failed"
    assert non_object_reference["receipt"]["status"] == "failed"
    assert tool_calls(transport) == []
