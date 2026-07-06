from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from openbrain_memory import (
    AgentMemory,
    MemoryClient,
    MemoryContext,
    MemoryItem,
    MemoryPolicy,
    MemorySpool,
    OpenBrainClient,
    redact_text,
)
from openbrain_memory.agent import _reject_secret_payload


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

    def session_context(self, **arguments):
        return self._record("session_context", arguments)

    def append_session_event(self, **arguments):
        return self._record("append_session_event", arguments)

    def search_all(self, **arguments):
        self.calls.append(("search_all", arguments))
        return self.search_payload

    def brain_answer(self, **arguments):
        return self._record("brain_answer", arguments)

    def lane_load(self, **arguments):
        return self._record("lane_load", arguments)

    def lane_upsert(self, **arguments):
        return self._record("lane_upsert", arguments)

    def list_repo_facts(self, **arguments):
        return self._record("list_repo_facts", arguments)

    def log_thought(self, **arguments):
        return self._record("log_thought", arguments)

    def log_decision(self, **arguments):
        return self._record("log_decision", arguments)

    def session_wrap(self, **arguments):
        return self._record("session_wrap", arguments)

    def upsert_repo_fact(self, **arguments):
        return self._record("upsert_repo_fact", arguments)


TOOL_SCHEMA_FILES = {
    "append_session_event": "append-session-event.ts",
    "brain_answer": "brain-answer.ts",
    "lane_load": "lane-load.ts",
    "lane_upsert": "lane-upsert.ts",
    "list_repo_facts": "repo-facts.ts",
    "log_decision": "log-decision.ts",
    "log_thought": "log-thought.ts",
    "search_all": "search-all.ts",
    "session_context": "session-context.ts",
    "session_start": "session-start.ts",
    "session_wrap": "session-wrap.ts",
    "upsert_repo_fact": "repo-facts.ts",
}


def server_tool_schema_block(name: str) -> str:
    repo_root = Path(__file__).resolve().parents[3]
    source = repo_root / "src" / "tools" / TOOL_SCHEMA_FILES[name]
    text = source.read_text(encoding="utf-8")
    return text.split("inputSchema:", 1)[1].split("annotations:", 1)[0]


def server_tool_keys(name: str) -> set[str]:
    block = server_tool_schema_block(name)
    return set(
        re.findall(r"^\s{8}([A-Za-z_][A-Za-z0-9_]*)\s*:", block, flags=re.MULTILINE)
    )


def server_required_tool_keys(name: str) -> set[str]:
    block = server_tool_schema_block(name)
    keys = []
    current_key = None
    current_lines = []
    for line in block.splitlines():
        match = re.match(r"^\s{8}([A-Za-z_][A-Za-z0-9_]*)\s*:", line)
        if match:
            if current_key is not None and ".optional()" not in "\n".join(
                current_lines
            ):
                keys.append(current_key)
            current_key = match.group(1)
            current_lines = [line]
            continue
        if current_key is not None:
            current_lines.append(line)
    if current_key is not None and ".optional()" not in "\n".join(current_lines):
        keys.append(current_key)
    return set(keys)


def assert_server_contract_call(name: str, payload: dict) -> None:
    assert set(payload) <= server_tool_keys(name)
    assert server_required_tool_keys(name) <= set(payload)
    for key, value in payload.items():
        if key in {"limit", "offset"}:
            assert isinstance(value, int)
        elif key in {"alternatives", "key_decisions", "next_steps", "tags"}:
            assert isinstance(value, list)
            assert all(isinstance(item, str) for item in value)
        elif key == "metadata":
            assert isinstance(value, dict)
        elif key in {"include_events", "include_raw"}:
            assert isinstance(value, bool)
        elif key in {"event_types"}:
            assert isinstance(value, list)
            assert all(isinstance(item, str) for item in value)
        else:
            assert isinstance(value, str)


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
    assert "project" not in payload
    assert payload["metadata"]["turn"] == 3
    assert payload["metadata"]["idempotency_key"].startswith("obmem-")
    assert payload["session_key"] == "conversation"


def test_candidate_memory_records_user_correction_as_candidate_only_negative_example():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby", project="open-brain")
    memory.start_session("conversation")

    memory.candidate_memory(
        "user",
        "Correction: do not promote share candidates without explicit nomination.",
        event_type="correction",
        candidate_type="negative_example",
        reason="User corrected an unsafe promotion assumption.",
        confidence=0.95,
        scope={"repo": "rodaddy/open-brain"},
        evidence_refs=[
            {"kind": "issue", "url": "https://github.com/rodaddy/open-brain/issues/224"}
        ],
        staleness_policy="Revalidate when promotion lifecycle changes.",
    )

    name, payload = client.calls[-1]
    assert name == "append_session_event"
    assert payload["event_type"] == "correction"
    assert payload["source"] == "user"
    assert payload["metadata"]["memory_lifecycle_action"] == "candidate"
    assert payload["metadata"]["candidate_type"] == "negative_example"
    assert payload["metadata"]["candidate_reason"] == (
        "User corrected an unsafe promotion assumption."
    )
    assert payload["metadata"]["candidate_confidence"] == 0.95
    assert payload["metadata"]["candidate_scope"] == {"repo": "rodaddy/open-brain"}
    assert payload["metadata"]["evidence_refs"] == [
        {"kind": "issue", "url": "https://github.com/rodaddy/open-brain/issues/224"}
    ]
    assert payload["metadata"]["candidate_staleness_policy"] == (
        "Revalidate when promotion lifecycle changes."
    )
    assert "share_candidate" not in payload["metadata"]


def test_nominate_shared_requires_explicit_lifecycle_action():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")
    memory.start_session("conversation")

    memory.nominate_shared(
        "assistant",
        "This reviewed fact is ready for shared nomination.",
        event_type="fact",
        candidate_type="shared_kb_nomination",
        reason="Reviewed fact is suitable for shared-kb nomination.",
    )

    name, payload = client.calls[-1]
    assert name == "append_session_event"
    assert payload["metadata"]["share_candidate"] is True
    assert payload["metadata"]["memory_lifecycle_action"] == "nominate_shared"
    assert payload["metadata"]["candidate_type"] == "shared_kb_nomination"
    assert (
        payload["metadata"]["candidate_reason"]
        == "Reviewed fact is suitable for shared-kb nomination."
    )


def test_lifecycle_helpers_record_promote_relegate_and_discard_actions():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")
    memory.start_session("conversation")

    memory.promote_candidate(
        "assistant",
        "Record promotion approval for reviewed process rule.",
        candidate_type="process_rule",
        reason="User approved this rule for a separate durable write.",
    )
    memory.relegate_candidate(
        "assistant",
        "Keep repo fact local for now.",
        candidate_type="code_repo_fact",
        reason="Useful only in the current repo.",
    )
    memory.discard_candidate(
        "assistant",
        "Discard stale preference.",
        candidate_type="user_preference",
        reason="Superseded by later user correction.",
    )

    lifecycle_payloads = [
        payload["metadata"]
        for name, payload in client.calls
        if name == "append_session_event"
    ]
    assert [item["memory_lifecycle_action"] for item in lifecycle_payloads] == [
        "promote",
        "relegate",
        "discard",
    ]
    assert all("share_candidate" not in item for item in lifecycle_payloads)


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
    assert (
        client.calls[0][1]["title"]
        == "Use OpenBrainClient wrappers, not raw protocol calls."
    )
    assert (
        client.calls[0][1]["rationale"]
        == "Use OpenBrainClient wrappers, not raw protocol calls."
    )
    assert client.calls[0][1]["tags"][0].startswith("idempotency:obmem-")


def test_representative_facade_payloads_match_server_tool_contracts():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby", project="open-brain")

    memory.start_session(
        "conversation", channel_id="c1", thread_id="t1", topic="contract"
    )
    memory.append_event(
        "assistant",
        "event",
        event_type="action",
        artifact_path="/tmp/a",
        importance="hot",
    )
    memory.remember_fact("fact", tags=["contract"])
    memory.remember_decision(
        "decision",
        alternatives=["other option"],
        context="short context",
        tags=["contract"],
    )
    memory.recall("contract", limit=3)
    memory.checkpoint("checkpoint", key_decisions=["decision"])
    memory.wrap_session("wrapped", next_steps=["ship"])

    for name, payload in client.calls:
        assert_server_contract_call(name, payload)

    append = [
        payload for name, payload in client.calls if name == "append_session_event"
    ][0]
    assert append["artifact_path"] == "/tmp/a"
    assert append["importance"] == "hot"
    assert "artifact_path" not in append["metadata"]
    assert "importance" not in append["metadata"]
    decision = [payload for name, payload in client.calls if name == "log_decision"][0]
    assert isinstance(decision["context"], str)
    assert all(isinstance(item, str) for item in decision["alternatives"])


def test_agent_memory_convenience_helpers_route_to_wrapper_tools():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby", project="open-brain")

    memory.load_session_context(
        "lane-1",
        include_events=True,
        event_limit=5,
        event_types=["decision"],
        importance="hot",
    )
    memory.load_lane(status="active", limit=3)
    memory.update_lane(
        "lane-1",
        status="active",
        current_context_md="Current state.",
        metadata={"run_id": "run-1"},
    )
    memory.answer("What changed?", limit=2, search_mode="hybrid", tier="warm")
    memory.repo_facts(repo="owner/repo", fact_type="workflow", limit=10, offset=0)
    memory.upsert_repo_fact(
        {
            "source_system": "qmd",
            "repo": "owner/repo",
            "collection": "main",
            "path": "src/app.ts",
            "subject": "runtime package",
            "fact_type": "workflow",
            "fact": "The runtime package owns memory facade helpers.",
            "source_commit": "0123456789abcdef0123456789abcdef01234567",
            "source_url": (
                "https://github.com/owner/repo/blob/"
                "0123456789abcdef0123456789abcdef01234567/src/app.ts"
            ),
            "verified_at": "2026-06-20T00:00:00Z",
            "staleness_policy": "refresh_required",
        }
    )

    assert client.calls == [
        (
            "session_context",
            {
                "session_key": "lane-1",
                "include_events": True,
                "event_limit": 5,
                "event_types": ["decision"],
                "importance": "hot",
            },
        ),
        (
            "lane_load",
            {"project": "open-brain", "status": "active", "limit": 3},
        ),
        (
            "lane_upsert",
            {
                "session_key": "lane-1",
                "status": "active",
                "agent": "bilby",
                "source": "bilby",
                "project": "open-brain",
                "current_context_md": "Current state.",
                "metadata": {"run_id": "run-1"},
            },
        ),
        (
            "brain_answer",
            {
                "query": "What changed?",
                "limit": 2,
                "search_mode": "hybrid",
                "tier": "warm",
            },
        ),
        (
            "list_repo_facts",
            {
                "repo": "owner/repo",
                "fact_type": "workflow",
                "limit": 10,
                "offset": 0,
            },
        ),
        (
            "upsert_repo_fact",
            {
                "metadata": {
                    "source_system": "qmd",
                    "repo": "owner/repo",
                    "collection": "main",
                    "path": "src/app.ts",
                    "fact_type": "workflow",
                    "fact": "The runtime package owns memory facade helpers.",
                    "source_commit": "0123456789abcdef0123456789abcdef01234567",
                    "source_url": (
                        "https://github.com/owner/repo/blob/"
                        "0123456789abcdef0123456789abcdef01234567/src/app.ts"
                    ),
                    "verified_at": "2026-06-20T00:00:00Z",
                    "staleness_policy": "refresh_required",
                    "subject": "runtime package",
                },
            },
        ),
    ]


def test_record_receipt_routes_to_receipt_session_event():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby", project="open-brain")
    memory.start_session("conversation")

    memory.record_receipt(
        "contract_update",
        timestamp="2026-06-26T16:00:00.000Z",
        sources=[
            {
                "kind": "repo_path",
                "path": "docs/agent-memory-adapter-contract.md",
            }
        ],
        outputs=[{"kind": "repo_path", "path": "python/openbrain-memory"}],
        validations=[
            {
                "kind": "test",
                "status": "passed",
                "command": "uv run pytest python/openbrain-memory/tests/test_agent.py",
            }
        ],
        residual_risk="Review still pending.",
        branch="feat/memory-substrate-adapter-contract",
    )

    name, payload = client.calls[-1]
    assert name == "append_session_event"
    assert [name for name, _ in client.calls] == [
        "session_start",
        "append_session_event",
    ]
    assert payload["event_type"] == "receipt"
    assert payload["content"] == "Receipt: contract_update"
    assert payload["source"] == "bilby"
    assert payload["session_key"] == "conversation"
    assert payload["metadata"]["branch"] == "feat/memory-substrate-adapter-contract"
    assert payload["metadata"]["idempotency_key"].startswith("obmem-")
    assert payload["metadata"]["receipt"] == {
        "schema": "openbrain.receipt.v1",
        "action": "contract_update",
        "agent": "bilby",
        "session_key": "conversation",
        "timestamp": "2026-06-26T16:00:00.000Z",
        "sources": [
            {
                "kind": "repo_path",
                "path": "docs/agent-memory-adapter-contract.md",
            }
        ],
        "outputs": [{"kind": "repo_path", "path": "python/openbrain-memory"}],
        "validations": [
            {
                "kind": "test",
                "status": "passed",
                "command": "uv run pytest python/openbrain-memory/tests/test_agent.py",
            }
        ],
        "project": "open-brain",
        "residual_risk": "Review still pending.",
    }


def test_wrapper_source_can_differ_from_agent_for_events_and_receipts():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby", source="hermes-discord")
    memory.start_session("conversation")

    memory.append_event("hermes-discord", "Here is the update.", event_type="action")
    memory.record_receipt(
        "runtime_memory_write",
        sources=[{"kind": "repo_path", "path": "python/openbrain-memory"}],
        outputs=[{"kind": "artifact", "path": "receipt.json"}],
        validations=[{"kind": "manual", "status": "passed"}],
    )
    memory.update_lane("conversation", current_context_md="Hermes is active.")

    event_payload = client.calls[1][1]
    receipt_payload = client.calls[2][1]
    lane_payload = client.calls[3][1]

    assert event_payload["source"] == "hermes-discord"
    assert receipt_payload["source"] == "hermes-discord"
    assert receipt_payload["metadata"]["receipt"]["agent"] == "bilby"
    assert lane_payload["agent"] == "bilby"
    assert lane_payload["source"] == "hermes-discord"


def test_record_receipt_validates_shape_and_reserved_metadata():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")
    memory.start_session("conversation")

    with pytest.raises(ValueError, match="sources"):
        memory.record_receipt(
            "bad",
            sources=["not a mapping"],
            outputs=[],
            validations=[],
        )
    with pytest.raises(ValueError, match="reserved keys: receipt"):
        memory.record_receipt(
            "bad",
            sources=[],
            outputs=[],
            validations=[],
            receipt={"schema": "spoofed"},
        )
    with pytest.raises(ValueError, match="reserved authority keys"):
        memory.record_receipt(
            "bad",
            sources=[{"headers": {"Authorization": "Bearer x"}}],
            outputs=[],
            validations=[],
        )
    with pytest.raises(ValueError, match="reserved authority keys"):
        memory.record_receipt(
            "bad",
            sources=[],
            outputs=[{"namespace": "other"}],
            validations=[],
        )
    with pytest.raises(ValueError, match="validations\\[0\\].kind"):
        memory.record_receipt(
            "bad",
            sources=[],
            outputs=[],
            validations=[{"kind": "", "status": "passed"}],
        )


def test_record_receipt_rejects_secret_like_evidence_before_writes():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")
    memory.start_session("conversation")

    cases = [
        {
            "sources": [{"kind": "env", "api_key": "redacted-test-key"}],
            "outputs": [],
            "validations": [],
        },
        {
            "sources": [
                {
                    "kind": "command",
                    "summary": "Authorization: Bearer abcdef123456",
                }
            ],
            "outputs": [],
            "validations": [],
        },
        {
            "sources": [],
            "outputs": [{"kind": "artifact", "summary": "api_key=redacted-test-key"}],
            "validations": [],
        },
        {
            "sources": [],
            "outputs": [],
            "validations": [
                {
                    "kind": "manual",
                    "status": "passed",
                    "summary": "api_key=abc123456789",
                }
            ],
        },
        {
            "sources": [],
            "outputs": [],
            "validations": [],
            "residual_risk": "Bearer abcdef123456",
        },
        {
            "sources": [],
            "outputs": [],
            "validations": [],
            "note": "password=redacted-test-password",
        },
    ]

    for kwargs in cases:
        with pytest.raises(ValueError, match="secret-like material"):
            memory.record_receipt("bad", **kwargs)
    assert [name for name, _ in client.calls] == ["session_start"]


def test_receipt_rejection_excludes_heuristic_only_redaction_shapes():
    bare_three_segment = ".".join(
        [
            "AbCdEf2" * 4,
            "aBcD3f",
            "WxYz4Q" * 4,
        ]
    )
    unlabeled_blob = "Aa1Bb2" * 4 + "+=" + "Hh7Ii8" * 4

    assert "[REDACTED]" in redact_text(f"{bare_three_segment} {unlabeled_blob}")
    _reject_secret_payload(
        {"summary": bare_three_segment, "details": [unlabeled_blob]},
        "receipt",
    )


def test_metadata_bounds_are_rejected_before_tool_calls():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")

    too_many_keys = {f"key_{index}": index for index in range(51)}
    with pytest.raises(ValueError, match="at most 50 keys"):
        memory.start_session("conversation", **too_many_keys)
    with pytest.raises(ValueError, match="at most 100 characters"):
        memory.start_session("conversation", **{"x" * 101: True})

    memory.start_session("conversation")
    with pytest.raises(ValueError, match="at most 100000 bytes"):
        memory.append_event("assistant", "event", payload="x" * 100001)


def test_convenience_helpers_do_not_accept_payload_namespace():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby", project="open-brain")

    with pytest.raises(TypeError):
        getattr(memory, "load_session_context")("lane-1", namespace="shared-kb")
    with pytest.raises(TypeError):
        getattr(memory, "load_lane")(namespace="shared-kb")
    with pytest.raises(TypeError):
        getattr(memory, "update_lane")("lane-1", namespace="shared-kb")
    with pytest.raises(TypeError):
        getattr(memory, "answer")("question", namespace="shared-kb")
    with pytest.raises(TypeError):
        getattr(memory, "repo_facts")(namespace="shared-kb")
    with pytest.raises(ValueError, match="reserved"):
        memory.upsert_repo_fact({"namespace": "shared-kb", "repo": "owner/repo"})

    memory.answer("question")
    memory.repo_facts()
    assert all("namespace" not in payload for _name, payload in client.calls)


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


def test_recall_can_include_session_context_and_answer():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")
    memory.start_session("conversation")

    context = memory.recall("client facade", include_session=True, include_answer=True)

    assert [name for name, _ in client.calls[-3:]] == [
        "session_context",
        "search_all",
        "brain_answer",
    ]
    assert context.session == {
        "tool": "session_context",
        "arguments": {
            "session_key": "conversation",
            "include_events": True,
            "event_limit": 8,
        },
    }
    assert context.answer == {
        "tool": "brain_answer",
        "arguments": {"query": "client facade", "limit": 8},
    }


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


def test_compact_reads_context_and_wraps_distilled_summary():
    client = FakeClient()
    memory = AgentMemory(
        client,
        agent="bilby",
        project="open-brain",
        policy=MemoryPolicy(max_items=3),
    )
    memory.start_session("conversation")

    memory.compact(
        "fallback summary",
        key_decisions=["Use Python facade"],
        next_steps=["Ship Hermes adapter"],
        receipt_refs=["receipt-1"],
        context_to_summary=lambda context: f"distilled {context['tool']}",
    )

    assert client.calls[-2:] == [
        (
            "session_context",
            {
                "session_key": "conversation",
                "include_events": True,
                "event_limit": 3,
            },
        ),
        (
            "session_wrap",
            {
                "key_decisions": ["Use Python facade"],
                "next_steps": ["Ship Hermes adapter", "Receipt ref: receipt-1"],
                "summary": "distilled session_context",
                "project": "open-brain",
                "session_key": "conversation",
            },
        ),
    ]


def test_wrap_receipt_refs_are_encoded_as_server_supported_next_steps():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")
    memory.start_session("conversation")

    memory.wrap_session(
        "Done.",
        next_steps=["Open PR"],
        receipt_refs=["receipt-1", "receipt-2"],
    )

    assert client.calls[-1] == (
        "session_wrap",
        {
            "next_steps": [
                "Open PR",
                "Receipt ref: receipt-1",
                "Receipt ref: receipt-2",
            ],
            "summary": "Done.",
            "session_key": "conversation",
        },
    )

    with pytest.raises(ValueError, match="at most 20"):
        memory.wrap_session(
            "Too much.",
            next_steps=["step"],
            receipt_refs=[f"receipt-{index}" for index in range(20)],
        )

    with pytest.raises(ValueError, match="key_decisions"):
        memory.wrap_session("Bad decisions.", key_decisions="not-list")
    with pytest.raises(ValueError, match="next_steps"):
        memory.wrap_session("Bad steps.", next_steps=[{"bad": True}])


def test_checkpoint_receipt_refs_share_wrap_schema_normalization():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")
    memory.start_session("conversation")

    memory.checkpoint(
        "Checkpoint.",
        key_decisions=["Keep Python parity"],
        receipt_refs=["receipt-1"],
    )

    assert client.calls[-1] == (
        "session_wrap",
        {
            "key_decisions": ["Keep Python parity"],
            "next_steps": ["Receipt ref: receipt-1"],
            "summary": "Checkpoint.",
            "session_key": "conversation",
        },
    )
    assert "receipt_refs" not in client.calls[-1][1]

    with pytest.raises(ValueError, match="at most 20"):
        memory.checkpoint(
            "Too much.",
            next_steps=["step"],
            receipt_refs=[f"receipt-{index}" for index in range(20)],
        )


def test_export_disclosure_bundle_matches_ts_feature_shape():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby", project="open-brain")
    memory.start_session("conversation")

    bundle = memory.export_disclosure_bundle(
        lane={"topic": "Hermes memory", "metadata": {"okf": {"mode": "edge"}}},
        events=[
            {
                "id": "event-2",
                "type": "decision",
                "content": "Use Open Brain memory.",
                "timestamp": "2026-06-26T12:01:00Z",
                "sourceRef": "issue-210",
            },
            {
                "id": "event-1",
                "type": "fact",
                "content": "Hermes uses Python.",
                "timestamp": "2026-06-26T12:00:00Z",
                "artifactPath": "python/openbrain-memory/src/openbrain_memory/agent.py",
            },
        ],
        repo_facts=[
            {
                "id": "fact-a",
                "subject": "AgentMemory",
                "fact": "Python facade exports bundles.",
                "path": "python/openbrain-memory/src/openbrain_memory/agent.py",
            },
            {
                "id": "fact-a",
                "subject": "AgentMemory",
                "fact": "Duplicate ids still get unique concept paths.",
            },
        ],
        receipts=[
            {
                "id": "receipt-1",
                "action": "validation",
                "timestamp": "2026-06-26T12:02:00Z",
                "sources": [{"kind": "repo_path", "path": "agent.py"}],
                "outputs": [],
                "validations": [{"kind": "pytest", "status": "passed"}],
            }
        ],
    )

    assert bundle["profile"] == "okf-like"
    files = {file["path"]: file["content"] for file in bundle["files"]}
    assert list(files) == [
        "index.md",
        "log.md",
        "concepts/agentmemory.md",
        "concepts/agentmemory-fact-a.md",
        "citations.md",
        "receipts.md",
    ]
    assert "session_key: \"conversation\"" in files["index.md"]
    assert "agent: \"bilby\"" in files["index.md"]
    assert "project: \"open-brain\"" in files["index.md"]
    assert "okf: {\"mode\":\"edge\"}" in files["index.md"]
    assert files["log.md"].find("Hermes uses Python.") < files["log.md"].find(
        "Use Open Brain memory."
    )
    assert "- Source ref: issue-210" in files["log.md"]
    assert "fact:fact-a:path" in files["citations.md"]
    assert "receipt:receipt-1" in files["citations.md"]
    assert '"status":"passed"' in files["receipts.md"]


def test_export_disclosure_bundle_matches_shared_golden_fixture():
    fixture_path = (
        Path(__file__).resolve().parents[3]
        / "tests"
        / "fixtures"
        / "agent-memory-disclosure-golden.json"
    )
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    client = FakeClient()
    memory = AgentMemory(
        client,
        agent=fixture["adapter"]["agent"],
        project=fixture["adapter"]["project"],
    )
    memory.start_session(fixture["adapter"]["sessionKey"])

    fixture_input = dict(fixture["input"])
    fixture_input["repo_facts"] = fixture_input.pop("repoFacts")
    assert memory.export_disclosure_bundle(**fixture_input) == fixture["expected"]


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


def test_decision_context_and_alternatives_must_match_server_schema():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")

    memory.remember_decision(
        "decision",
        context="customer interview summary",
        alternatives=["Other path was too costly"],
    )

    assert client.calls[0][1]["context"] == "customer interview summary"
    assert client.calls[0][1]["alternatives"] == ["Other path was too costly"]

    with pytest.raises(ValueError, match="context"):
        memory.remember_decision("decision", context={"summary": "plain note"})
    with pytest.raises(ValueError, match="alternatives"):
        memory.remember_decision("decision", alternatives=[{"title": "Other path"}])


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
    with pytest.raises(ValueError, match="importance"):
        memory.append_event("assistant", "event", importance="urgent")


def test_namespace_metadata_is_not_accepted_by_memory_facade():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")

    with pytest.raises(ValueError, match="reserved keys"):
        memory.remember_fact("fact", namespace="other")
    with pytest.raises(ValueError, match="reserved keys"):
        memory.remember_decision("decision", namespace="other")

    assert client.calls == []


def test_deeply_nested_metadata_is_rejected():
    client = FakeClient()
    memory = AgentMemory(client, agent="bilby")

    nested: dict = {"safe": "value"}
    for _ in range(20):
        nested = {"layer": nested}

    with pytest.raises(ValueError, match="nesting depth"):
        memory.remember_fact("fact", tags=[nested])

    assert client.calls == []


def test_session_methods_require_started_session():
    memory = AgentMemory(FakeClient(), agent="bilby")

    with pytest.raises(RuntimeError, match="start_session"):
        memory.append_event("assistant", "event")
    with pytest.raises(RuntimeError, match="start_session"):
        memory.checkpoint("summary")
    with pytest.raises(RuntimeError, match="start_session"):
        memory.wrap_session("summary")
    with pytest.raises(RuntimeError, match="start_session"):
        memory.compact("summary")
    with pytest.raises(RuntimeError, match="start_session"):
        memory.export_disclosure_bundle()


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
