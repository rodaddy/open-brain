"""Live proof of ordered spool replay after an outage (release gate 4, #296).

`tests/test_spool.py` proves the spool's ordering, quarantine, and receipt
shapes against fake transports. This file proves the same durability claim end
to end against a running service: three captures taken while the endpoint is a
closed port must come back, in capture order and exactly once, after the
endpoint is restored and the package's own replay runs.
"""

from __future__ import annotations

import json
import os
from typing import Any
from uuid import uuid4

import pytest

from openbrain_memory import OpenBrainClient
from openbrain_memory.runtime import (
    FirstClassMemoryRuntime,
    ReceiptStatus,
    RuntimeConfig,
    RuntimeScope,
)
from openbrain_memory.spool import JsonlSpool

LIVE_CANARY_ENABLED = os.environ.get("OPENBRAIN_LIVE_CANARY") == "1"

pytestmark = pytest.mark.skipif(
    not LIVE_CANARY_ENABLED,
    reason="live canary requires OPENBRAIN_LIVE_CANARY=1 and credentials",
)

# A closed port on loopback: the outage is the real transport failing to
# connect, with no monkeypatching and no injected failing lane.
OUTAGE_BASE_URL = "http://127.0.0.1:9"


def _tool_payload(result: dict[str, Any]) -> Any:
    if "content" not in result:
        return result
    content = result["content"]
    assert isinstance(content, list) and content
    text = content[0].get("text")
    assert isinstance(text, str)
    payload = json.loads(text)
    return payload


def _config(base_url: str, spool_path: Any) -> RuntimeConfig:
    return RuntimeConfig(
        base_url=base_url,
        token=os.environ["OPENBRAIN_TOKEN"],
        namespace=os.environ["OPENBRAIN_NAMESPACE"],
        allow_insecure_http=os.environ.get("OPENBRAIN_ALLOW_INSECURE_HTTP") == "1",
        timeout=float(os.environ.get("OPENBRAIN_TIMEOUT", "10")),
        spool_path=spool_path,
    )


def test_live_outage_spools_then_replays_in_order(tmp_path):
    if os.environ.get("OPENBRAIN_LIVE_CANARY_WRITE") != "1":
        pytest.skip("set OPENBRAIN_LIVE_CANARY_WRITE=1 to run spool replay writes")

    base_url = os.environ["OPENBRAIN_BASE_URL"]
    marker = uuid4()
    session_key = f"openbrain-memory-live-outage-replay/{marker}"
    scope = RuntimeScope(
        agent="openbrain-memory-outage-canary",
        platform="pytest",
        server_id="openbrain-memory-live-outage-replay",
        channel_id="open-brain",
        session_key=session_key,
    )
    contents = [
        f"openbrain-memory live outage replay event {index} for {marker}."
        for index in range(1, 4)
    ]
    spool_path = tmp_path / "spool.jsonl"

    # --- OUTAGE -------------------------------------------------------------
    outage_runtime = FirstClassMemoryRuntime(
        _config(OUTAGE_BASE_URL, spool_path), scope
    )
    try:
        for content in contents:
            output = outage_runtime.capture_distilled(content, event_type="receipt")
            receipt = output.receipt
            # runtime.py: the durable-on-disk resting place — status `spooled`,
            # durable True, and the spool key that names the parked record.
            assert receipt.status is ReceiptStatus.SPOOLED, receipt.as_dict()
            assert receipt.durable is True, receipt.as_dict()
            assert receipt.spool_key, receipt.as_dict()
    finally:
        outage_runtime.close()

    spool = JsonlSpool(spool_path)
    parked = spool.records()
    assert [record.payload.get("content") for record in parked if
            record.operation == "append_session_event"] == contents

    # --- RECOVERY -----------------------------------------------------------
    live_runtime = FirstClassMemoryRuntime(_config(base_url, spool_path), scope)
    try:
        drain = live_runtime.drain_spool_now()
    finally:
        live_runtime.close()

    assert drain is not None, "no drain ran against the restored endpoint"
    assert drain.failed_units == 0, drain.as_dict()
    assert drain.quarantined_units == 0, drain.as_dict()
    assert drain.retained_units == 0, drain.as_dict()
    assert drain.replayed_units == drain.attempted_units > 0, drain.as_dict()
    assert drain.replayed_records >= len(contents), drain.as_dict()
    replayed = [
        receipt for receipt in drain.receipts
        if receipt.status is ReceiptStatus.REPLAYED
    ]
    assert len(replayed) == drain.replayed_records
    assert all(receipt.durable and receipt.spool_key for receipt in replayed)

    # The spool is empty afterwards: nothing left parked on disk.
    assert JsonlSpool(spool_path).records() == []
    assert JsonlSpool(spool_path).status().pending_count == 0

    # --- READ BACK FROM THE SERVICE ----------------------------------------
    client = OpenBrainClient(
        base_url,
        os.environ["OPENBRAIN_TOKEN"],
        os.environ["OPENBRAIN_NAMESPACE"],
        agent_id=scope.agent,
        timeout=float(os.environ.get("OPENBRAIN_TIMEOUT", "10")),
        allow_insecure_http=os.environ.get("OPENBRAIN_ALLOW_INSECURE_HTTP") == "1",
    )
    try:
        context = _tool_payload(
            client.session_context(
                session_key=session_key,
                include_events=True,
                event_limit=50,
            )
        )
    finally:
        client.close()

    assert isinstance(context, dict)
    events = context.get("events")
    assert isinstance(events, list), context
    stored = [
        event.get("content") for event in events
        if event.get("content") in contents
    ]
    # Exactly once each, and in capture order. `events` may arrive newest-first;
    # accept either total order, never a shuffle and never a duplicate.
    assert sorted(stored) == sorted(contents), stored
    assert stored in (contents, list(reversed(contents))), stored
