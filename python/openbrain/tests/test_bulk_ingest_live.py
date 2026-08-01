"""The bulk ingester against the real thing: playground service, playground DB.

In-process tests prove the composition; only this file proves a bulk turn
survives the round trip -- staged into SQLite, yielded, sent through the real
``openbrain_memory`` client, and landed in ``ob_raw_turns`` whole.

Environment (all three required; the fixture FAILS loudly without them, per the
plan's rule that a live gate must never pass having run nothing):

    OPENBRAIN_TEST_BASE_URL       the PLAYGROUND service, e.g. http://127.0.0.1:3101
    OPENBRAIN_TEST_TOKEN          a token that service accepts
    OPENBRAIN_TEST_DATABASE_URL   the PLAYGROUND clone, for row verification

Point these at the playground only (`docs/local-playground.md`). The real local
service is Claude's actual memory; test turns do not belong in it.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

import pytest

from openbrain.apps.bulk.formats import InputFormat
from openbrain.apps.bulk.ingest import ingest, stage_file
from openbrain.apps.bulk.staging import StagingStore

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
    prevent: a green run that tested nothing.
    """
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        pytest.fail(
            "live gate misconfigured -- refusing to pass while testing "
            f"nothing. Missing: {', '.join(missing)}"
        )
    return {name: os.environ[name] for name in REQUIRED_ENV}


def operator_line(turn_uuid: str, content: str, session: str) -> str:
    """One transcript line in the shape Claude Code writes."""
    return json.dumps(
        {
            "type": "user",
            "uuid": turn_uuid,
            "promptSource": "typed",
            "sessionId": session,
            "cwd": "/repo/bulk-live",
            "parentUuid": None,
            "timestamp": "2026-08-01T06:00:00.000Z",
            "message": {"role": "user", "content": content},
        }
    )


def fetch_row(database_url: str, turn_uuid: str) -> tuple[str, object] | None:
    """The row as Postgres holds it: (content, occurred_at)."""
    import psycopg

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT content, occurred_at FROM ob_raw_turns WHERE turn_uuid = %s",
            (turn_uuid,),
        ).fetchone()
    return None if row is None else (str(row[0]), row[1])


def started_memory(live_env: dict[str, str], session: str) -> Any:
    """The real bulk lane: an ``AgentMemory`` with its session started."""
    from openbrain_memory.agent import AgentMemory
    from openbrain_memory.client import OpenBrainClient

    client = OpenBrainClient(
        base_url=live_env["OPENBRAIN_TEST_BASE_URL"],
        token=live_env["OPENBRAIN_TEST_TOKEN"],
        namespace="bulk-live",
        agent_id="bulk-live-test",
        allow_insecure_http=True,
    )
    memory = AgentMemory(client, agent="bulk-live-test")
    memory.start_session(session)
    return memory


class TestBulkRoundTrip:
    """A staged Claude transcript, yielded whole into the real raw lane."""

    async def test_every_turn_reaches_ob_raw_turns_whole(
        self, live_env: dict[str, str], tmp_path: Path
    ) -> None:
        session = f"bulk-live-{uuid.uuid4()}"
        # A small turn and a large one: 300,001 chars is past every shortening
        # this port buried, on real wire.
        small_id, big_id = f"u-{uuid.uuid4()}", f"u-{uuid.uuid4()}"
        big_text = "the whole of what was said " * 11_112
        source = tmp_path / "bulk.jsonl"
        source.write_text(
            operator_line(small_id, "yes", session)
            + "\n"
            + operator_line(big_id, big_text, session)
            + "\n",
            encoding="utf-8",
        )
        store = StagingStore(tmp_path / "stage.sqlite")

        staged = stage_file(source, InputFormat.CLAUDE, store)
        assert staged.staged == 2

        result = ingest(store, started_memory(live_env, session))
        assert result.sent == 2
        assert result.quarantined == 0

        database_url = live_env["OPENBRAIN_TEST_DATABASE_URL"]
        small = fetch_row(database_url, small_id)
        assert small is not None
        assert small[0] == "yes"
        big = fetch_row(database_url, big_id)
        assert big is not None
        assert len(big[0]) == len(big_text)
        # The ordering key must land: NULL here left a whole backfill unorderable
        # once (scripts/backfill-transcripts.ts:256).
        assert small[1] is not None
        assert big[1] is not None

    async def test_a_resumed_run_re_sends_nothing_live(
        self, live_env: dict[str, str], tmp_path: Path
    ) -> None:
        # The operator resume, proven live: a second run over the same staging
        # store delivers nothing, because every turn is already marked sent.
        session = f"bulk-live-{uuid.uuid4()}"
        turn_id = f"u-{uuid.uuid4()}"
        source = tmp_path / "bulk.jsonl"
        source.write_text(
            operator_line(turn_id, "resume proof", session) + "\n",
            encoding="utf-8",
        )
        store = StagingStore(tmp_path / "stage.sqlite")
        stage_file(source, InputFormat.CLAUDE, store)

        first = ingest(store, started_memory(live_env, session))
        assert first.sent == 1

        second = ingest(store, started_memory(live_env, f"{session}-2"))
        assert second.sent == 0
