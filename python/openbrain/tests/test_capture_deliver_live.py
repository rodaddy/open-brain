"""The spine against the real thing: playground service, playground database.

In-process tests prove the composition; only this file proves a write survives
the round trip -- client, HTTP, server judgment, Postgres column, encoding.
`_plans/python-port-sequence.md`, "The live gate".

Environment (all three required; the fixture FAILS loudly without them, per
the plan's rule that a live gate must never pass having run nothing):

    OPENBRAIN_TEST_BASE_URL       the PLAYGROUND service, e.g. http://127.0.0.1:3101
    OPENBRAIN_TEST_TOKEN          a token that service accepts
    OPENBRAIN_TEST_DATABASE_URL   the PLAYGROUND clone, for row verification

Point these at the playground only (`docs/local-playground.md`). The real
local service is Claude's actual memory; test turns do not belong in it.
"""

import json
import os
import uuid
from pathlib import Path
from typing import Any

import pytest

from openbrain.apps.capture.deliver import deliver_new_turns
from openbrain.apps.capture.watermark import WatermarkStore

pytestmark = pytest.mark.live

REQUIRED_ENV = (
    "OPENBRAIN_TEST_BASE_URL",
    "OPENBRAIN_TEST_TOKEN",
    "OPENBRAIN_TEST_DATABASE_URL",
)

#: The namespace the CLIENT asks for. Measured 2026-07-31: the playground
#: server derives the actual namespace from the TOKEN (an agent token lands in
#: `agent`), so row lookups below go by turn_uuid alone and never assume this
#: value reached the table.
REQUESTED_NAMESPACE = "spine-live"


@pytest.fixture
def live_env() -> dict[str, str]:
    """The live configuration, or a FAILURE naming what is missing.

    A skip here would recreate the measured defect this marker exists to
    prevent: `AGENTS.md` -- live tests that "SKIP SILENTLY ... so a green run
    may have tested nothing".
    """
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        pytest.fail(
            "live gate misconfigured -- refusing to pass while testing "
            f"nothing. Missing: {', '.join(missing)}"
        )
    return {name: os.environ[name] for name in REQUIRED_ENV}


def operator_line(turn_uuid: str, content: str, session: str) -> str:
    return json.dumps(
        {
            "type": "user",
            "uuid": turn_uuid,
            "promptSource": "typed",
            "sessionId": session,
            "cwd": "/repo/spine-live",
            "parentUuid": None,
            # Real transcripts always carry this, and it matters: the server
            # orders a session by (session_ref, occurred_at).
            "timestamp": "2026-07-31T06:00:00.000Z",
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
    from openbrain_memory.agent import AgentMemory
    from openbrain_memory.client import OpenBrainClient

    client = OpenBrainClient(
        base_url=live_env["OPENBRAIN_TEST_BASE_URL"],
        token=live_env["OPENBRAIN_TEST_TOKEN"],
        namespace=REQUESTED_NAMESPACE,
        agent_id="spine-live-test",
        allow_insecure_http=True,
    )
    memory = AgentMemory(client, agent="spine-live-test")
    memory.start_session(session)
    return memory


#: INPUT SIZES, never bounds -- the character counts each turn below carries,
#: chosen to BRACKET the two shortenings this port buried and go past them:
#: 1,499/1,501 straddle the old `MAX_CAPTURE_CHARS = 1_500` cut, 200,001 sits
#: one past the old `MAX_CONTENT_CHARS = 200_000` server ceiling, and 300,001 is
#: well beyond both. 1 is the one-character turn of #418's acceptance criteria.
#: The assertion is `len(stored) == len(given)` at every size, so a reintroduced
#: cut at any threshold makes some row fail; nothing here measures content
#: length or imposes one (`docs/CODING_STANDARDS.md:160`,
#: `_plans/python-port-sequence.md` "A number in a test is an INPUT SIZE").
SPREAD_SIZES = (1, 1_499, 1_501, 10_000, 200_001, 300_001)


class TestSizeSpreadOneDelivery:
    """One delivery of many sizes; every row whole, straddling both buried cuts."""

    async def test_every_size_reaches_ob_raw_turns_whole_in_one_delivery(
        self, live_env: dict[str, str], tmp_path: Path
    ) -> None:
        # ONE transcript, ONE delivery carrying every size -- not N round trips.
        # A per-size delivery would prove each size survives alone; a mixed batch
        # is what the live path actually sends, and it is where an off-by-one in
        # per-turn `turn_index` or ordering would surface.
        session = f"spine-spread-{uuid.uuid4()}"
        # A distinct id per size, and the exact text each is expected to hold.
        turns = {
            size: (f"u-{uuid.uuid4()}", "x" * size) for size in SPREAD_SIZES
        }
        path = tmp_path / "spread.jsonl"
        path.write_text(
            "".join(
                operator_line(turn_uuid, text, session) + "\n"
                for turn_uuid, text in turns.values()
            ),
            encoding="utf-8",
        )
        store = WatermarkStore(tmp_path / "wm.sqlite")
        memory = started_memory(live_env, session)

        result = await deliver_new_turns(path, session, store, memory)
        assert result.delivered == len(SPREAD_SIZES)

        database_url = live_env["OPENBRAIN_TEST_DATABASE_URL"]
        for size, (turn_uuid, text) in turns.items():
            row = fetch_row(database_url, turn_uuid)
            assert row is not None, f"size {size}: no row -- a turn was dropped"
            # Whole in TWO senses: same length (no cut) and identical bytes (no
            # re-encoding). Length alone would pass a same-length corruption.
            assert len(row[0]) == size, f"size {size}: stored {len(row[0])} chars"
            assert row[0] == text, f"size {size}: content changed in the round trip"
            assert row[1] is not None, f"size {size}: occurred_at NULL, unorderable"


class TestOneTurnEndToEnd:
    """#418's added acceptance criterion: the row exists, and it is whole."""

    async def test_turns_reach_ob_raw_turns_whole_and_replay_is_a_noop(
        self, live_env: dict[str, str], tmp_path: Path
    ) -> None:
        session = f"spine-live-{uuid.uuid4()}"
        small_id, big_id = f"u-{uuid.uuid4()}", f"u-{uuid.uuid4()}"
        # 300,001 chars: past every shortening this port buried, on real wire.
        big_text = "the whole of what was said " * 11_112
        path = tmp_path / "t.jsonl"
        path.write_text(
            operator_line(small_id, "yes", session)
            + "\n"
            + operator_line(big_id, big_text, session)
            + "\n",
            encoding="utf-8",
        )
        store = WatermarkStore(tmp_path / "wm.sqlite")
        memory = started_memory(live_env, session)

        result = await deliver_new_turns(path, session, store, memory)
        assert result.delivered == 2

        database_url = live_env["OPENBRAIN_TEST_DATABASE_URL"]
        small = fetch_row(database_url, small_id)
        assert small is not None
        assert small[0] == "yes"
        big = fetch_row(database_url, big_id)
        assert big is not None
        assert len(big[0]) == len(big_text)
        # The ordering key must land: NULL here left a whole backfill
        # unorderable once (scripts/backfill-transcripts.ts:256).
        assert small[1] is not None
        assert big[1] is not None

        replay = await deliver_new_turns(path, session, store, memory)
        assert replay.delivered == 0
