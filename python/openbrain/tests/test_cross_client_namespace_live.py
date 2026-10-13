"""Namespace isolation across EVERY supported client, against the real service.

Release gate 4 (issue 299) claims "zero namespace leaks", but the only evidence
is a server-side probe through one MCP client pair
(``scripts/eval-open-brain-live.ts:181``). Nothing shows that data written by
each supported client -- the Claude Stop hook, the Codex Stop hook, and the
Python ``OpenBrainClient`` -- lands in the writing token's namespace and stays
there.

Namespace is derived server-side from the token identity
(``server/tools/memory-helpers.ts:141``: ``requestedNamespace ?? identity.clientId``);
a caller never picks it. So the claim has two halves, and both are proven here
against the playground:

1. Every client writes under ONE namespace -- the writer's -- read straight out
   of Postgres (``ob_raw_turns.namespace``, ``ob_session_lanes.namespace``).
2. A SECOND identity, holding its own valid token, gets none of it back: not
   through ``session_context`` on the exact lane key, not through ``search_all``
   on a marker string that exists only in the first identity's data.

Environment (all four required; the fixture FAILS loudly without them, per the
plan's rule that a live gate must never pass having run nothing):

    OPENBRAIN_TEST_BASE_URL       the PLAYGROUND service, e.g. http://127.0.0.1:3101
    OPENBRAIN_TEST_TOKEN          identity A's token
    OPENBRAIN_TEST_OTHER_TOKEN    identity B's token -- a DIFFERENT identity
    OPENBRAIN_TEST_DATABASE_URL   the PLAYGROUND clone, for row verification

Point these at the playground only (``docs/local-playground.md``); test turns do
not belong in the real memory.
"""

from __future__ import annotations

import json
import os
import uuid
from typing import TYPE_CHECKING, Any

import pytest
from openbrain_memory import OpenBrainClient

from conftest import Secret, operator_line, write_lines
from openbrain.apps.hooks.session import StopHook, run_stop
from openbrain.config import CaptureSettings

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

pytestmark = pytest.mark.live

REQUIRED_ENV = (
    "OPENBRAIN_TEST_BASE_URL",
    "OPENBRAIN_TEST_TOKEN",
    "OPENBRAIN_TEST_OTHER_TOKEN",
    "OPENBRAIN_TEST_DATABASE_URL",
)


@pytest.fixture
def live_env() -> dict[str, Secret]:
    """The live configuration, or a FAILURE naming what is missing.

    A skip here would recreate the measured defect this marker exists to
    prevent: ``AGENTS.md`` -- live tests that "SKIP SILENTLY ... so a green run
    may have tested nothing".
    """
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        pytest.fail(
            "live gate misconfigured -- refusing to pass while testing "
            f"nothing. Missing: {', '.join(missing)}"
        )
    return {name: Secret(os.environ[name]) for name in REQUIRED_ENV}


def _client(base_url: str, token: str) -> OpenBrainClient:
    """A client for one token.

    The ``namespace`` argument is the caller's REQUEST, not the decision: the
    server resolves the effective namespace from the token identity. Passing a
    placeholder here is what lets the test observe what the server actually
    chose, rather than what the caller asked for.
    """
    return OpenBrainClient(
        base_url,
        token,
        "cross-client-namespace-probe",
        timeout=30.0,
        allow_insecure_http=True,
    )


@pytest.fixture
def client_a(live_env: dict[str, Secret]) -> Iterator[OpenBrainClient]:
    """Identity A -- the one that writes through all three client paths."""
    client = _client(live_env["OPENBRAIN_TEST_BASE_URL"].get(), live_env["OPENBRAIN_TEST_TOKEN"].get())
    try:
        yield client
    finally:
        client.close()


@pytest.fixture
def client_b(live_env: dict[str, Secret]) -> Iterator[OpenBrainClient]:
    """Identity B -- a different valid token, which must see none of A's data."""
    client = _client(
        live_env["OPENBRAIN_TEST_BASE_URL"].get(), live_env["OPENBRAIN_TEST_OTHER_TOKEN"].get()
    )
    try:
        yield client
    finally:
        client.close()


def _tool_payload(result: dict[str, Any]) -> Any:
    """The decoded tool payload, or the envelope itself when there is no content."""
    if "content" not in result:
        return result
    content = result["content"]
    assert isinstance(content, list) and content
    text = content[0].get("text")
    assert isinstance(text, str)
    return json.loads(text)


def turn_namespaces(database_url: str, session: str) -> list[str]:
    """Every ``ob_raw_turns.namespace`` this session landed under."""
    import psycopg

    with psycopg.connect(database_url) as connection:
        rows = connection.execute(
            "SELECT namespace FROM ob_raw_turns WHERE session_ref = %s",
            (session,),
        ).fetchall()
    return [str(row[0]) for row in rows]


def lane_namespace(database_url: str, session_key: str) -> str | None:
    """The namespace of the lane holding a ``session_key``'s events.

    ``ob_session_events`` carries no namespace of its own
    (``server/db/migrations/013_session_events.sql:5``); it inherits the lane's
    (``012_session_lanes.sql:8``), so the join is where the truth is.
    """
    import psycopg

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT DISTINCT lane.namespace FROM ob_session_events AS event "
            "JOIN ob_session_lanes AS lane ON lane.id = event.lane_id "
            "WHERE lane.session_key = %s",
            (session_key,),
        ).fetchall()
    assert len(row) <= 1, f"session_key {session_key} spans namespaces: {row}"
    return None if not row else str(row[0][0])


def _claude_write(
    live_env: dict[str, Secret], tmp_path: Path, marker: str
) -> tuple[str, StopHook, CaptureSettings]:
    """W1 -- the Claude Stop inputs: the session, the hook payload, the settings."""
    session = f"xclient-claude-{marker}"
    transcript = tmp_path / "claude.jsonl"
    write_lines(
        transcript,
        [operator_line(f"u-{uuid.uuid4()}", f"claude marker {marker}", session=session)],
    )
    settings = CaptureSettings(
        base_url=live_env["OPENBRAIN_TEST_BASE_URL"].get(),
        token=live_env["OPENBRAIN_TEST_TOKEN"].get(),
        watermark_path=tmp_path / "claude-wm.sqlite",
    )
    return session, StopHook(transcript_path=transcript, session_id=session), settings


def codex_turn_lines(session: str, turn_id: str, operator: str, reply: str) -> list[str]:
    """One Codex rollout turn: the operator's words and the assistant's reply.

    Copied from ``test_codex_hook_capture_live.py:89`` rather than imported --
    one test module importing another's helpers couples their lifetimes.
    """
    return [
        json.dumps(
            {
                "timestamp": "2026-09-16T20:00:03.000Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": operator}],
                    "internal_chat_message_metadata_passthrough": {
                        "turn_id": turn_id,
                        "create_time": 1789588532.9,
                        "content_item_kinds": ["user.text"],
                    },
                },
            }
        ),
        json.dumps(
            {
                "timestamp": "2026-09-16T20:00:04.000Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "phase": "final_answer",
                    "content": [{"type": "output_text", "text": reply}],
                    "internal_chat_message_metadata_passthrough": {
                        "turn_id": turn_id,
                        "create_time": 1789588533.9,
                        "content_item_kinds": ["unknown"],
                    },
                },
            }
        ),
    ]


def codex_head(session: str, turn_id: str) -> list[str]:
    """The rollout preamble: session metadata and the turn's start event."""
    return [
        json.dumps(
            {
                "timestamp": "2026-09-16T20:00:00.000Z",
                "type": "session_meta",
                "payload": {"id": session, "session_id": session},
            }
        ),
        json.dumps(
            {
                "timestamp": "2026-09-16T20:00:01.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "task_started",
                    "turn_id": turn_id,
                    "started_at": 1,
                    "model_context_window": 1000,
                    "collaboration_mode_kind": "default",
                },
            }
        ),
    ]


def _python_write(client: OpenBrainClient, marker: str) -> str:
    """W3 -- a lane plus one marked event through the Python client. Returns the key."""
    session_key = f"xclient-python/{marker}"
    _tool_payload(
        client.session_start(
            session_key=session_key,
            agent="cross-client-namespace-live",
            project="cross-client-namespace-live",
            topic="namespace isolation across clients",
        )
    )
    appended = _tool_payload(
        client.append_session_event(
            session_key=session_key,
            event_type="receipt",
            content=f"python client marker {marker}",
            source="tests/test_cross_client_namespace_live.py",
            importance="cold",
        )
    )
    assert isinstance(appended.get("event_id"), str)
    return session_key


def _observed_namespace(client: OpenBrainClient, database_url: str, label: str) -> str:
    """The namespace the SERVER assigns this token, learned by writing one event.

    Nothing in the client tells you which namespace a token resolves to -- the
    server derives it (``memory-helpers.ts:141``). So the only honest way to
    learn it is to write a throwaway lane and read back the namespace Postgres
    recorded.
    """
    probe_key = f"xclient-probe-{label}/{uuid.uuid4()}"
    _tool_payload(
        client.session_start(
            session_key=probe_key,
            agent="cross-client-namespace-live",
            project="cross-client-namespace-live",
            topic="namespace discovery probe",
        )
    )
    _tool_payload(
        client.append_session_event(
            session_key=probe_key,
            event_type="receipt",
            content=f"namespace discovery probe {label}",
            source="tests/test_cross_client_namespace_live.py",
            importance="cold",
        )
    )
    namespace = lane_namespace(database_url, probe_key)
    assert namespace, f"identity {label} wrote no lane namespace for {probe_key}"
    return namespace


class TestEveryClientWritesIntoTheWritingTokenNamespace:
    """The first half of the gate-4 claim: one writer, one namespace, all clients."""

    async def test_claude_codex_and_python_writes_share_one_namespace(
        self, live_env: dict[str, Secret], client_a: OpenBrainClient, tmp_path: Path
    ) -> None:
        marker = str(uuid.uuid4())
        database_url = live_env["OPENBRAIN_TEST_DATABASE_URL"].get()

        claude_session, payload, settings = _claude_write(live_env, tmp_path, marker)
        claude_result = await run_stop(payload, settings)
        assert claude_result is not None
        assert claude_result.delivered == 1

        codex_session = await _run_codex_stop(live_env, tmp_path, marker)

        python_key = _python_write(client_a, marker)

        observed = {
            *turn_namespaces(database_url, claude_session),
            *turn_namespaces(database_url, codex_session),
        }
        python_namespace = lane_namespace(database_url, python_key)
        assert python_namespace
        observed.add(python_namespace)

        # ONE namespace across all three client paths, and not the empty string.
        assert len(observed) == 1, f"clients split across namespaces: {sorted(observed)}"
        assert observed.pop().strip()

    async def test_identity_a_reads_its_own_python_event_back(
        self, client_a: OpenBrainClient
    ) -> None:
        marker = str(uuid.uuid4())
        python_key = _python_write(client_a, marker)

        context = _tool_payload(
            client_a.session_context(
                session_key=python_key, include_events=True, event_limit=10
            )
        )
        lane = context.get("lane")
        assert isinstance(lane, dict)
        assert lane.get("session_key") == python_key
        events = context.get("events")
        assert isinstance(events, list)
        assert any(marker in str(event.get("content")) for event in events)


async def _run_codex_stop(live_env: dict[str, Secret], tmp_path: Path, marker: str) -> str:
    """W2 -- one Codex rollout turn pair through the real Stop hook."""
    session = f"xclient-codex-{marker}"
    turn_id = f"codex-turn-{uuid.uuid4()}"
    transcript = tmp_path / "rollout.jsonl"
    write_lines(
        transcript,
        [
            *codex_head(session, turn_id),
            *codex_turn_lines(
                session, turn_id, f"codex operator marker {marker}", f"codex reply {marker}"
            ),
        ],
    )
    settings = CaptureSettings(
        base_url=live_env["OPENBRAIN_TEST_BASE_URL"].get(),
        token=live_env["OPENBRAIN_TEST_TOKEN"].get(),
        watermark_path=tmp_path / "codex-wm.sqlite",
    )
    result = await run_stop(
        StopHook(transcript_path=transcript, session_id=session), settings
    )
    assert result is not None
    assert result.delivered == 2
    return session


class TestASecondIdentitySeesNoneOfIt:
    """The second half: a different valid token gets nothing back, by any route."""

    async def test_identity_b_cannot_read_identity_a_lane_or_find_its_marker(
        self,
        live_env: dict[str, Secret],
        client_a: OpenBrainClient,
        client_b: OpenBrainClient,
    ) -> None:
        marker = str(uuid.uuid4())
        database_url = live_env["OPENBRAIN_TEST_DATABASE_URL"].get()
        python_key = _python_write(client_a, marker)

        namespace_a = lane_namespace(database_url, python_key)
        namespace_b = _observed_namespace(client_b, database_url, "b")
        # The premise: these really are two identities, not one token twice.
        assert namespace_a
        assert namespace_a != namespace_b

        _assert_no_lane_access(client_b, python_key, marker)

        # A lane event is not indexed by search_all (measured: its own writer
        # gets zero hits), so searching for it proves nothing. A logged thought
        # IS indexed at once, so the search probe uses one, with the writer
        # finding it as the control that makes identity B's empty result mean
        # something.
        client_a.log_thought(content=f"cross-client isolation thought {marker}")
        assert _marker_hits(client_a, marker), "control failed: the writer cannot find it"
        assert not _marker_hits(client_b, marker), (
            "LEAK: search_all surfaced identity A's marker to identity B"
        )


def _assert_no_lane_access(
    client: OpenBrainClient, session_key: str, marker: str
) -> None:
    """``session_context`` on A's exact key hands this client no marked event."""
    context = _tool_payload(
        client.session_context(session_key=session_key, include_events=True, event_limit=10)
    )
    events = context.get("events") if isinstance(context, dict) else None
    if isinstance(events, list):
        assert not [
            event for event in events if marker in str(event.get("content"))
        ], "LEAK: session_context returned identity A's marked event to identity B"


def _marker_hits(client: OpenBrainClient, marker: str) -> list[Any]:
    """The ``search_all`` results, for this client, that carry the marker."""
    found = _tool_payload(client.search_all(query=marker, limit=20, sources="brain"))
    results = found.get("results") if isinstance(found, dict) else None
    assert isinstance(results, list)
    return [item for item in results if marker in json.dumps(item)]
