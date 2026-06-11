from __future__ import annotations

import pytest

from openbrain_memory import (
    AgentMemory,
    MemoryClient,
    MemoryContext,
    MemoryItem,
    MemoryPolicy,
    MemorySpool,
    OpenBrainClient,
)


class FakeClient:
    def __init__(self) -> None:
        self.calls = []
        self.search_payload = {
            "results": [
                {
                    "text": "First useful fact about the project.",
                    "source": "brain",
                    "kind": "fact",
                    "score": 0.9,
                },
                {
                    "content": "Decision context that should be included.",
                    "source": "brain",
                    "kind": "decision",
                    "score": 0.8,
                },
                {"text": "This item exceeds the item count bound."},
            ]
        }

    def _record(self, name, arguments):
        self.calls.append((name, arguments))
        return {"tool": name, "arguments": arguments}

    def session_start(self, **arguments):
        return self._record("session_start", arguments)

    def append_session_event(self, **arguments):
        return self._record("append_session_event", arguments)

    def search_all(self, **arguments):
        self.calls.append(("search_all", arguments))
        return self.search_payload

    def log_thought(self, **arguments):
        return self._record("log_thought", arguments)

    def log_decision(self, **arguments):
        return self._record("log_decision", arguments)

    def session_wrap(self, **arguments):
        return self._record("session_wrap", arguments)


def test_start_session_records_runtime_agnostic_conversation_key():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby", project="open-brain")

    result = memory.start_session("project/session", topic="client facade")

    assert result["tool"] == "session_start"
    assert client.calls == [
        (
            "session_start",
            {
                "topic": "client facade",
                "agent": "bilby",
                "project": "open-brain",
                "session_key": "project/session",
            },
        )
    ]


def test_append_event_routes_to_session_event_wrapper():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")
    memory.start_session("conversation")

    memory.append_event("assistant", "Here is the update.", event_type="action", turn=3)

    name, payload = client.calls[-1]
    assert name == "append_session_event"
    assert payload["event_type"] == "action"
    assert payload["content"] == "Here is the update."
    assert payload["source"] == "assistant"
    assert payload["metadata"]["turn"] == 3
    assert payload["metadata"]["idempotency_key"].startswith("obmem-")
    assert payload["session_key"] == "conversation"


def test_remember_fact_routes_to_thought_memory_write_semantics():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby", project="open-brain")
    memory.start_session("conversation")

    memory.remember_fact("The client uses MCP-over-HTTP.", tags=["client"])

    name, payload = client.calls[-1]
    assert name == "log_thought"
    assert payload["content"] == "The client uses MCP-over-HTTP."
    assert payload["tags"][:2] == ["fact", "client"]
    assert payload["tags"][2].startswith("idempotency:obmem-")


def test_remember_decision_routes_to_decision_logging_semantics():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")

    memory.remember_decision("Use OpenBrainClient wrappers, not raw protocol calls.")

    assert client.calls[0][0] == "log_decision"
    assert client.calls[0][1]["title"] == "Use OpenBrainClient wrappers, not raw protocol calls."
    assert client.calls[0][1]["rationale"] == "Use OpenBrainClient wrappers, not raw protocol calls."
    assert client.calls[0][1]["tags"][0].startswith("idempotency:obmem-")


def test_recall_assembles_bounded_prompt_context():
    client = FakeClient()
    memory = AgentMemory(
        client,
        agent="bilby",
        project="open-brain",
        policy=MemoryPolicy(max_items=2, max_chars=200, max_item_chars=80),
    )
    memory.start_session("conversation")

    context = memory.recall("client facade", limit=10)

    assert client.calls[-1] == (
        "search_all",
            {
                "query": "client facade",
                "limit": 2,
                "sources": "brain",
            },
        )
    assert len(context.items) == 2
    assert context.items[0].text == "First useful fact about the project."
    assert context.items[1].text == "Decision context that should be included."
    assert context.as_prompt_text() == (
        "- [fact/brain] First useful fact about the project.\n"
        "- [decision/brain] Decision context that should be included."
    )
    assert context.raw == {}


def test_recall_can_exclude_fact_and_decision_classes():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")

    memory.recall("narrow", include_decisions=False, include_facts=False)

    assert client.calls[-1] == (
        "search_all",
        {
            "query": "narrow",
            "limit": 8,
            "sources": "qmd",
        },
    )


def test_checkpoint_and_wrap_use_session_tools():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")
    memory.start_session("conversation")

    memory.checkpoint("Mid-run checkpoint.", key_decisions=["Use wrapper facade"])
    memory.wrap_session("Done.", next_steps=["Open PR"])

    assert client.calls[-2:] == [
        (
            "session_wrap",
            {
                "summary": "Mid-run checkpoint.",
                "key_decisions": ["Use wrapper facade"],
                "session_key": "conversation",
            },
        ),
        (
            "session_wrap",
            {
                "next_steps": ["Open PR"],
                "summary": "Done.",
                "session_key": "conversation",
            },
        ),
    ]


def test_public_facade_exports_quickstart_types():
    assert AgentMemory
    assert MemoryClient
    assert MemoryContext
    assert MemoryItem
    assert MemoryPolicy
    assert MemorySpool
    assert OpenBrainClient


def test_reserved_metadata_cannot_spoof_identity_or_semantics():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby", project="open-brain")

    with pytest.raises(ValueError, match="reserved keys"):
        memory.start_session("real", session_key="spoofed")

    memory.start_session("real")
    with pytest.raises(ValueError, match="reserved keys"):
        memory.remember_fact("fact", agent="spoofed")
    with pytest.raises(ValueError, match="reserved keys"):
        memory.append_event("assistant", "event", session_key="spoofed")
    with pytest.raises(ValueError, match="reserved keys"):
        memory.append_event("assistant", "event", namespace="spoofed")
    with pytest.raises(ValueError, match="reserved keys"):
        memory.checkpoint("summary", session_key="spoofed")
    with pytest.raises(ValueError, match="reserved authority keys"):
        memory.remember_decision("decision", context={"namespace": "spoofed"})
    with pytest.raises(ValueError, match="reserved authority keys"):
        memory.remember_decision(
            "decision",
            context={"headers": {"X-Namespace": "spoofed"}},
        )
    with pytest.raises(ValueError, match="reserved authority keys"):
        memory.remember_decision("decision", context={"Authorization": "Bearer x"})
    with pytest.raises(ValueError, match="reserved authority keys"):
        memory.append_event("assistant", "event", headers={"X_Namespace": "spoofed"})


def test_nested_semantic_context_can_use_non_authority_names():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")

    memory.remember_decision(
        "decision",
        context={"source": "customer interview", "summary": "plain note"},
        alternatives=[{"title": "Other path", "rationale": "too costly"}],
    )

    assert client.calls[0][1]["context"] == {
        "source": "customer interview",
        "summary": "plain note",
    }


def test_unsupported_metadata_is_rejected_before_tool_calls():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")
    memory.start_session("real")

    with pytest.raises(ValueError, match="unsupported keys"):
        memory.remember_fact("fact", confidence="high")
    with pytest.raises(ValueError, match="unsupported keys"):
        memory.remember_decision("decision", extra="nope")
    with pytest.raises(ValueError, match="unsupported keys"):
        memory.checkpoint("summary", status="green")
    with pytest.raises(ValueError, match="unsupported keys"):
        memory.wrap_session("summary", outcome="merged")


def test_namespace_metadata_is_not_accepted_by_memory_facade():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")

    with pytest.raises(ValueError, match="reserved keys"):
        memory.remember_fact("fact", namespace="other")
    with pytest.raises(ValueError, match="reserved keys"):
        memory.remember_decision("decision", namespace="other")

    assert client.calls == []


def test_session_methods_require_started_session():
    memory = AgentMemory(FakeClient(), agent="bilby")

    with pytest.raises(RuntimeError, match="start_session"):
        memory.append_event("assistant", "event")
    with pytest.raises(RuntimeError, match="start_session"):
        memory.checkpoint("summary")
    with pytest.raises(RuntimeError, match="start_session"):
        memory.wrap_session("summary")


def test_policy_and_limit_bounds_are_validated():
    with pytest.raises(ValueError, match="max_items"):
        MemoryPolicy(max_items=0)
    with pytest.raises(ValueError, match="max_chars"):
        MemoryPolicy(max_chars=0)
    with pytest.raises(ValueError, match="max_item_chars"):
        MemoryPolicy(max_item_chars=0)

    memory = AgentMemory(FakeClient(), agent="bilby")
    with pytest.raises(ValueError, match="limit"):
        memory.recall("bad", limit=0)


def test_prompt_context_respects_total_char_budget_for_first_item():
    client = FakeClient()
    client.search_payload = {"results": [{"text": "x" * 100, "kind": "fact"}]}
    memory = AgentMemory(
        client,
        agent="bilby",
        policy=MemoryPolicy(max_items=3, max_chars=24, max_item_chars=100),
    )

    context = memory.recall("budget")

    assert len(context.as_prompt_text()) <= 24
    assert context.as_prompt_text().endswith("...")


def test_recall_raw_response_is_opt_in_and_bad_shapes_are_empty():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")

    assert memory.recall("default raw").raw == {}
    assert memory.recall("debug raw", include_raw=True).raw is client.search_payload

    client.search_payload = None
    context = memory.recall("bad shape")
    assert context.items == ()
    assert context.as_prompt_text() == ""
