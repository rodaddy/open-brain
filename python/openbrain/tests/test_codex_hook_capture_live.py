"""The Codex Stop capability against the real thing: rollout -> client -> row.

``test_codex_hook_capture.py`` drives the same entrypoint (``run_stop``) with an
INJECTED ``lane_factory``, so every clause there stops at a recording fake. This
file drives the SAME entrypoint and the SAME Codex rollout payload shape with NO
``lane_factory``, so the real ``openbrain_memory`` client is built from
``CaptureSettings`` -- the wiring the Claude path already proves in
``test_capture_hooks_live.py``, now proven for Codex.

Environment (all three required; the fixture FAILS loudly without them, per the
plan's rule that a live gate must never pass having run nothing):

    OPENBRAIN_TEST_BASE_URL       the PLAYGROUND service, e.g. http://127.0.0.1:3101
    OPENBRAIN_TEST_TOKEN          a token that service accepts
    OPENBRAIN_TEST_DATABASE_URL   the PLAYGROUND clone, for row verification

Point these at the playground only (``docs/local-playground.md``); test turns do
not belong in the real memory.
"""

from __future__ import annotations

import json
import os
import uuid
from typing import TYPE_CHECKING

import pytest

from conftest import Secret, append_lines, scoped_capture_key, write_lines
from openbrain.apps.capture.watermark import WatermarkStore
from openbrain.apps.hooks.session import StopHook, run_stop
from openbrain.config import CaptureSettings

if TYPE_CHECKING:
    from pathlib import Path

pytestmark = pytest.mark.live

REQUIRED_ENV = (
    "OPENBRAIN_TEST_BASE_URL",
    "OPENBRAIN_TEST_TOKEN",
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


def fetch_attribution(database_url: str, turn_uuid: str) -> tuple[str, str] | None:
    """The stored ``(role, content)`` for a turn, or ``None`` when no row exists."""
    import psycopg

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT role, content FROM ob_raw_turns WHERE turn_uuid = %s",
            (turn_uuid,),
        ).fetchone()
    return None if row is None else (str(row[0]), str(row[1]))


def count_rows(database_url: str, session: str) -> int:
    """How many rows this session has landed."""
    import psycopg

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT count(*) FROM ob_raw_turns WHERE session_ref = %s",
            (session,),
        ).fetchone()
    assert row is not None
    return int(row[0])


def codex_turn_lines(session: str, turn_id: str, operator: str, reply: str) -> list[str]:
    """One Codex rollout turn: the operator's words and the assistant's reply.

    The record shape is the native TUI one exercised by
    ``scripts/done-means/fixtures/512-codex-tui-stop.jsonl`` -- a ``response_item``
    user message and a ``final_answer`` assistant message, both carrying the
    turn's ``turn_id`` in the passthrough metadata.
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


def live_settings(live_env: dict[str, Secret], watermark: Path) -> CaptureSettings:
    """Settings that build the REAL client -- no lane is injected anywhere here."""
    return CaptureSettings(
        base_url=live_env["OPENBRAIN_TEST_BASE_URL"].get(),
        token=live_env["OPENBRAIN_TEST_TOKEN"].get(),
        watermark_path=watermark,
    )


class TestCodexStopLandsBothRolesThroughTheRealClient:
    """A Codex Stop delivers operator and assistant speech into Postgres."""

    async def test_both_roles_reach_ob_raw_turns_whole(
        self, live_env: dict[str, Secret], tmp_path: Path
    ) -> None:
        session = f"codex-stop-live-{uuid.uuid4()}"
        turn_id = f"codex-turn-{uuid.uuid4()}"
        transcript = tmp_path / "rollout.jsonl"
        write_lines(
            transcript,
            [
                *codex_head(session, turn_id),
                *codex_turn_lines(
                    session,
                    turn_id,
                    "codex live operator prompt",
                    "codex live assistant reply",
                ),
            ],
        )

        settings = live_settings(live_env, tmp_path / "wm.sqlite")
        payload = StopHook(transcript_path=transcript, session_id=session)

        # No lane_factory: the real _started_memory builds the client.
        result = await run_stop(payload, settings)

        assert result is not None
        assert result.delivered == 2
        database_url = live_env["OPENBRAIN_TEST_DATABASE_URL"].get()
        # Role is queried ALONGSIDE content: a row proving the words survived
        # says nothing about whether the operator's half was filed as the
        # assistant's. Both halves land, each under its own role.
        assert count_rows(database_url, session) == 2
        stored = fetch_attribution(database_url, turn_id)
        assert stored is not None
        role, content = stored
        assert (role, content) == ("assistant", "codex live assistant reply")
        import psycopg

        with psycopg.connect(database_url) as connection:
            rows = connection.execute(
                "SELECT role, content FROM ob_raw_turns "
                "WHERE session_ref = %s ORDER BY turn_index",
                (session,),
            ).fetchall()
        assert [(str(row[0]), str(row[1])) for row in rows] == [
            ("user", "codex live operator prompt"),
            ("assistant", "codex live assistant reply"),
        ]
        assert await WatermarkStore(settings.watermark_path).offset_for(
            scoped_capture_key(settings, session)
        ) == result.next_offset


class TestCodexStopResumesFromTheWatermarkLive:
    """The RESUME shape, live.

    ``test_codex_hook_capture.py:201`` proves next-session recovery by making the
    lane RAISE (a monkeypatched ``_started_memory`` that fails the first Stop).
    That clause is unreachable here without fault injection, and injecting a
    failure would replace the real client -- the one thing this file exists to
    exercise. So the live claim is the resume shape instead: a second Stop on the
    same session after appending turns delivers ONLY the appended turns.
    """

    async def test_a_second_stop_delivers_only_the_appended_turns(
        self, live_env: dict[str, Secret], tmp_path: Path
    ) -> None:
        session = f"codex-resume-live-{uuid.uuid4()}"
        first_turn = f"codex-turn-{uuid.uuid4()}"
        transcript = tmp_path / "rollout.jsonl"
        write_lines(
            transcript,
            [
                *codex_head(session, first_turn),
                *codex_turn_lines(
                    session, first_turn, "the first operator prompt", "the first reply"
                ),
            ],
        )

        settings = live_settings(live_env, tmp_path / "wm.sqlite")
        payload = StopHook(transcript_path=transcript, session_id=session)
        database_url = live_env["OPENBRAIN_TEST_DATABASE_URL"].get()

        first = await run_stop(payload, settings)
        assert first is not None
        assert first.delivered == 2
        assert count_rows(database_url, session) == 2
        after_first = await WatermarkStore(settings.watermark_path).offset_for(
            scoped_capture_key(settings, session)
        )
        assert after_first == first.next_offset

        second_turn = f"codex-turn-{uuid.uuid4()}"
        append_lines(
            transcript,
            codex_turn_lines(
                session, second_turn, "the second operator prompt", "the second reply"
            ),
        )

        second = await run_stop(payload, settings)
        assert second is not None
        # ONLY the appended turns -- the first pair was never re-read.
        assert second.delivered == 2
        assert count_rows(database_url, session) == 4
        assert fetch_attribution(database_url, second_turn) == (
            "assistant",
            "the second reply",
        )
        after_second = await WatermarkStore(settings.watermark_path).offset_for(
            scoped_capture_key(settings, session)
        )
        assert after_second == second.next_offset
        assert after_second > after_first


class TestCodexStopReplayIsANoop:
    """A Stop with nothing new past the watermark writes nothing."""

    async def test_a_stop_with_no_new_turns_delivers_zero(
        self, live_env: dict[str, Secret], tmp_path: Path
    ) -> None:
        session = f"codex-noop-live-{uuid.uuid4()}"
        turn_id = f"codex-turn-{uuid.uuid4()}"
        transcript = tmp_path / "rollout.jsonl"
        write_lines(
            transcript,
            [
                *codex_head(session, turn_id),
                *codex_turn_lines(
                    session, turn_id, "the only operator prompt", "the only reply"
                ),
            ],
        )

        settings = live_settings(live_env, tmp_path / "wm.sqlite")
        payload = StopHook(transcript_path=transcript, session_id=session)
        database_url = live_env["OPENBRAIN_TEST_DATABASE_URL"].get()

        first = await run_stop(payload, settings)
        assert first is not None
        assert first.delivered == 2
        assert count_rows(database_url, session) == 2
        at_eof = await WatermarkStore(settings.watermark_path).offset_for(
            scoped_capture_key(settings, session)
        )

        # No append. A second Stop reads from EOF and finds nothing.
        second = await run_stop(payload, settings)
        assert second is not None
        assert second.delivered == 0
        assert count_rows(database_url, session) == 2
        assert await WatermarkStore(settings.watermark_path).offset_for(
            scoped_capture_key(settings, session)
        ) == at_eof
