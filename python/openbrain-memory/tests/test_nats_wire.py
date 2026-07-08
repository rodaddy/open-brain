from __future__ import annotations

import json
from pathlib import Path

import pytest

from openbrain_memory.client import (
    CONTEXT_PACK_REPLY_KIND,
    _validate_nats_context_pack_response_envelope,
)
from openbrain_memory.nats_wire import (
    CONTEXT_PACK_REQUEST_KIND,
    build_context_pack_subject,
    build_request_envelope,
    envelope_to_wire_bytes,
)

_WIRE_FIXTURE = (
    Path(__file__).parent / "fixtures" / "nats-context-pack-wire.json"
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


def _load_wire_fixture() -> dict:
    return json.loads(_WIRE_FIXTURE.read_text(encoding="utf-8"))


def test_request_envelope_byte_matches_shared_cross_language_fixture():
    """(fix 5a) Python serializer must emit bytes EXACTLY equal to request.wire.

    Builds the request envelope from the shared fixture's structured
    ``request.envelope`` (the SAME object TS builds from) and asserts the
    canonical serializer reproduces ``request.wire`` byte-for-byte. If this
    fails, field order / null-emission / separators drifted — fix the
    serializer, not the fixture. This is what stops TS<->Python wire drift.
    """
    fixture = _load_wire_fixture()
    source = fixture["request"]["envelope"]

    envelope = build_request_envelope(
        msg_id=source["id"],
        ts=source["ts"],
        sender=source["from"],
        correlation_id=source["correlation_id"],
        payload=source["payload"],
    )

    actual = envelope_to_wire_bytes(envelope)
    expected = fixture["request"]["wire"].encode("utf-8")
    assert actual == expected

    # Sanity: the override rides top-level payload.namespace with no
    # namespace_source stamped on the request (canonical wire).
    assert envelope["payload"]["namespace"] == "rico"
    assert "namespace_source" not in envelope["payload"]
    assert "namespace" not in envelope["payload"]["identity"]


def test_response_wire_validates_and_yields_expected_shape():
    """(fix 5b) The fixture response.wire validates through the client guard.

    Parses the shared fixture's canonical response bytes and runs them through
    ``_validate_nats_context_pack_response_envelope`` with the fixture's
    correlation id. It must validate (kind == context_pack_response,
    correlation_id match, operation agent_context_pack) and expose the
    response-only ``namespace_source`` in the payload.
    """
    fixture = _load_wire_fixture()
    response = json.loads(fixture["response"]["wire"])

    # Guard accepts the canonical response for the matching request id.
    _validate_nats_context_pack_response_envelope(
        response,
        expected_correlation_id=fixture["request"]["envelope"]["correlation_id"],
    )

    assert response["kind"] == CONTEXT_PACK_REPLY_KIND == "context_pack_response"
    assert (
        response["correlation_id"]
        == fixture["request"]["envelope"]["correlation_id"]
    )
    payload = response["payload"]
    assert payload["operation"] == "agent_context_pack"
    assert payload["status"] == "ok"
    # namespace_source is a RESPONSE-ONLY field (never on the request wire).
    assert payload["namespace_source"] == "override"

    # A mismatched correlation id must be rejected (cross-talk guard).
    with pytest.raises(Exception, match="did not match"):
        _validate_nats_context_pack_response_envelope(
            response,
            expected_correlation_id="not-the-request-id",
        )


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
