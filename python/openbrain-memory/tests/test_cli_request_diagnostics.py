"""Regressions for the errors a hand-assembled request actually gets back.

Every case here was hit by a human during the FIRST real client install
(2026-08-04). None of them was a wrong result -- the runtime refused requests it
was right to refuse. They are all failures of the RECEIPT: it named a third of
the problem, or named a key as ignorable and then failed on that same key, so
the caller paid one round trip per field to learn a set the runtime knew in
full on the first call.
"""

from __future__ import annotations

import pytest

from openbrain_memory.agent import EVENT_TYPES
from openbrain_memory.cli import execute_json, usage_output

from ._runtime_fakes import LaneAwareTransport

_FULL_SCOPE = {
    "agent": "agent-name",
    "platform": "claude-code",
    "server_id": "server-id",
    "channel_id": "channel-id",
    "session_key": "session-key",
}
# Config is supplied EXPLICITLY, never inherited from the environment.
#
# Without it these tests read OPENBRAIN_BASE_URL from the developer's shell, so
# they passed on a machine that had the env set and failed in CI with
# `base_url must be a non-empty string` -- config is built before the scope is
# validated, so the assertion never reached the error it was written for. A
# test that only passes where the environment is already right is the same
# defect this file exists to document.
_CONFIG = {
    "base_url": "https://brain.example",
    "namespace": "bilby",
    "token": "fixture-token",
}


def _error(request: dict[str, object]) -> str:
    output = execute_json(
        {"config": _CONFIG, **request},
        transport=LaneAwareTransport(),
    )
    receipt = output["receipt"]
    assert receipt["status"] == "failed"
    return str(receipt["error"])


def test_missing_scope_fields_are_all_named_in_one_receipt() -> None:
    """The Air satisfied `namespace`, then hit `server_id`, then the next one.

    Field-at-a-time validation made each error true and each error a fraction
    of the answer. Two missing fields must produce ONE receipt naming BOTH.
    """
    error = _error(
        {
            "operation": "recall",
            "query": "client install proof",
            "scope": {"agent": "agent-name", "platform": "claude-code"},
        }
    )

    assert "server_id" in error
    assert "channel_id" in error
    assert "session_key" in error
    assert "3 problems" in error


def test_scope_error_does_not_name_fields_that_were_supplied() -> None:
    error = _error(
        {
            "operation": "recall",
            "query": "client install proof",
            "scope": {**_FULL_SCOPE, "session_key": ""},
        }
    )

    assert "session_key" in error
    assert "agent" not in error
    assert "server_id" not in error


def test_top_level_namespace_is_rejected_by_where_it_belongs() -> None:
    """The contradictory receipt: ignored AND fatal, in the same JSON object.

    `namespace` was folded into `ignored_optional_request_keys` and the request
    then failed `namespace must be a non-empty string` -- the receipt called the
    key optional and died on it at once. Rejecting is deliberate:
    `docs/memory-contract.md` gives `config.namespace` as the ONE in-request
    override, so accepting a second top-level spelling would add an undocumented
    field with the same meaning.
    """
    output = execute_json(
        {
            "config": _CONFIG,
            "operation": "recall",
            "query": "client install proof",
            "namespace": "rico",
            "scope": _FULL_SCOPE,
        },
        transport=LaneAwareTransport(),
    )
    receipt = output["receipt"]
    error = str(receipt["error"])

    assert receipt["status"] == "failed"
    assert "OPENBRAIN_NAMESPACE" in error
    assert "environment" in error
    assert "config" in error
    # The key that killed the request is never also advertised as ignorable.
    assert "namespace" not in receipt.get("ignored_optional_request_keys", [])


@pytest.mark.parametrize("key", ["base_url", "token"])
def test_other_misplaced_config_keys_say_where_they_live(key: str) -> None:
    error = _error(
        {
            "operation": "recall",
            "query": "client install proof",
            key: "value",
            "scope": _FULL_SCOPE,
        }
    )

    assert f"OPENBRAIN_{key.upper()}" in error
    assert "config" in error


def test_ingest_keeps_its_own_top_level_namespace() -> None:
    """`ingest` DEFINES a top-level `namespace`; the guard must not eat it."""
    output = execute_json(
        {
            "config": _CONFIG,
            "operation": "ingest",
            "namespace": "rico",
            "turns": [],
            "scope": _FULL_SCOPE,
        },
        transport=LaneAwareTransport(),
    )

    assert "OPENBRAIN_NAMESPACE" not in str(output["receipt"].get("error") or "")


def test_help_names_the_environment_the_example_depends_on() -> None:
    """The example is a request body, and a body carries no identity.

    Following the example on a clean shell failed with "namespace must be a
    non-empty string" and said nothing about where namespace comes from.
    """
    environment = usage_output()["result"]["environment"]
    required = " ".join(environment["required"])

    assert "OPENBRAIN_NAMESPACE" in required
    assert "OPENBRAIN_BASE_URL" in required
    assert "OPENBRAIN_TOKEN" in required
    # The help must not redact its own explanation.
    assert "REDACTED" not in required


def test_help_example_carries_the_full_required_scope() -> None:
    example = usage_output()["result"]["example"]

    assert set(example["scope"]) == set(_FULL_SCOPE)


def test_capture_rejects_kind_by_name_instead_of_ignoring_it() -> None:
    """`kind` was accepted-and-dropped, so a misclassified event exited 0 (#598).

    It landed in `ignored_optional_request_keys`: the caller asked for
    `decision`, the row was stored with the default type, and the receipt said
    fine. A key that names a real field the caller expected to take effect is
    rejected, not relegated.
    """
    output = execute_json(
        {
            "config": _CONFIG,
            "operation": "capture",
            "distilled": True,
            "event_type": "fact",
            "kind": "decision",
            "content": "kind must not be silently dropped",
            "scope": _FULL_SCOPE,
        },
        transport=LaneAwareTransport(),
    )
    receipt = output["receipt"]
    error = str(receipt["error"])

    assert receipt["status"] == "failed"
    assert receipt["durable"] is False
    # Rejected BY NAME, and pointed at the spelling that works.
    assert "kind" in error
    assert "event_type" in error
    # The key that killed the request is never also advertised as ignorable.
    assert "kind" not in receipt.get("ignored_optional_request_keys", [])


def test_kind_rejection_lists_the_legal_event_types_from_the_one_vocabulary() -> None:
    """Naming the key without the accepted set leaves no way to be right.

    The values are asserted against `EVENT_TYPES` itself rather than a literal
    list, so this test cannot become the second hand-maintained copy of the
    vocabulary it exists to protect (#412).
    """
    error = _error(
        {
            "operation": "capture",
            "distilled": True,
            "event_type": "fact",
            "kind": "decision",
            "content": "vocabulary must arrive whole",
            "scope": _FULL_SCOPE,
        }
    )

    for event_type in EVENT_TYPES:
        assert event_type in error


def test_unrecognised_optional_keys_are_still_ignored_not_rejected() -> None:
    """Only `kind` changes behavior; a key that means nothing still ignores.

    The #464 named-ignore machinery is the right answer for a key the runtime
    has no field for, and turning every unknown key into a hard failure would
    be a different, larger change than #598 asks for.
    """
    output = execute_json(
        {
            "config": _CONFIG,
            "operation": "capture",
            "distilled": True,
            "event_type": "fact",
            "totally_unknown_key": "value",
            "content": "unknown keys stay ignorable",
            "scope": _FULL_SCOPE,
        },
        transport=LaneAwareTransport(),
    )
    receipt = output["receipt"]

    assert receipt["status"] != "failed"
    assert "totally_unknown_key" in receipt["ignored_optional_request_keys"]


def test_kind_is_only_rejected_where_event_type_is_a_real_field() -> None:
    """`recall` has no `event_type`, so `kind` there is merely unrecognised.

    The guard fires on the operation that owns the field it redirects to; on
    every other lane `kind` keeps the documented ignore behavior.
    """
    output = execute_json(
        {
            "config": _CONFIG,
            "operation": "recall",
            "query": "kind on a lane without event_type",
            "kind": "decision",
            "scope": _FULL_SCOPE,
        },
        transport=LaneAwareTransport(),
    )
    receipt = output["receipt"]

    assert receipt["status"] != "failed"
    assert "kind" in receipt["ignored_optional_request_keys"]
