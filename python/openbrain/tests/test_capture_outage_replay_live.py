"""Ordered replay after a real outage, live, for both transcript shapes.

Release gate 4 (issue 296). The replay claim -- "a turn written while the
service was unreachable is HELD, not lost, and comes back in transcript order
once the service returns" -- is proven elsewhere only against fake transports
(``test_capture_outage_notice.py``, ``test_capture_hooks.py``). Here the outage
is REAL: the client talks to the playground through a local TCP forwarder
(``Link``) on a fixed port. While the forwarder is down the port refuses
connections, so the failure comes out of the actual transport rather than an
injected lane; when it comes back up the SAME ``base_url`` reaches the service.
Keeping the URL constant matters: the watermark key is scoped by an origin
derived from ``base_url`` (``session.py:620-639``), so an outage simulated by
switching URLs would resume under a different key and prove only server-side
dedupe. Nothing is monkeypatched and no source is touched.

The observed outage behaviour: ``run_stop`` RAISES
``openbrain_memory.client.OpenBrainHTTPError`` ("Open Brain request failed:
[Errno 61] Connection refused context=transport"). It surfaces rather than
returning a receipt by design -- ``session.py:538-541`` -- and that raise is
what leaves the watermark unadvanced, which IS the replay mechanism.

Both shapes the Stop hook accepts get the same proof, because they parse
through different readers: the Claude transcript (``type: user`` lines) and the
Codex rollout (``response_item`` records). The rollout builders below are
COPIED from ``test_codex_hook_capture_live.py`` rather than imported -- a test
module is not a library, and importing one from another couples two live files.

Environment (all three required; the fixture FAILS loudly without them):

    OPENBRAIN_TEST_BASE_URL       the PLAYGROUND service, e.g. http://127.0.0.1:3101
    OPENBRAIN_TEST_TOKEN          a token that service accepts
    OPENBRAIN_TEST_DATABASE_URL   the PLAYGROUND clone, for row verification

Point these at the playground only (``docs/local-playground.md``); test turns do
not belong in the real memory.
"""

from __future__ import annotations

import contextlib
import json
import os
import socket
import socketserver
import threading
import uuid
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

import pytest
from openbrain_memory.client import OpenBrainHTTPError

from conftest import (
    Secret,
    append_lines,
    operator_line,
    scoped_capture_key,
    write_lines,
)
from openbrain.apps.capture.watermark import WatermarkStore
from openbrain.apps.hooks.session import StopHook, run_stop
from openbrain.config import CaptureSettings

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

pytestmark = pytest.mark.live

REQUIRED_ENV = (
    "OPENBRAIN_TEST_BASE_URL",
    "OPENBRAIN_TEST_TOKEN",
    "OPENBRAIN_TEST_DATABASE_URL",
)


def _pump(source: socket.socket, sink: socket.socket) -> None:
    """Copy bytes one way until either side closes."""
    try:
        while chunk := source.recv(65536):
            sink.sendall(chunk)
    except OSError:
        pass
    finally:
        for half in (source, sink):
            with contextlib.suppress(OSError):
                half.shutdown(socket.SHUT_RDWR)


class Link:
    """A switchable TCP path to the playground on one fixed local port.

    Down, the port is closed and a connect fails at once with ECONNREFUSED --
    the cheapest honest outage: no timeout wait, no fake transport. Up, bytes
    are forwarded verbatim, so the client sees the real service at the same URL.
    """

    def __init__(self, target: str) -> None:
        """Reserve a free local port for ``target``; the link starts DOWN."""
        parts = urlsplit(target)
        assert parts.hostname is not None
        assert parts.port is not None
        self._target = (parts.hostname, parts.port)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self._port = int(probe.getsockname()[1])
        self.base_url = f"http://127.0.0.1:{self._port}"
        self._server: socketserver.ThreadingTCPServer | None = None

    def up(self) -> None:
        target = self._target

        class Forward(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                with socket.create_connection(target) as upstream:
                    back = threading.Thread(
                        target=_pump, args=(upstream, self.request), daemon=True
                    )
                    back.start()
                    _pump(self.request, upstream)
                    back.join(timeout=5)

        socketserver.ThreadingTCPServer.allow_reuse_address = True
        self._server = socketserver.ThreadingTCPServer(("127.0.0.1", self._port), Forward)
        self._server.daemon_threads = True
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def down(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None


@pytest.fixture
def link(live_env: dict[str, Secret]) -> Iterator[Link]:
    """The switchable path, DOWN to begin with, closed again afterwards."""
    path = Link(live_env["OPENBRAIN_TEST_BASE_URL"].get())
    try:
        yield path
    finally:
        path.down()


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


def stored_turns(database_url: str, session: str) -> list[tuple[str, str]]:
    """Every ``(role, content)`` this session has landed, in transcript order."""
    import psycopg

    with psycopg.connect(database_url) as connection:
        rows = connection.execute(
            "SELECT role, content FROM ob_raw_turns "
            "WHERE session_ref = %s ORDER BY turn_index",
            (session,),
        ).fetchall()
    return [(str(row[0]), str(row[1])) for row in rows]


def codex_turn_lines(turn_id: str, operator: str, reply: str) -> list[str]:
    """One Codex rollout turn: the operator's words and the assistant's reply.

    Copied from ``test_codex_hook_capture_live.py``; the record shape is the
    native TUI one exercised by
    ``scripts/done-means/fixtures/512-codex-tui-stop.jsonl``.
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


def link_settings(live_env: dict[str, Secret], link: Link, watermark: Path) -> CaptureSettings:
    """ONE settings object for outage and recovery: same URL, token, watermark."""
    return CaptureSettings(
        base_url=link.base_url,
        token=live_env["OPENBRAIN_TEST_TOKEN"].get(),
        watermark_path=watermark,
    )


def one_codex_turn_rollout(path: Path, session: str, prompt: str, reply: str) -> None:
    """Write a complete one-turn Codex rollout for ``session`` at ``path``."""
    turn = f"codex-turn-{uuid.uuid4()}"
    write_lines(path, [*codex_head(session, turn), *codex_turn_lines(turn, prompt, reply)])


def other_token_or_fail() -> str:
    """The SECOND live token, or a failure naming it.

    A different token is a different capture origin
    (``session.py:620-635``), which is what makes the foreign-session step a
    real boundary rather than a restatement of the same origin.
    """
    token = os.environ.get("OPENBRAIN_TEST_OTHER_TOKEN")
    if not token:
        pytest.fail(
            "live gate misconfigured -- refusing to pass while testing nothing. "
            "Missing: OPENBRAIN_TEST_OTHER_TOKEN (a SECOND token the playground "
            "accepts, used to prove a foreign origin does not recover a session)"
        )
    return token


async def close_a_session_against_a_dead_service(
    settings: CaptureSettings, rollout: Path, session: str, database_url: str
) -> None:
    """Fail one session's FINAL Stop for real, and prove it left no trace."""
    with pytest.raises(OpenBrainHTTPError) as outage:
        await run_stop(StopHook(transcript_path=rollout, session_id=session), settings)
    assert "Connection refused" in str(outage.value)
    assert stored_turns(database_url, session) == []
    assert await WatermarkStore(settings.watermark_path).offset_for(
        scoped_capture_key(settings, session)
    ) == 0


async def deliver_a_foreign_session(
    live_env: dict[str, Secret], link: Link, watermark: Path, token: str
) -> None:
    """Run a healthy Stop under a DIFFERENT token: a different origin."""
    session = f"recover-f-{uuid.uuid4()}"
    rollout = watermark.parent / "f.jsonl"
    one_codex_turn_rollout(rollout, session, "prompt f", "reply f")
    settings = CaptureSettings(
        base_url=link.base_url, token=token, watermark_path=watermark
    )
    assert live_env["OPENBRAIN_TEST_TOKEN"].get() != token
    foreign = await run_stop(
        StopHook(transcript_path=rollout, session_id=session), settings
    )
    assert foreign is not None
    assert foreign.delivered == 2


class TestACodexSessionClosedDuringAnOutageIsRecoveredByTheNext:
    """A Codex session whose FINAL Stop failed is drained by a LATER session.

    Release gate 4 (issue 512). ``run_stop`` registers the source as pending
    BEFORE it builds the client (``session.py:549-561``), so a refused
    connection leaves session A pending with no watermark and A never runs
    again. A later healthy Stop for session B delivers its own turns and then
    drains ONE oldest pending source for the SAME origin
    (``_replay_one_pending``, ``session.py:642``). Proven elsewhere only with a
    monkeypatched lane
    (``test_codex_hook_capture.py:201``); here the failure is a real refused
    TCP connection against the running playground.
    """

    async def test_a_later_session_drains_the_one_closed_by_the_outage(
        self, live_env: dict[str, Secret], link: Link, tmp_path: Path
    ) -> None:
        other_token = other_token_or_fail()
        database_url = live_env["OPENBRAIN_TEST_DATABASE_URL"].get()
        watermark = tmp_path / "wm.sqlite"  # ONE store for every session here.

        # --- 1. Session A's FINAL Stop fails against a dead service ---------
        session_a = f"recover-a-{uuid.uuid4()}"
        rollout_a = tmp_path / "a.jsonl"
        one_codex_turn_rollout(rollout_a, session_a, "prompt a", "reply a")
        settings_a = link_settings(live_env, link, watermark)
        await close_a_session_against_a_dead_service(
            settings_a, rollout_a, session_a, database_url
        )

        # --- 2. A FOREIGN token is a different origin and must NOT drain A --
        link.up()
        await deliver_a_foreign_session(live_env, link, watermark, other_token)
        assert stored_turns(database_url, session_a) == []

        # --- 3. Session B, same origin, drains A on top of its own turns ----
        session_b = f"recover-b-{uuid.uuid4()}"
        rollout_b = tmp_path / "b.jsonl"
        one_codex_turn_rollout(rollout_b, session_b, "prompt b", "reply b")
        settings_b = link_settings(live_env, link, watermark)
        payload_b = StopHook(transcript_path=rollout_b, session_id=session_b)
        recovered = await run_stop(payload_b, settings_b)

        assert recovered is not None
        # B's OWN receipt counts only B's turns; A's replay is a side effect.
        assert recovered.delivered == 2
        # stored_turns is keyed by session_ref, so reading A's two turns back
        # under session_a IS the assertion that the rows kept A's session_ref.
        assert stored_turns(database_url, session_a) == [
            ("user", "prompt a"), ("assistant", "reply a"),
        ]
        assert stored_turns(database_url, session_b) == [
            ("user", "prompt b"), ("assistant", "reply b"),
        ]

        # --- 4. A third Stop for B adds nothing and duplicates nothing ------
        third = await run_stop(payload_b, settings_b)
        assert third is not None
        assert third.delivered == 0
        assert len(stored_turns(database_url, session_a)) == 2


class TestAClaudeTranscriptSurvivesARealOutage:
    """Claude shape: three turns written while the service is unreachable."""

    async def test_turns_written_during_the_outage_replay_in_order(
        self, live_env: dict[str, Secret], link: Link, tmp_path: Path
    ) -> None:
        session = f"outage-claude-{uuid.uuid4()}"
        ids = [f"u-{uuid.uuid4()}" for _ in range(5)]
        contents = [f"turn {index}" for index in range(5)]
        transcript = tmp_path / "t.jsonl"
        watermark = tmp_path / "wm.sqlite"
        database_url = live_env["OPENBRAIN_TEST_DATABASE_URL"].get()

        # --- OUTAGE -------------------------------------------------------
        write_lines(
            transcript,
            [
                operator_line(ids[index], contents[index], session=session)
                for index in range(3)
            ],
        )
        settings = link_settings(live_env, link, watermark)
        payload = StopHook(transcript_path=transcript, session_id=session)

        # run_stop SURFACES the transport failure (session.py:538-541): the
        # entrypoint swallows it, the capability does not, and that raise is
        # exactly what leaves the watermark unadvanced. The type is asserted
        # precisely -- a wrong-endpoint 404 or an auth rejection would also
        # raise, and this test would be worthless if it accepted those.
        with pytest.raises(OpenBrainHTTPError) as outage:
            await run_stop(payload, settings)
        assert "Connection refused" in str(outage.value)

        # Nothing was written and nothing was acknowledged.
        assert stored_turns(database_url, session) == []
        assert await WatermarkStore(watermark).offset_for(
            scoped_capture_key(settings, session)
        ) == 0

        # --- RECOVERY -----------------------------------------------------
        append_lines(
            transcript,
            [
                operator_line(ids[index], contents[index], session=session)
                for index in range(3, 5)
            ],
        )
        # Same URL, same origin, so the same scoped watermark key resumes.
        link.up()
        recovered = await run_stop(payload, settings)

        assert recovered is not None
        assert recovered.delivered == 5
        # Every turn, exactly once, in transcript order -- the ones written
        # during the outage first.
        assert stored_turns(database_url, session) == [
            ("user", content) for content in contents
        ]
        assert await WatermarkStore(watermark).offset_for(
            scoped_capture_key(settings, session)
        ) == recovered.next_offset

        # A third Stop finds nothing new and duplicates nothing.
        third = await run_stop(payload, settings)
        assert third is not None
        assert third.delivered == 0
        assert stored_turns(database_url, session) == [
            ("user", content) for content in contents
        ]


class TestACodexRolloutSurvivesARealOutage:
    """Codex shape: the same claim through the rollout reader."""

    async def test_turns_written_during_the_outage_replay_in_order(
        self, live_env: dict[str, Secret], link: Link, tmp_path: Path
    ) -> None:
        session = f"outage-codex-{uuid.uuid4()}"
        turns = [f"codex-turn-{uuid.uuid4()}" for _ in range(5)]
        transcript = tmp_path / "rollout.jsonl"
        watermark = tmp_path / "wm.sqlite"
        database_url = live_env["OPENBRAIN_TEST_DATABASE_URL"].get()
        expected = [
            pair
            for index in range(5)
            for pair in (
                ("user", f"prompt {index}"),
                ("assistant", f"reply {index}"),
            )
        ]

        # --- OUTAGE -------------------------------------------------------
        write_lines(
            transcript,
            [
                *codex_head(session, turns[0]),
                *[
                    line
                    for index in range(3)
                    for line in codex_turn_lines(
                        turns[index], f"prompt {index}", f"reply {index}"
                    )
                ],
            ],
        )
        settings = link_settings(live_env, link, watermark)
        payload = StopHook(transcript_path=transcript, session_id=session)

        with pytest.raises(OpenBrainHTTPError) as outage:
            await run_stop(payload, settings)
        assert "Connection refused" in str(outage.value)

        assert stored_turns(database_url, session) == []
        assert await WatermarkStore(watermark).offset_for(
            scoped_capture_key(settings, session)
        ) == 0

        # --- RECOVERY -----------------------------------------------------
        append_lines(
            transcript,
            [
                line
                for index in range(3, 5)
                for line in codex_turn_lines(
                    turns[index], f"prompt {index}", f"reply {index}"
                )
            ],
        )
        # Same URL, same origin, so the same scoped watermark key resumes.
        link.up()
        recovered = await run_stop(payload, settings)

        assert recovered is not None
        assert recovered.delivered == 10
        assert stored_turns(database_url, session) == expected
        assert await WatermarkStore(watermark).offset_for(
            scoped_capture_key(settings, session)
        ) == recovered.next_offset

        third = await run_stop(payload, settings)
        assert third is not None
        assert third.delivered == 0
        assert stored_turns(database_url, session) == expected
