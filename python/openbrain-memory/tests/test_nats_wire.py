from __future__ import annotations

import pytest

from openbrain_memory.nats_wire import (
    CONTEXT_PACK_REQUEST_KIND,
    build_context_pack_subject,
    build_request_envelope,
)


def test_subject_is_env_prefixed_and_slugged():
    assert build_context_pack_subject("dev") == "dev.ob.memory.context_pack"
    assert build_context_pack_subject("PROD") == "prod.ob.memory.context_pack"
    # Dots/spaces in the env token are normalised to hyphens (fleet _slug).
    assert build_context_pack_subject("my env.1") == "my-env-1.ob.memory.context_pack"


def test_empty_env_token_rejected():
    with pytest.raises(ValueError, match="normalises to empty"):
        build_context_pack_subject("   ")


def test_request_envelope_has_fleet_wire_shape():
    envelope = build_request_envelope(
        msg_id="abc",
        ts="2026-07-08T00:00:00+00:00",
        sender="openbrain-memory",
        correlation_id="abc",
        payload={"operation": "agent_context_pack"},
    )

    assert envelope["id"] == "abc"
    assert envelope["ts"] == "2026-07-08T00:00:00+00:00"
    assert envelope["from"] == "openbrain-memory"
    assert envelope["kind"] == CONTEXT_PACK_REQUEST_KIND
    assert envelope["correlation_id"] == "abc"
    assert envelope["payload"] == {"operation": "agent_context_pack"}
    assert envelope["version"] == 1
    # Fleet Envelope carries the full optional field set (null when unused).
    for key in ("to", "task_id", "channel", "topic"):
        assert envelope[key] is None


def test_request_envelope_rejects_empty_id_and_sender():
    with pytest.raises(ValueError, match="id must be non-empty"):
        build_request_envelope(
            msg_id="",
            ts="t",
            sender="s",
            correlation_id="c",
            payload={},
        )
    with pytest.raises(ValueError, match="sender must be non-empty"):
        build_request_envelope(
            msg_id="i",
            ts="t",
            sender="",
            correlation_id="c",
            payload={},
        )
