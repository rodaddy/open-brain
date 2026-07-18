from __future__ import annotations

import json
import os
from collections.abc import Iterator
from datetime import UTC, datetime
from importlib.metadata import PackageNotFoundError, version
from typing import Any
from uuid import uuid4

import pytest

from openbrain_memory import (
    CURRENT_CONTRACT_SCHEMA_HASH,
    CURRENT_CONTRACT_SCHEMA_VERSION,
    CURRENT_CONTRACT_VERSION,
    OpenBrainClient,
    validate_required_memory_contract,
)

LIVE_CANARY_ENABLED = os.environ.get("OPENBRAIN_LIVE_CANARY") == "1"


pytestmark = pytest.mark.skipif(
    not LIVE_CANARY_ENABLED,
    reason="live canary requires OPENBRAIN_LIVE_CANARY=1 and credentials",
)


@pytest.fixture()
def live_client() -> Iterator[OpenBrainClient]:
    base_url = os.environ["OPENBRAIN_BASE_URL"]
    token = os.environ["OPENBRAIN_TOKEN"]
    namespace = os.environ["OPENBRAIN_NAMESPACE"]
    client = OpenBrainClient(
        base_url,
        token,
        namespace,
        agent_id=os.environ.get("OPENBRAIN_AGENT_ID"),
        role=os.environ.get("OPENBRAIN_ROLE"),
        timeout=float(os.environ.get("OPENBRAIN_TIMEOUT", "10")),
        allow_insecure_http=os.environ.get("OPENBRAIN_ALLOW_INSECURE_HTTP") == "1",
    )
    try:
        yield client
    finally:
        client.close()


def _tool_payload(result: dict[str, Any]) -> Any:
    if "content" not in result:
        return result
    content = result["content"]
    assert isinstance(content, list) and content
    text = content[0].get("text")
    assert isinstance(text, str)
    payload = json.loads(text)
    return payload


def _unique_session_key() -> str:
    return f"openbrain-memory-live-canary/{uuid4()}"


def _package_version() -> str | None:
    try:
        return version("openbrain-memory")
    except PackageNotFoundError:
        return None


def test_live_health_and_search_all_canary(live_client: OpenBrainClient):
    health = live_client.health()
    assert "status" in health

    result = _tool_payload(
        live_client.search_all(query="live canary", limit=1, sources="brain")
    )
    assert isinstance(result, dict)
    assert {"total", "brain_hits", "qmd_hits", "results"} <= set(result)
    assert isinstance(result["results"], list)
    for item in result["results"]:
        assert item.get("source") == "brain"


def test_live_contract_manifest_validates_required_memory_helpers(
    live_client: OpenBrainClient,
):
    manifest = _tool_payload(live_client.get_contract())
    assert isinstance(manifest, dict)

    validation = validate_required_memory_contract(
        manifest,
        client_version=_package_version(),
    )

    assert validation.ok, validation.reasons
    assert manifest["contract_version"] == CURRENT_CONTRACT_VERSION
    assert manifest["schema_version"] == CURRENT_CONTRACT_SCHEMA_VERSION
    assert manifest["schema_hash"] == CURRENT_CONTRACT_SCHEMA_HASH


def test_live_read_helpers_canary(live_client: OpenBrainClient):
    answer = _tool_payload(
        live_client.brain_answer(query="openbrain-memory live canary", limit=1)
    )
    assert isinstance(answer, dict)

    facts = _tool_payload(live_client.list_repo_facts(limit=1))
    if isinstance(facts, dict):
        fact_items = facts.get("facts", facts.get("results", []))
    else:
        fact_items = facts
    assert isinstance(fact_items, list)


def test_live_lane_session_append_read_and_wrap_helpers(
    live_client: OpenBrainClient,
):
    if os.environ.get("OPENBRAIN_LIVE_CANARY_WRITE") != "1":
        pytest.skip("set OPENBRAIN_LIVE_CANARY_WRITE=1 to run lane/session writes")

    session_key = _unique_session_key()
    project = "openbrain-memory-live-canary"
    receipt_content = "openbrain-memory live canary append/read helper check."

    started = _tool_payload(
        live_client.session_start(
            session_key=session_key,
            agent="openbrain-memory-canary",
            project=project,
            topic="Package helper readiness canary",
        )
    )
    assert isinstance(started, dict)
    started_lane = started.get("lane")
    assert isinstance(started_lane, dict)
    assert started_lane.get("session_key") == session_key
    assert started.get("is_new") is True

    upserted = _tool_payload(
        live_client.lane_upsert(
            session_key=session_key,
            agent="openbrain-memory-canary",
            project=project,
            topic="Package helper readiness canary updated",
            current_context_md="Live canary context for package helper readiness.",
            metadata={"canary": "openbrain-memory"},
        )
    )
    assert isinstance(upserted, dict)
    assert upserted.get("session_key") == session_key

    appended = _tool_payload(
        live_client.append_session_event(
            session_key=session_key,
            event_type="receipt",
            content=receipt_content,
            source="tests/test_live_canary.py",
            importance="cold",
            metadata={"canary": "openbrain-memory"},
        )
    )
    assert isinstance(appended, dict)
    assert isinstance(appended.get("event_id"), str)
    assert appended.get("lane_id") == started_lane.get("id")

    context = _tool_payload(
        live_client.session_context(
            session_key=session_key,
            include_events=True,
            event_limit=5,
        )
    )
    assert isinstance(context, dict)
    lane = context.get("lane")
    assert isinstance(lane, dict)
    assert lane.get("session_key") == session_key
    events = context.get("events")
    assert isinstance(events, list)
    assert any(event.get("content") == receipt_content for event in events)

    lanes = _tool_payload(live_client.lane_load(session_key=session_key, limit=1))
    if isinstance(lanes, dict):
        lane_items = lanes.get("lanes")
    else:
        lane_items = lanes
    assert isinstance(lane_items, list)
    assert any(lane.get("session_key") == session_key for lane in lane_items)

    wrapped = _tool_payload(
        live_client.session_wrap(
            session_key=session_key,
            summary=(
                "openbrain-memory live canary verified helper readiness for "
                f"{session_key}."
            ),
            key_decisions=[],
            next_steps=[],
            project=project,
        )
    )
    assert isinstance(wrapped, dict)
    assert isinstance(wrapped.get("session_id"), str)
    assert wrapped.get("lane_status") == "active"
    assert wrapped.get("event_count") == 1


def test_live_optional_repo_fact_write_canary(live_client: OpenBrainClient):
    if os.environ.get("OPENBRAIN_LIVE_CANARY_REPO_FACT_WRITE") != "1":
        pytest.skip("set OPENBRAIN_LIVE_CANARY_REPO_FACT_WRITE=1 to upsert repo facts")

    commit = os.environ.get("OPENBRAIN_LIVE_CANARY_REPO_FACT_COMMIT")
    if not commit:
        pytest.fail(
            "OPENBRAIN_LIVE_CANARY_REPO_FACT_COMMIT is required when "
            "OPENBRAIN_LIVE_CANARY_REPO_FACT_WRITE=1"
        )
    metadata = {
        "source_system": "qmd",
        "repo": "rodaddy/open-brain",
        "collection": "open-brain",
        "path": "python/openbrain-memory/tests/test_live_canary.py",
        "subject": "openbrain-memory live canary",
        "fact_type": "validation",
        "fact": (
            "The openbrain-memory package live canary can opt in to repo fact "
            "write validation."
        ),
        "source_commit": commit,
        "source_url": (
            "https://github.com/rodaddy/open-brain/blob/"
            f"{commit}/python/openbrain-memory/tests/test_live_canary.py"
        ),
        "verified_at": datetime.now(UTC).isoformat(),
        "confidence": 1,
        "staleness_policy": "refresh_required",
        "refresh_hint": "Re-run OPENBRAIN_LIVE_CANARY_REPO_FACT_WRITE=1 pytest canary.",
    }

    result = _tool_payload(live_client.upsert_repo_fact(metadata=metadata))

    assert result
