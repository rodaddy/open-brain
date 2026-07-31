"""The Stop capability against the real thing: config -> client -> spine -> row.

The spine's own live test (``test_capture_deliver_live.py``) proves
``deliver_new_turns`` reaches Postgres. This proves the layer step 8 adds: that
``run_stop`` builds the real ``openbrain_memory`` client from ``CaptureSettings``
and lands a turn through it, so the entrypoint's wiring -- not just the spine --
is exercised end to end.

Environment (all four required; the fixture FAILS loudly without them, per the
plan's rule that a live gate must never pass having run nothing):

    OPENBRAIN_TEST_BASE_URL       the PLAYGROUND service, e.g. http://127.0.0.1:3101
    OPENBRAIN_TEST_TOKEN          a token that service accepts
    OPENBRAIN_TEST_DATABASE_URL   the PLAYGROUND clone, for row verification

Point these at the playground only (``docs/local-playground.md``); test turns do
not belong in Claude's real memory.
"""

from __future__ import annotations

import os
import uuid
from typing import TYPE_CHECKING

import pytest

from conftest import operator_line, write_lines
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
def live_env() -> dict[str, str]:
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
    return {name: os.environ[name] for name in REQUIRED_ENV}


def fetch_content(database_url: str, turn_uuid: str) -> str | None:
    """The stored content for a turn, or ``None`` when no row exists."""
    import psycopg

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT content FROM ob_raw_turns WHERE turn_uuid = %s",
            (turn_uuid,),
        ).fetchone()
    return None if row is None else str(row[0])


class TestRunStopLandsATurnThroughTheRealClient:
    """run_stop with the default factory builds a real client and delivers."""

    async def test_a_stop_payload_reaches_ob_raw_turns(
        self, live_env: dict[str, str], tmp_path: Path
    ) -> None:
        session = f"stop-live-{uuid.uuid4()}"
        turn_id = f"u-{uuid.uuid4()}"
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line(turn_id, "stop hook end to end", session=session)])

        settings = CaptureSettings(
            base_url=live_env["OPENBRAIN_TEST_BASE_URL"],
            token=live_env["OPENBRAIN_TEST_TOKEN"],
            watermark_path=tmp_path / "wm.sqlite",
        )
        payload = StopHook(transcript_path=transcript, session_id=session)

        # No lane_factory: the real _started_memory builds the client.
        result = await run_stop(payload, settings)

        assert result is not None
        assert result.delivered == 1
        stored = fetch_content(live_env["OPENBRAIN_TEST_DATABASE_URL"], turn_id)
        assert stored == "stop hook end to end"
        # The watermark advanced only after the real send returned.
        assert await WatermarkStore(settings.watermark_path).offset_for(
            session
        ) == result.next_offset
