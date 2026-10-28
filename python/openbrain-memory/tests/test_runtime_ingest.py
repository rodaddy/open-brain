"""Raw-turn full-send lane tests.

The defect these exist to prevent, measured 2026-07-25: per-turn capture
recorded 21 of the user's turns and ZERO of the assistant's, because the only
write verbs available were distilled ones that required a client-side salience
judgment. Every test here asserts the raw lane makes NO such judgment.
"""

from __future__ import annotations

import json

import pytest

from openbrain_memory.cli import execute_json

from ._runtime_fakes import LaneAwareTransport, request_payload, tool_calls


def _turn(index: int = 0, **overrides: object) -> dict[str, object]:
    turn: dict[str, object] = {
        "turn_uuid": f"turn-{index}",
        "turn_index": index,
        "role": "assistant",
        "content": "Measured: enqueueGraphDerivationJobs has zero callers.",
    }
    turn.update(overrides)
    return turn


def _request(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {"turns": [_turn()]}
    values.update(overrides)
    return request_payload("ingest", **values)


def test_ingest_dispatches_the_raw_turn_tool() -> None:
    transport = LaneAwareTransport()

    output = execute_json(_request(), transport=transport)

    assert output["receipt"]["operation"] == "ingest"
    assert output["receipt"]["status"] == "saved"
    assert output["receipt"]["durable"] is True
    dispatched = tool_calls(transport)[-1]["params"]
    assert dispatched["name"] == "ingest_raw_turn"
    assert dispatched["arguments"]["turns"][0]["turn_uuid"] == "turn-0"


def test_assistant_turns_are_ingested() -> None:
    """The exact half that per-turn capture never recorded."""
    transport = LaneAwareTransport()

    execute_json(
        _request(turns=[_turn(role="assistant", content="My analysis.")]),
        transport=transport,
    )

    sent = tool_calls(transport)[-1]["params"]["arguments"]["turns"][0]
    assert sent["role"] == "assistant"
    assert sent["content"] == "My analysis."


@pytest.mark.parametrize("role", ["user", "assistant", "tool"])
def test_every_role_is_accepted(role: str) -> None:
    transport = LaneAwareTransport()

    output = execute_json(
        _request(turns=[_turn(role=role)]),
        transport=transport,
    )

    assert output["receipt"]["status"] == "saved"
    assert tool_calls(transport)[-1]["params"]["arguments"]["turns"][0]["role"] == role


def test_raw_content_is_shipped_verbatim_not_distilled() -> None:
    """The lane rule: no summarizing, no scoring, no salience filter.

    A bare acknowledgement carries no durable content and the distilled verbs
    would reject or skip it. The raw lane MUST ship it, because deciding what
    matters is the server's job and re-runnable.
    """
    transport = LaneAwareTransport()

    output = execute_json(
        _request(turns=[_turn(content="ok")]),
        transport=transport,
    )

    assert output["receipt"]["status"] == "saved"
    assert tool_calls(transport)[-1]["params"]["arguments"]["turns"][0]["content"] == (
        "ok"
    )


def test_secret_bearing_content_is_not_rejected_client_side() -> None:
    """Redaction is the SERVER's job: value-only, statement kept.

    Fail-closed was explicitly rejected -- dropping a turn because it contains
    a credential discards the durable decision that is the point of capturing
    it. The client must not silently refuse the turn.
    """
    raw = "export AUTH_TOKEN_ADMIN=sk-live-not-a-real-secret-value"
    transport = LaneAwareTransport()

    output = execute_json(_request(turns=[_turn(content=raw)]), transport=transport)

    assert output["receipt"]["status"] == "saved"
    sent = tool_calls(transport)[-1]["params"]["arguments"]["turns"][0]
    assert sent["content"] == raw


def test_ingest_carries_no_distilled_flag() -> None:
    """distilled=true is the distilled lane's assertion and must not appear."""
    transport = LaneAwareTransport()

    execute_json(_request(), transport=transport)

    arguments = tool_calls(transport)[-1]["params"]["arguments"]
    assert "distilled" not in arguments
    assert "event_type" not in arguments


def test_optional_provenance_fields_are_forwarded() -> None:
    transport = LaneAwareTransport()

    execute_json(
        _request(
            turns=[
                _turn(
                    prompt_id="prompt-9",
                    session_ref="/transcripts/a.jsonl",
                    logical_parent_turn_uuid="turn-before-compact",
                    repo="open-brain",
                    git_branch="feat/380-raw-turns-ingest",
                    runtime="claude",
                    is_human_prompt=False,
                    token_estimate=64,
                    metadata={"model": "opus"},
                )
            ]
        ),
        transport=transport,
    )

    sent = tool_calls(transport)[-1]["params"]["arguments"]["turns"][0]
    assert sent["prompt_id"] == "prompt-9"
    assert sent["logical_parent_turn_uuid"] == "turn-before-compact"
    assert sent["git_branch"] == "feat/380-raw-turns-ingest"
    assert sent["is_human_prompt"] is False
    assert sent["token_estimate"] == 64
    assert sent["metadata"] == {"model": "opus"}


def test_namespace_is_forwarded_when_supplied() -> None:
    transport = LaneAwareTransport()

    execute_json(_request(namespace="shared-kb"), transport=transport)

    assert tool_calls(transport)[-1]["params"]["arguments"]["namespace"] == "shared-kb"


def test_batches_are_sent_in_one_call() -> None:
    """Batching keeps the interactive turn unblocked."""
    transport = LaneAwareTransport()

    execute_json(
        _request(turns=[_turn(i) for i in range(5)]),
        transport=transport,
    )

    calls = [
        c for c in tool_calls(transport) if c["params"]["name"] == "ingest_raw_turn"
    ]
    assert len(calls) == 1
    assert len(calls[0]["params"]["arguments"]["turns"]) == 5


@pytest.mark.parametrize(
    ("turns", "expected"),
    [
        ([], "turns must not be empty"),
        ([{"turn_index": 0, "role": "user"}], "turns[0].content must be a string"),
        (
            [{"turn_uuid": "a", "turn_index": 0, "role": "bot", "content": "x"}],
            "turns[0].role must be one of user, assistant, tool",
        ),
        (
            [{"turn_uuid": "a", "role": "user", "content": "x"}],
            "turns[0].turn_index must be an integer",
        ),
        (
            [{"turn_index": 0, "role": "user", "content": "x"}],
            "turns[0].turn_uuid is required",
        ),
    ],
)
def test_structural_validation_rejects_non_turns(
    turns: list[dict[str, object]],
    expected: str,
) -> None:
    """Shape only -- a turn is refused for not being a turn, never for content."""
    transport = LaneAwareTransport()

    output = execute_json(_request(turns=turns), transport=transport)

    assert output["receipt"]["status"] == "failed"
    assert output["receipt"]["error"] == expected
    assert tool_calls(transport) == []


def test_oversize_batch_is_rejected_before_the_transport() -> None:
    transport = LaneAwareTransport()

    output = execute_json(
        _request(turns=[_turn(i) for i in range(101)]),
        transport=transport,
    )

    assert output["receipt"]["status"] == "failed"
    assert output["receipt"]["error"] == "turns must contain at most 100 entries"
    assert tool_calls(transport) == []


def test_unknown_request_key_is_not_forwarded() -> None:
    transport = LaneAwareTransport()

    output = execute_json(_request(future_optional="ignored"), transport=transport)

    assert output["receipt"]["status"] == "saved"
    assert "future_optional" not in json.dumps(tool_calls(transport))
