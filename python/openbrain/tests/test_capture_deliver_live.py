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


#: Text placed in a `thinking` block that must NEVER appear in any stored row.
#: A literal marker rather than a shape test: the assertion is a substring search
#: over what Postgres actually holds, so a leak anywhere in the round trip fails.
THINKING_MARKER = "PRIVATE-CHAIN-OF-THOUGHT-MUST-NOT-PERSIST"

#: A tool name that must never appear either -- the open memory-versus-
#: observability question stays open on the live path too, not just in-process.
TOOL_MARKER = "ToolNameMustNotPersist"


def assistant_line(turn_uuid: str, text: str, session: str) -> str:
    """One assistant transcript line, in the shape Claude Code actually writes.

    The list content shape is not a stylistic choice: all 134 assistant records
    on a live transcript measured 2026-08-03 used it and none used a bare
    string, so a fixture written the operator's way would prove nothing about
    the path #447 restored. The `thinking` and `tool_use` blocks are present
    deliberately -- their markers are what the leak assertions search for.
    """
    return json.dumps(
        {
            "type": "assistant",
            "uuid": turn_uuid,
            "sessionId": session,
            "cwd": "/repo/spine-live",
            "parentUuid": None,
            "timestamp": "2026-07-31T06:00:01.000Z",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": THINKING_MARKER},
                    {"type": "text", "text": text},
                    {"type": "tool_use", "name": TOOL_MARKER, "input": {}},
                ],
            },
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


def fetch_attribution(database_url: str, turn_uuid: str) -> tuple[str, bool] | None:
    """How Postgres attributed the row: (role, is_human_prompt).

    A separate query rather than a wider :func:`fetch_row`, because the two
    answer different questions: whether the turn survived, and whether the
    SERVER agreed about who said it. `role` is validated server-side
    (`src/tools/ingest-raw-turn.ts`: `z.enum(["user","assistant","tool"])`), and
    `_plans/python-port-sequence.md` records that the live gate is precisely
    where such contract facts surfaced -- "the server requires `role` +
    `turn_index`" was learned here, not in-process. So this is the only proof
    that an `assistant` turn is neither coerced nor refused on the wire.
    """
    import psycopg

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT role, is_human_prompt FROM ob_raw_turns WHERE turn_uuid = %s",
            (turn_uuid,),
        ).fetchone()
    return None if row is None else (str(row[0]), bool(row[1]))


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


class TestBothSidesReachPostgres:
    """#447 on the real wire: the conversation lands, the reasoning does not."""

    async def test_a_conversation_lands_with_each_side_attributed(
        self, live_env: dict[str, str], tmp_path: Path
    ) -> None:
        """THE PRODUCT PROOF, end to end.

        In-process tests prove the parser reads the agent side; only this proves
        the server ACCEPTS it. That distinction is load-bearing here: `role` is
        server-validated, so an `assistant` turn could in principle be refused
        or coerced on the wire, and the in-process suite could not tell.
        """
        session = f"spine-bothsides-{uuid.uuid4()}"
        operator_id, assistant_id = f"u-{uuid.uuid4()}", f"a-{uuid.uuid4()}"
        question = "why is the fleet index 20% third-party code?"
        finding = "buzz's checkout is dirty and was never rebuilt after the move."
        path = tmp_path / "conversation.jsonl"
        path.write_text(
            operator_line(operator_id, question, session)
            + "\n"
            + assistant_line(assistant_id, finding, session)
            + "\n",
            encoding="utf-8",
        )
        store = WatermarkStore(tmp_path / "wm.sqlite")
        memory = started_memory(live_env, session)

        result = await deliver_new_turns(path, session, store, memory)

        assert result.delivered == 2, (
            "a conversation is both speakers -- delivering 1 is the #447 "
            "regression, where the corpus holds the question and not the answer"
        )

        database_url = live_env["OPENBRAIN_TEST_DATABASE_URL"]
        stored_question = fetch_row(database_url, operator_id)
        stored_finding = fetch_row(database_url, assistant_id)

        assert stored_question is not None
        assert stored_question[0] == question
        assert stored_finding is not None, (
            "the agent's finding never reached Postgres -- the session's "
            "answers are exactly what #447 says get lost"
        )
        assert stored_finding[0] == finding
        # The ordering key on BOTH rows: without it the two sides are stored but
        # cannot be sequenced back into a conversation.
        assert stored_question[1] is not None
        assert stored_finding[1] is not None

        # The server AGREED about who said what -- role is its own enum, and
        # is_human_prompt must stay the operator-only health-check signal.
        assert fetch_attribution(database_url, operator_id) == ("user", True)
        assert fetch_attribution(database_url, assistant_id) == ("assistant", False)

    async def test_no_reasoning_or_tool_name_is_ever_persisted(
        self, live_env: dict[str, str], tmp_path: Path
    ) -> None:
        """The hard rule, proven against the column rather than the parser.

        Searches the WHOLE session's stored content, not just the turn under
        test, so a leak through any row -- a future block kind, a re-encoding --
        fails here.
        """
        import psycopg

        session = f"spine-noreasoning-{uuid.uuid4()}"
        assistant_id = f"a-{uuid.uuid4()}"
        path = tmp_path / "reasoning.jsonl"
        path.write_text(
            assistant_line(assistant_id, "the measured answer", session) + "\n",
            encoding="utf-8",
        )
        store = WatermarkStore(tmp_path / "wm.sqlite")
        memory = started_memory(live_env, session)

        await deliver_new_turns(path, session, store, memory)

        database_url = live_env["OPENBRAIN_TEST_DATABASE_URL"]
        with psycopg.connect(database_url) as connection:
            rows = connection.execute(
                "SELECT content FROM ob_raw_turns WHERE session_ref = %s",
                (session,),
            ).fetchall()

        assert rows, "nothing was stored, so this proves nothing about leaking"
        stored = "\n".join(str(row[0]) for row in rows)
        assert THINKING_MARKER not in stored, (
            "chain-of-thought reached durable storage -- the standing hard rule "
            "is distilled events only, never raw reasoning"
        )
        assert TOOL_MARKER not in stored, (
            "a tool name reached durable storage, resolving by accident the "
            "memory-versus-observability question the decision doc parks"
        )
