"""Functional tests for the first-class reflex-pointer runtime operation."""

from __future__ import annotations

import json
from typing import Any

from openbrain_memory import FirstClassMemoryRuntime, ReceiptStatus
from openbrain_memory.cli import execute_json

from ._runtime_fakes import (
    EnvelopeReflexClient,
    FakeRunner,
    LaneAwareTransport,
    ReflexClient,
    ReflexContractGapTransport,
    StartThenFailClient,
    request_payload,
    runtime_config,
    runtime_scope,
    tool_calls,
)


def _reflex_tool_calls(transport: LaneAwareTransport) -> list[dict[str, Any]]:
    return [
        call
        for call in tool_calls(transport)
        if call["params"]["name"] == "agent_reflex_pointers"
    ]


_POINTER_ID = "11111111-1111-4111-8111-111111111111"
_POINTER_CITATION_ID = f"brain_record:thought:{_POINTER_ID}"
_POINTER_SOURCE_REF = {
    "source": "brain",
    "type": "thought",
    "id": _POINTER_ID,
    "namespace": "bilby",
}


def _server_reflex_envelope(arguments: dict[str, Any]) -> dict[str, Any]:
    """A valid server-shaped v1 reflex envelope with one cited pointer item."""
    return {
        "schema": "openbrain.agent_reflex_pointers.v1",
        "status": "ok",
        "placement": "client_owned",
        "resolvable_reference_only": True,
        "scope": {
            "namespace": "bilby",
            "namespace_source": "authorization",
            "session_key": arguments["session_key"],
            "agent": arguments["agent"],
            "platform": arguments["platform"],
            "server_id": arguments["server_id"],
            "channel_id": arguments["channel_id"],
            "thread_id": arguments.get("thread_id"),
        },
        "pointers": {
            "label": "pointers",
            "namespace_scoped": True,
            "resolvable_reference_only": True,
            "items": [
                {
                    "id": _POINTER_ID,
                    "source_type": "thought",
                    "namespace": "bilby",
                    "tier": None,
                    "created_at": "2026-07-01T00:00:00.000Z",
                    "updated_at": None,
                    "citation_id": _POINTER_CITATION_ID,
                    "source_ref": dict(_POINTER_SOURCE_REF),
                }
            ],
            "item_count": 1,
            "truncated": False,
        },
        "warnings": {"scope_denials": [], "degraded_sources": [], "truncation": []},
        "budget": {"requested": None},
        "citations": [
            {
                "kind": "pointer",
                "id": _POINTER_CITATION_ID,
                "source_ref": dict(_POINTER_SOURCE_REF),
            }
        ],
        "query": arguments["query"],
    }


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
    assert output.receipt.error == "reflex_result_invalid"
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
    assert output.receipt.error == "reflex_result_invalid"
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


# --- Finding #1: reflex requires the published contract tool version ---------


def test_reflex_never_dispatches_when_contract_omits_reflex_capability() -> None:
    for mode in ("omit_capability", "omit_tool_contract", "wrong_version"):
        transport = ReflexContractGapTransport(mode=mode)
        runtime = FirstClassMemoryRuntime(
            runtime_config(), runtime_scope(), transport=transport
        )

        output = runtime.reflex("contract must prove the reflex")

        # No reflex dispatch happened: the contract gate rejected the runtime
        # before any agent_reflex_pointers call could reach the transport.
        assert _reflex_tool_calls(transport) == [], mode
        # The receipt is a content-free FAILED read: no durable claim, no body.
        assert output.receipt.status is ReceiptStatus.FAILED, mode
        assert output.receipt.durable is False, mode
        assert output.result == {}, mode
        serialized = json.dumps(output.as_dict())
        assert "how does spool" not in serialized, mode


def test_reflex_never_dispatches_when_contract_reflex_version_malformed() -> None:
    transport = ReflexContractGapTransport(mode="malformed_version")
    runtime = FirstClassMemoryRuntime(
        runtime_config(), runtime_scope(), transport=transport
    )

    output = runtime.reflex("malformed reflex version")

    assert _reflex_tool_calls(transport) == []
    assert output.receipt.status is ReceiptStatus.FAILED
    assert output.result == {}


# --- Finding #2: reflex result is validated and projected, never raw ---------


def test_reflex_projects_valid_server_envelope_into_body_free_result() -> None:
    scope = runtime_scope()
    envelope = _server_reflex_envelope(
        {
            "session_key": scope.session_key,
            "agent": scope.agent,
            "platform": scope.platform,
            "server_id": scope.server_id,
            "channel_id": scope.channel_id,
            "thread_id": scope.thread_id,
            "query": "valid envelope",
        }
    )
    runtime = FirstClassMemoryRuntime(
        runtime_config(), scope, client=EnvelopeReflexClient(envelope)
    )

    output = runtime.reflex("valid envelope")

    assert output.receipt.status is ReceiptStatus.DIRECT
    result = output.result
    assert result is not None
    assert result["schema"] == "openbrain.agent_reflex_pointers.v1"
    assert result["placement"] == "client_owned"
    assert result["resolvable_reference_only"] is True
    assert result["status"] == "ok"
    assert "query" not in result

    pointers = result["pointers"]
    assert pointers["label"] == "pointers"
    assert pointers["namespace_scoped"] is True
    assert pointers["resolvable_reference_only"] is True
    assert pointers["item_count"] == 1
    assert pointers["truncated"] is False
    item = pointers["items"][0]
    assert set(item) == {
        "id",
        "source_type",
        "namespace",
        "tier",
        "created_at",
        "updated_at",
        "citation_id",
        "source_ref",
    }
    assert set(item["source_ref"]) == {"source", "type", "id", "namespace"}

    citations = result["citations"]
    assert [citation["kind"] for citation in citations] == ["pointer"]
    # Bijection: every emitted pointer's citation_id is exactly the citation set.
    assert {p["citation_id"] for p in pointers["items"]} == {c["id"] for c in citations}
    assert set(result["warnings"]) == {
        "scope_denials",
        "degraded_sources",
        "truncation",
    }


def test_reflex_projects_away_body_and_unknown_pointer_fields() -> None:
    scope = runtime_scope()
    envelope = _server_reflex_envelope(
        {
            "session_key": scope.session_key,
            "agent": scope.agent,
            "platform": scope.platform,
            "server_id": scope.server_id,
            "channel_id": scope.channel_id,
            "thread_id": scope.thread_id,
            "query": "hostile envelope",
        }
    )
    # A hostile server tries to smuggle a raw body and an unknown display field
    # onto the pointer item, and an arbitrary nested value onto the envelope.
    envelope["pointers"]["items"][0]["content"] = "raw remembered secret body"
    envelope["pointers"]["items"][0]["preview"] = "leaked preview"
    envelope["injected_top_level"] = {"nested": "arbitrary server payload"}
    runtime = FirstClassMemoryRuntime(
        runtime_config(), scope, client=EnvelopeReflexClient(envelope)
    )

    output = runtime.reflex("hostile envelope")

    # A body-bearing pointer item is a hard invariant break: fail closed.
    assert output.receipt.status is ReceiptStatus.FAILED
    assert output.result == {}
    serialized = json.dumps(output.as_dict())
    assert "raw remembered secret body" not in serialized
    assert "leaked preview" not in serialized
    assert "arbitrary server payload" not in serialized


def test_reflex_result_projection_strips_unknown_top_level_and_warning_fields() -> None:
    scope = runtime_scope()
    envelope = _server_reflex_envelope(
        {
            "session_key": scope.session_key,
            "agent": scope.agent,
            "platform": scope.platform,
            "server_id": scope.server_id,
            "channel_id": scope.channel_id,
            "thread_id": scope.thread_id,
            "query": "extra fields",
        }
    )
    # An unknown top-level envelope key must never survive projection; a warning
    # entry carrying an arbitrary nested body must be reduced to its content-free
    # scalar markers only.
    envelope["memory_bodies"] = ["a whole remembered paragraph"]
    envelope["warnings"]["degraded_sources"] = [
        {"source": "durable_memory", "reason": "recall_failed", "body": "leak"}
    ]
    runtime = FirstClassMemoryRuntime(
        runtime_config(), scope, client=EnvelopeReflexClient(envelope)
    )

    output = runtime.reflex("extra fields")

    assert output.receipt.status is ReceiptStatus.DIRECT
    result = output.result
    assert result is not None
    assert set(result) == {
        "schema",
        "status",
        "placement",
        "resolvable_reference_only",
        "scope",
        "pointers",
        "warnings",
        "budget",
        "citations",
    }
    assert "memory_bodies" not in result
    degraded = result["warnings"]["degraded_sources"][0]
    assert degraded == {"source": "durable_memory", "reason": "recall_failed"}
    serialized = json.dumps(output.as_dict())
    assert "a whole remembered paragraph" not in serialized
    assert "leak" not in serialized


def test_reflex_rejects_private_text_in_known_warning_fields() -> None:
    scope = runtime_scope()
    envelope = _server_reflex_envelope(
        {
            "session_key": scope.session_key,
            "agent": scope.agent,
            "platform": scope.platform,
            "server_id": scope.server_id,
            "channel_id": scope.channel_id,
            "thread_id": scope.thread_id,
            "query": "hostile warning",
        }
    )
    private_reason = "customer note alpha omega"
    envelope["warnings"]["degraded_sources"] = [
        {"source": "durable_memory", "reason": private_reason}
    ]
    runtime = FirstClassMemoryRuntime(
        runtime_config(), scope, client=EnvelopeReflexClient(envelope)
    )

    output = runtime.reflex("hostile warning")

    assert output.receipt.status is ReceiptStatus.FAILED
    assert output.receipt.error == "reflex_result_invalid"
    assert output.result == {}
    assert private_reason not in json.dumps(output.as_dict())


def test_reflex_rejects_private_text_in_known_scalar_channels() -> None:
    scope = runtime_scope()
    arguments = {
        "session_key": scope.session_key,
        "agent": scope.agent,
        "platform": scope.platform,
        "server_id": scope.server_id,
        "channel_id": scope.channel_id,
        "thread_id": scope.thread_id,
        "query": "known scalar validation",
    }
    sentinel = "private-customer-note-alpha-omega"

    wrong_query = _server_reflex_envelope(arguments)
    wrong_query["query"] = sentinel

    wrong_namespace_source = _server_reflex_envelope(arguments)
    wrong_namespace_source["scope"]["namespace_source"] = sentinel

    wrong_tier = _server_reflex_envelope(arguments)
    wrong_tier["pointers"]["items"][0]["tier"] = sentinel

    wrong_empty_reason = _server_reflex_envelope(arguments)
    wrong_empty_reason["pointers"]["items"] = []
    wrong_empty_reason["pointers"]["item_count"] = 0
    wrong_empty_reason["pointers"]["empty_reason"] = sentinel
    wrong_empty_reason["citations"] = []

    for envelope in (
        wrong_query,
        wrong_namespace_source,
        wrong_tier,
        wrong_empty_reason,
    ):
        runtime = FirstClassMemoryRuntime(
            runtime_config(), scope, client=EnvelopeReflexClient(envelope)
        )
        output = runtime.reflex("known scalar validation")
        assert output.receipt.status is ReceiptStatus.FAILED
        assert output.receipt.error == "reflex_result_invalid"
        assert output.result == {}
        assert sentinel not in json.dumps(output.as_dict())


def test_reflex_binds_pointer_and_citation_reference_identity() -> None:
    scope = runtime_scope()
    arguments = {
        "session_key": scope.session_key,
        "agent": scope.agent,
        "platform": scope.platform,
        "server_id": scope.server_id,
        "channel_id": scope.channel_id,
        "thread_id": scope.thread_id,
        "query": "reference binding",
    }
    other_id = "22222222-2222-4222-8222-222222222222"

    foreign_pointer = _server_reflex_envelope(arguments)
    foreign_pointer["pointers"]["items"][0]["namespace"] = "foreign"

    foreign_source_ref = _server_reflex_envelope(arguments)
    foreign_source_ref["pointers"]["items"][0]["source_ref"]["namespace"] = "foreign"

    mismatched_pointer_ref = _server_reflex_envelope(arguments)
    mismatched_pointer_ref["pointers"]["items"][0]["source_ref"]["id"] = other_id

    mismatched_citation_ref = _server_reflex_envelope(arguments)
    mismatched_citation_ref["citations"][0]["source_ref"]["id"] = other_id

    for envelope in (
        foreign_pointer,
        foreign_source_ref,
        mismatched_pointer_ref,
        mismatched_citation_ref,
    ):
        runtime = FirstClassMemoryRuntime(
            runtime_config(), scope, client=EnvelopeReflexClient(envelope)
        )
        output = runtime.reflex("reference binding")
        assert output.receipt.status is ReceiptStatus.FAILED
        assert output.receipt.error == "reflex_result_invalid"
        assert output.result == {}


def test_reflex_rejects_sentence_shaped_pointer_namespace_scalar() -> None:
    scope = runtime_scope()
    arguments = {
        "session_key": scope.session_key,
        "agent": scope.agent,
        "platform": scope.platform,
        "server_id": scope.server_id,
        "channel_id": scope.channel_id,
        "thread_id": scope.thread_id,
        "query": "namespace scalar",
    }
    sentinel = "private customer note alpha omega"
    envelope = _server_reflex_envelope(arguments)
    envelope["pointers"]["items"][0]["namespace"] = sentinel
    envelope["pointers"]["items"][0]["source_ref"]["namespace"] = sentinel
    envelope["citations"][0]["source_ref"]["namespace"] = sentinel
    runtime = FirstClassMemoryRuntime(
        runtime_config(), scope, client=EnvelopeReflexClient(envelope)
    )

    output = runtime.reflex("namespace scalar")

    assert output.receipt.status is ReceiptStatus.FAILED
    assert output.receipt.error == "reflex_result_invalid"
    assert output.result == {}
    assert sentinel not in json.dumps(output.as_dict())


def test_reflex_accepts_authorized_shared_namespace_pointer_identity() -> None:
    scope = runtime_scope()
    arguments = {
        "session_key": scope.session_key,
        "agent": scope.agent,
        "platform": scope.platform,
        "server_id": scope.server_id,
        "channel_id": scope.channel_id,
        "thread_id": scope.thread_id,
        "query": "shared pointer",
    }
    envelope = _server_reflex_envelope(arguments)
    envelope["pointers"]["items"][0]["namespace"] = "shared-kb"
    envelope["pointers"]["items"][0]["source_ref"]["namespace"] = "shared-kb"
    envelope["citations"][0]["source_ref"]["namespace"] = "shared-kb"
    runtime = FirstClassMemoryRuntime(
        runtime_config(), scope, client=EnvelopeReflexClient(envelope)
    )

    output = runtime.reflex("shared pointer")

    assert output.receipt.status is ReceiptStatus.DIRECT
    assert output.result is not None
    pointer = output.result["pointers"]["items"][0]
    assert pointer["namespace"] == "shared-kb"
    assert pointer["source_ref"]["namespace"] == "shared-kb"
    assert output.result["citations"][0]["source_ref"]["namespace"] == "shared-kb"


def test_reflex_rejects_duplicate_or_unbounded_allocation_order() -> None:
    scope = runtime_scope()
    arguments = {
        "session_key": scope.session_key,
        "agent": scope.agent,
        "platform": scope.platform,
        "server_id": scope.server_id,
        "channel_id": scope.channel_id,
        "thread_id": scope.thread_id,
        "query": "allocation order",
    }
    duplicate = _server_reflex_envelope(arguments)
    duplicate["budget"] = {
        "whole_pack": {
            "content_char_limit": 100,
            "content_chars_used": 50,
            "allocation_order": ["pointers", "pointers"],
        }
    }
    amplified = _server_reflex_envelope(arguments)
    amplified["budget"] = {
        "whole_pack": {
            "content_char_limit": 100,
            "content_chars_used": 50,
            "allocation_order": ["pointers"] * 10_001,
        }
    }

    for envelope in (duplicate, amplified):
        runtime = FirstClassMemoryRuntime(
            runtime_config(), scope, client=EnvelopeReflexClient(envelope)
        )
        output = runtime.reflex("allocation order")
        assert output.receipt.status is ReceiptStatus.FAILED
        assert output.receipt.error == "reflex_result_invalid"
        assert output.result == {}


def test_reflex_rejects_broken_citation_bijection() -> None:
    scope = runtime_scope()
    envelope = _server_reflex_envelope(
        {
            "session_key": scope.session_key,
            "agent": scope.agent,
            "platform": scope.platform,
            "server_id": scope.server_id,
            "channel_id": scope.channel_id,
            "thread_id": scope.thread_id,
            "query": "bad bijection",
        }
    )
    # The lone citation references a different id than the emitted pointer item.
    envelope["citations"][0]["id"] = "cit-does-not-match"
    runtime = FirstClassMemoryRuntime(
        runtime_config(), scope, client=EnvelopeReflexClient(envelope)
    )

    output = runtime.reflex("bad bijection")

    assert output.receipt.status is ReceiptStatus.FAILED
    assert output.result == {}


def test_reflex_rejects_broken_pointer_invariants() -> None:
    scope = runtime_scope()
    args = {
        "session_key": scope.session_key,
        "agent": scope.agent,
        "platform": scope.platform,
        "server_id": scope.server_id,
        "channel_id": scope.channel_id,
        "thread_id": scope.thread_id,
        "query": "bad invariants",
    }

    wrong_count = _server_reflex_envelope(args)
    wrong_count["pointers"]["item_count"] = 5

    wrong_label = _server_reflex_envelope(args)
    wrong_label["pointers"]["label"] = "not-pointers"

    not_scoped = _server_reflex_envelope(args)
    not_scoped["pointers"]["namespace_scoped"] = False

    wrong_kind = _server_reflex_envelope(args)
    wrong_kind["citations"][0]["kind"] = "durable"

    for hostile in (wrong_count, wrong_label, not_scoped, wrong_kind):
        runtime = FirstClassMemoryRuntime(
            runtime_config(), scope, client=EnvelopeReflexClient(hostile)
        )
        output = runtime.reflex("bad invariants")
        assert output.receipt.status is ReceiptStatus.FAILED
        assert output.result == {}


# --- Finding #3: reflex failure receipt error is a stable content-free label -


def test_reflex_failure_receipt_error_is_stable_category_without_sentinel() -> None:
    sentinel = "private-sentinel-9f3c-not-a-secret"

    class SentinelReflexClient(StartThenFailClient):
        def agent_reflex_pointers(self, **arguments: Any) -> dict[str, Any]:
            raise RuntimeError(f"reflex dispatch exploded: {sentinel}")

    runtime = FirstClassMemoryRuntime(
        runtime_config(fallback_enabled=True),
        runtime_scope(),
        client=SentinelReflexClient(),
        fallback_runner=FakeRunner(),
    )

    output = runtime.reflex("sentinel must not leak")

    assert output.receipt.status is ReceiptStatus.FAILED
    # The category is stable and content-free; it never echoes exception text.
    assert output.receipt.error == "reflex_dispatch_failed"
    # Truthful flags: the read never fell back to mcp2cli.
    assert output.receipt.direct_attempted is True
    assert output.receipt.fallback_attempted is False
    assert output.result == {}
    # The sentinel is absent from the complete serialized output.
    serialized = json.dumps(output.as_dict())
    assert sentinel not in serialized


def test_reflex_result_projection_failure_uses_stable_result_category() -> None:
    sentinel = "hostile-envelope-sentinel-not-a-secret"
    scope = runtime_scope()
    envelope = _server_reflex_envelope(
        {
            "session_key": scope.session_key,
            "agent": scope.agent,
            "platform": scope.platform,
            "server_id": scope.server_id,
            "channel_id": scope.channel_id,
            "thread_id": scope.thread_id,
            "query": "hostile projection",
        }
    )
    # A hostile server smuggles a sentinel-bearing unknown field onto a pointer.
    envelope["pointers"]["items"][0]["leaked_field"] = sentinel
    runtime = FirstClassMemoryRuntime(
        runtime_config(), scope, client=EnvelopeReflexClient(envelope)
    )

    output = runtime.reflex("hostile projection")

    assert output.receipt.status is ReceiptStatus.FAILED
    assert output.receipt.error == "reflex_result_invalid"
    assert output.result == {}
    serialized = json.dumps(output.as_dict())
    assert sentinel not in serialized
