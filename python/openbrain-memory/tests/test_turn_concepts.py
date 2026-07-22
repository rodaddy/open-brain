"""Tests for deterministic per-turn concept/entity extraction (OB #332)."""

from __future__ import annotations

import logging
from typing import Any

import pytest

from openbrain_memory import (
    DEFAULT_MAX_KEYS,
    AgentMemory,
    TurnConcepts,
    extract_turn_concepts,
    normalized_tokens,
    verbatim_tokens,
)
from openbrain_memory.agent import DERIVED_QUERY_MAX_KEYS, _derive_recall_query


class _RecordingClient:
    """Minimal fake client recording every downstream call for scope assertions."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.search_payload: dict[str, Any] = {"results": []}

    def search_all(self, **payload: Any) -> dict[str, Any]:
        self.calls.append(("search_all", payload))
        return self.search_payload

    def session_context(self, **payload: Any) -> dict[str, Any]:
        self.calls.append(("session_context", payload))
        return {"tool": "session_context", "arguments": payload}

    def brain_answer(self, **payload: Any) -> dict[str, Any]:
        self.calls.append(("brain_answer", payload))
        return {"tool": "brain_answer", "arguments": payload}


# ---------------------------------------------------------------------------
# Pure extractor behavior
# ---------------------------------------------------------------------------


def test_representative_turn_emits_entities_and_concepts() -> None:
    result = extract_turn_concepts(
        "Rico asked how the open-brain recall boundary handles the durable memory "
        "namespace for the agent_memory module."
    )
    # Identifier-shaped tokens (internal separator) land in entities, lowercased.
    assert "open-brain" in result.entities
    assert "agent_memory" in result.entities
    # Ordinary content words -- capitalized or not -- land in concepts, lowercased.
    assert "rico" in result.concepts
    assert "recall" in result.concepts
    assert "boundary" in result.concepts
    assert "durable" in result.concepts
    assert "namespace" in result.concepts
    # Stopwords and sub-threshold tokens are dropped from concepts.
    assert "the" not in result.concepts
    assert "how" not in result.concepts


def test_empty_input_yields_empty_result() -> None:
    for text in ("", "   ", "\n\t  "):
        result = extract_turn_concepts(text)
        assert result.entities == ()
        assert result.concepts == ()
        assert result.keys == ()
        assert result.truncated is False


def test_repeated_entities_counted_once_order_preserved() -> None:
    result = extract_turn_concepts(
        "Open-Brain then open-brain again, and OPEN-BRAIN once more; "
        "agent_memory agent_memory."
    )
    # Case-insensitive dedupe: one lowercased key per distinct entity.
    assert result.entities.count("open-brain") == 1
    assert result.entities.count("agent_memory") == 1
    # First-occurrence order is preserved.
    assert result.entities.index("open-brain") < result.entities.index("agent_memory")


def test_repeated_concepts_counted_once() -> None:
    result = extract_turn_concepts("recall recall RECALL boundary boundary")
    assert result.concepts.count("recall") == 1
    assert result.concepts.count("boundary") == 1


def test_normalization_stability_equivalent_inputs() -> None:
    # Casing and surrounding punctuation/whitespace do not change the keys.
    a = extract_turn_concepts("The API handles Recall.")
    b = extract_turn_concepts("the   api,  handles ...  recall!!!")
    c = extract_turn_concepts("\tTHE api\nHANDLES recall")
    assert a.concepts == b.concepts == c.concepts
    # And extraction is deterministic across repeated calls.
    again = extract_turn_concepts("The API handles Recall.")
    assert again.entities == a.entities
    assert again.concepts == a.concepts


def test_configured_maximum_bounds_each_category() -> None:
    # Ten distinct entity-shaped (separator) tokens and ten distinct concepts.
    entities = " ".join(f"ent-{i}" for i in range(10))
    concepts = " ".join(f"concept{i}" for i in range(10))
    result = extract_turn_concepts(f"{entities} {concepts}", max_keys=3)
    assert len(result.entities) == 3
    assert len(result.concepts) == 3
    assert result.max_keys == 3
    assert result.truncated is True
    # The kept keys are the first-seen ones (order-preserving cap).
    assert result.entities == ("ent-0", "ent-1", "ent-2")
    assert result.concepts == ("concept0", "concept1", "concept2")


def test_default_maximum_applied_when_unspecified() -> None:
    concepts = " ".join(f"concept{i}" for i in range(DEFAULT_MAX_KEYS + 5))
    result = extract_turn_concepts(concepts)
    assert len(result.concepts) == DEFAULT_MAX_KEYS
    assert result.truncated is True


def test_max_keys_must_be_positive() -> None:
    with pytest.raises(ValueError):
        extract_turn_concepts("anything", max_keys=0)


def test_single_giant_token_is_length_bounded() -> None:
    huge = "z" * 500
    result = extract_turn_concepts(huge)
    assert len(result.concepts) == 1
    assert len(result.concepts[0]) <= 64


def test_pure_digit_tokens_are_dropped_from_concepts() -> None:
    result = extract_turn_concepts("meeting 2026 about budget 42")
    assert "2026" not in result.concepts
    assert "42" not in result.concepts
    assert "meeting" in result.concepts
    assert "budget" in result.concepts


# ---------------------------------------------------------------------------
# Content-free telemetry
# ---------------------------------------------------------------------------


def test_telemetry_excludes_raw_text_and_keys() -> None:
    text = "SecretProject reticulates splines for Rico"
    result = extract_turn_concepts(text)
    telemetry = result.telemetry()
    serialized = repr(telemetry)
    # No raw turn substring leaks.
    assert "reticulates" not in serialized
    assert "splines" not in serialized
    # No extracted key leaks into telemetry.
    for key in result.keys:
        assert key not in serialized
    # Only counts, category names, and the bound are present.
    assert telemetry["categories"] == ["entities", "concepts"]
    assert telemetry["entity_count"] == len(result.entities)
    assert telemetry["concept_count"] == len(result.concepts)
    assert telemetry["key_count"] == len(result.keys)
    assert isinstance(telemetry["truncated"], bool)
    assert telemetry["max_keys"] == result.max_keys


def test_telemetry_reports_dropped_counts_on_truncation() -> None:
    result = extract_turn_concepts(
        " ".join(f"concept{i}" for i in range(10)), max_keys=4
    )
    telemetry = result.telemetry()
    assert telemetry["concept_count"] == 4
    assert telemetry["dropped_concepts"] == 6
    assert telemetry["truncated"] is True


# ---------------------------------------------------------------------------
# Derived recall query: extracted keys actually drive retrieval
# ---------------------------------------------------------------------------
#
# Every extracted key comes FROM a query token, so "not already represented"
# means: the key's exact normalized (lowercased, identifier-joined) form is not
# already a verbatim token of the query. A query saying "API"/"Open-Brain"
# surfaces the normalized keys "api"/"open-brain" -- a new representation that
# drives recall -- while a token already in that exact lowercase form is not
# re-appended.


def test_derived_query_appends_normalized_form_of_cased_tokens() -> None:
    query = "How does the API handle Recall for Open-Brain?"
    concepts = extract_turn_concepts(query)
    derived = _derive_recall_query(query, concepts)

    # Original text kept verbatim and first.
    assert derived.startswith(query)
    suffix = derived[len(query) :]
    # The lowercased normalized keys for the cased query tokens are appended.
    assert "api" in suffix
    assert "recall" in suffix
    assert "open-brain" in suffix
    # A token already lowercase-verbatim in the query ("does", "handle", "for")
    # is not re-appended.
    assert "does" not in suffix
    assert "handle" not in suffix


def test_derived_query_is_original_when_all_keys_already_verbatim() -> None:
    # Every content token is already lowercase in the query, so its normalized
    # key equals a verbatim query token and nothing new is appended.
    query = "recall durable namespace boundary handle"
    concepts = extract_turn_concepts(query)
    derived = _derive_recall_query(query, concepts)
    assert derived == query


def test_derived_query_does_not_bloat_on_repeats_or_case() -> None:
    # The same salient token appears many times in mixed casing, but never in
    # its exact lowercase form; the extractor dedupes to one normalized key so
    # the derived query appends it at most once.
    query = "Explain the API, the Api, and the API again"
    concepts = extract_turn_concepts(query)
    derived = _derive_recall_query(query, concepts)
    suffix = derived[len(query) :]
    assert suffix.count("api") == 1


def test_derived_query_appended_keys_are_bounded() -> None:
    # Many distinct cased tokens all yield novel normalized keys; the number of
    # keys folded onto the original query is capped at DERIVED_QUERY_MAX_KEYS.
    tokens = " ".join(f"Ent{i}Word" for i in range(DERIVED_QUERY_MAX_KEYS + 6))
    concepts = extract_turn_concepts(tokens, max_keys=DERIVED_QUERY_MAX_KEYS + 6)
    assert len(concepts.keys) > DERIVED_QUERY_MAX_KEYS
    derived = _derive_recall_query(tokens, concepts)
    # The derived query is the original followed by exactly the bounded number of
    # appended key tokens.
    assert derived.startswith(tokens + " ")
    appended = derived[len(tokens) + 1 :].split()
    assert len(appended) == DERIVED_QUERY_MAX_KEYS
    # And every appended token is one of the extracted keys.
    assert set(appended).issubset(set(concepts.keys))


def test_derived_query_keeps_original_verbatim_and_first() -> None:
    query = "Explain the API for Rico"
    concepts = extract_turn_concepts(query)
    derived = _derive_recall_query(query, concepts)
    assert derived == query or derived.startswith(query + " ")
    assert query in derived


def test_derived_query_empty_original_falls_back_to_keys() -> None:
    concepts = extract_turn_concepts("Vault-Secret Reticulate")
    derived = _derive_recall_query("", concepts)
    assert "vault-secret" in derived
    assert "reticulate" in derived


def test_token_helpers_agree_up_to_casing() -> None:
    text = "The API drives Open-Brain Recall"
    verbatim = verbatim_tokens(text)
    normalized = normalized_tokens(text)
    # Verbatim preserves the source casing; normalized casefolds each token.
    assert "API" in verbatim
    assert "Open-Brain" in verbatim
    assert "api" in normalized
    assert "open-brain" in normalized
    # Same token set once casefolded, so the only difference is case.
    assert {token.casefold() for token in verbatim} == normalized
    assert verbatim_tokens("") == frozenset()
    assert normalized_tokens("") == frozenset()


# ---------------------------------------------------------------------------
# Recall-boundary wiring: derived query drives recall, scope unchanged,
# no persistence, content-free logs
# ---------------------------------------------------------------------------


def test_recall_drives_search_with_derived_query_keeping_scope() -> None:
    client = _RecordingClient()
    memory = AgentMemory(client, agent="bilby", project="open-brain")

    # Cased/identifier tokens ("Open-Brain", "Namespace") surface normalized keys
    # the raw query does not contain verbatim, so they drive the derived query.
    original = "How does Recall handle the durable Namespace in Open-Brain?"
    context = memory.recall(original)

    name, payload = client.calls[-1]
    assert name == "search_all"
    # The request payload keeps exactly its query/limit/sources shape: keys are
    # folded into the query string, never added as separate payload fields, and
    # never persisted.
    assert set(payload) == {"query", "limit", "sources"}
    assert "concepts" not in payload
    assert "entities" not in payload
    assert "keys" not in payload

    # The derived query actually drives retrieval: original text is represented
    # in full AND the normalized keys are present, so recall differs from a bare
    # original-query request.
    assert original in payload["query"]
    assert payload["query"] != original
    assert "open-brain" in payload["query"]
    assert "namespace" in payload["query"]

    # MemoryContext.query stays the ORIGINAL input; concepts are structured out
    # and not merged into the stored query.
    assert context.query == original
    assert isinstance(context.concepts, TurnConcepts)
    assert "open-brain" in context.concepts.entities
    assert "durable" in context.concepts.concepts
    assert "namespace" in context.concepts.concepts


def test_recall_answer_uses_same_derived_query() -> None:
    client = _RecordingClient()
    memory = AgentMemory(client, agent="bilby", project="open-brain")

    original = "Recall the durable Namespace via Open-Brain"
    memory.recall(original, include_answer=True)

    search = next(p for n, p in client.calls if n == "search_all")
    answer = next(p for n, p in client.calls if n == "brain_answer")
    # search_all and brain_answer receive the exact same derived query.
    assert answer["query"] == search["query"]
    assert original in answer["query"]
    assert "open-brain" in answer["query"]


def test_recall_session_and_namespace_behavior_unchanged() -> None:
    client = _RecordingClient()
    memory = AgentMemory(client, agent="bilby", project="open-brain")
    memory.conversation_key = "sess-123"

    memory.recall("Recall the Namespace now", include_session=True)

    session_calls = [p for n, p in client.calls if n == "session_context"]
    assert len(session_calls) == 1
    # Session context is loaded under the caller's exact session key; the derived
    # query does not leak into or alter session/namespace scoping.
    assert session_calls[0]["session_key"] == "sess-123"
    # No namespace field is fabricated onto the search payload.
    search = next(p for n, p in client.calls if n == "search_all")
    assert "namespace" not in search


def test_recall_never_calls_a_write_path() -> None:
    client = _RecordingClient()
    memory = AgentMemory(client, agent="bilby")

    memory.recall("remember that OpenBrain is durable")

    # Only read-side calls happen; no session_start / log / promote / candidate
    # write is triggered by extraction or query derivation.
    called = {name for name, _ in client.calls}
    assert called == {"search_all"}


def test_recall_telemetry_log_is_content_free(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = _RecordingClient()
    memory = AgentMemory(client, agent="bilby")

    with caplog.at_level(logging.DEBUG, logger="openbrain_memory.agent"):
        memory.recall("Rico wants OpenBrain to reticulate splines now")

    turn_records = [
        r for r in caplog.records if r.getMessage() == "turn_concepts_extracted"
    ]
    assert turn_records, "expected a turn_concepts_extracted telemetry record"
    record = turn_records[-1]
    # The record carries only content-free telemetry fields; the raw turn text
    # and extracted keys never reach the log.
    assert getattr(record, "categories", None) == ["entities", "concepts"]
    assert isinstance(getattr(record, "entity_count"), int)
    assert isinstance(getattr(record, "concept_count"), int)
    for leak in ("reticulate", "splines", "Rico", "OpenBrain"):
        assert leak not in record.getMessage()
        for value in vars(record).values():
            assert not (isinstance(value, str) and leak in value)
