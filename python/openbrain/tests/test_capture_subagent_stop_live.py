"""``run_subagent_stop`` against the real thing: subagent turn -> row, own key.

The in-process suite proves ``run_subagent_stop`` delegates to the spine under a
per-subagent watermark key and that a failed lane leaves that key unmoved. What
only a real server proves is the layer it misses: that the REAL
``openbrain_memory`` client lands the subagent turn in ``ob_raw_turns`` WHOLE,
and that the per-subagent watermark key (``session_id:agent_id``) does not
collide with the parent ``Stop``'s bare ``session_id`` key across a real send --
the collision the fake tests assert in-process, re-proven end to end.

Environment (all three required; the fixture FAILS loudly without them, per the
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
from openbrain.apps.hooks.session import SubagentStopHook, run_subagent_stop
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


class TestSubagentStopLandsUnderItsOwnKey:
    """run_subagent_stop with the default factory delivers and keys per subagent."""

    async def test_the_subagent_turn_reaches_the_row_and_the_parent_key_is_untouched(
        self, live_env: dict[str, str], tmp_path: Path
    ) -> None:
        # Distinct parent session and subagent id so the derived key
        # (session_id:agent_id) is provably different from the bare session_id.
        parent_session = f"parent-live-{uuid.uuid4()}"
        agent_id = f"agent-{uuid.uuid4()}"
        turn_id = f"u-{uuid.uuid4()}"
        subagent_text = "the subagent said this, whole, on real wire"

        # The subagent's OWN transcript. The line's sessionId is the derived key,
        # matching how the spine reads it -- the subagent stream is its own bytes.
        derived_key = f"{parent_session}:{agent_id}"
        transcript = tmp_path / "sub.jsonl"
        write_lines(
            transcript, [operator_line(turn_id, subagent_text, session=derived_key)]
        )

        settings = CaptureSettings(
            base_url=live_env["OPENBRAIN_TEST_BASE_URL"],
            token=live_env["OPENBRAIN_TEST_TOKEN"],
            watermark_path=tmp_path / "wm.sqlite",
        )
        payload = SubagentStopHook(
            agent_transcript_path=transcript,
            agent_id=agent_id,
            session_id=parent_session,
        )

        # No lane_factory: the real _started_memory builds the client.
        result = await run_subagent_stop(payload, settings)

        assert result is not None
        assert result.delivered == 1
        # The subagent turn is in the row store, whole.
        stored = fetch_content(live_env["OPENBRAIN_TEST_DATABASE_URL"], turn_id)
        assert stored == subagent_text

        # Watermark isolation, live: the per-subagent key advanced to what the
        # delivery reported, and the bare parent session key -- which the main
        # Stop owns -- was never advanced by this subagent send.
        store = WatermarkStore(settings.watermark_path)
        assert await store.offset_for(derived_key) == result.next_offset
        assert await store.offset_for(parent_session) == 0
