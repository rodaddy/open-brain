from __future__ import annotations

import json
import os

import pytest

from openbrain_memory import OpenBrainClient


@pytest.mark.skipif(
    os.environ.get("OPENBRAIN_LIVE_CANARY") != "1",
    reason="live canary requires OPENBRAIN_LIVE_CANARY=1 and credentials",
)
def test_live_health_and_search_all_canary():
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

    health = client.health()
    assert "status" in health
    result = client.search_all(query="live canary", limit=1, sources="brain")
    assert result.get("isError") is not True
    if "content" in result:
        content = result["content"]
        assert isinstance(content, list) and content
        text = content[0].get("text")
        assert isinstance(text, str)
        result = json.loads(text)
    assert {"total", "brain_hits", "qmd_hits", "results"} <= set(result)
    assert isinstance(result["results"], list)
    for item in result["results"]:
        assert item.get("source") == "brain"
