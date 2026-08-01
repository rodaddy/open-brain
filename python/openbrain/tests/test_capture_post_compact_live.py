"""``run_post_compact`` against the real thing: summary -> row, dedup on prompt_id.

The in-process suite proves ``run_post_compact`` builds one RawTurn from the
captured payload and hands it to the lane whole. What only a real server proves
is the two things a fake cannot:

1. The summary survives the round trip WHOLE into ``ob_raw_turns`` -- including a
   summary padded past the old 200,000-char server ceiling, so a reintroduced
   ``MAX_CONTENT_CHARS`` cut on this path would make the length assertion fail.
2. ``prompt_id`` dedup is STABLE: the capability reuses ``prompt_id`` as
   ``turn_uuid`` and relies on the server's ``UNIQUE(namespace, turn_uuid)``.
   Only a real server dedup proves a re-fired PostCompact with the SAME
   ``prompt_id`` is a no-op, and that a CHANGED ``prompt_id`` stores again --
   the documented dedup boundary.

The payload is loaded from the real captured fixture
(``tests/fixtures/captured_hooks/PostCompact.json``), byte-exact against Claude
Code, with a ``uuid4()`` session and a known ``prompt_id`` substituted so runs
never collide.

Environment (all three required; the fixture FAILS loudly without them, per the
plan's rule that a live gate must never pass having run nothing):

    OPENBRAIN_TEST_BASE_URL       the PLAYGROUND service, e.g. http://127.0.0.1:3101
    OPENBRAIN_TEST_TOKEN          a token that service accepts
    OPENBRAIN_TEST_DATABASE_URL   the PLAYGROUND clone, for row verification

Point these at the playground only (``docs/local-playground.md``); test turns do
not belong in Claude's real memory.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

import pytest

from openbrain.apps.hooks.session import PostCompactHook, run_post_compact
from openbrain.config import CaptureSettings

pytestmark = pytest.mark.live

REQUIRED_ENV = (
    "OPENBRAIN_TEST_BASE_URL",
    "OPENBRAIN_TEST_TOKEN",
    "OPENBRAIN_TEST_DATABASE_URL",
)

FIXTURES = Path(__file__).parent / "fixtures" / "captured_hooks"

#: A pad length one past the old ``MAX_CONTENT_CHARS = 200_000`` server ceiling.
#: An INPUT SIZE, never a bound: the assertion is ``len(stored) == len(given)``,
#: so a reintroduced cut at that threshold makes the row fail. Nothing here
#: measures content length or imposes one (``docs/CODING_STANDARDS.md``).
PAST_OLD_CEILING = 200_001


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


def settings_for(live_env: dict[str, str], tmp_path: Path) -> CaptureSettings:
    return CaptureSettings(
        base_url=live_env["OPENBRAIN_TEST_BASE_URL"],
        token=live_env["OPENBRAIN_TEST_TOKEN"],
        watermark_path=tmp_path / "wm.sqlite",
    )


def fetch_one(database_url: str, turn_uuid: str) -> str | None:
    """The single stored content for a turn_uuid, or ``None`` when absent."""
    import psycopg

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT content FROM ob_raw_turns WHERE turn_uuid = %s",
            (turn_uuid,),
        ).fetchone()
    return None if row is None else str(row[0])


def count_for(database_url: str, turn_uuid: str) -> int:
    """How many rows carry this turn_uuid -- dedup proof is exactly one."""
    import psycopg

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT count(*) FROM ob_raw_turns WHERE turn_uuid = %s",
            (turn_uuid,),
        ).fetchone()
    return 0 if row is None else int(row[0])


def captured_summary() -> str:
    """The real compaction summary from the captured fixture."""
    return str(json.loads((FIXTURES / "PostCompact.json").read_text())["compact_summary"])


class TestPostCompactRecordsTheSummaryWholeLive:
    """The whole summary reaches ob_raw_turns byte-for-byte through the real client."""

    async def test_a_large_summary_lands_whole_under_its_prompt_id(
        self, live_env: dict[str, str], tmp_path: Path
    ) -> None:
        # The real fixture summary, PADDED past the old server ceiling. The pad is
        # an input size, not a bound; the assertion is len-equal AND byte-equal.
        base = captured_summary()
        summary = base + ("x" * (PAST_OLD_CEILING - len(base)))
        assert len(summary) >= PAST_OLD_CEILING

        session = f"postcompact-live-{uuid.uuid4()}"
        prompt_id = f"pc-{uuid.uuid4()}"
        payload = PostCompactHook(
            compact_summary=summary,
            session_id=session,
            prompt_id=prompt_id,
        )

        # No lane_factory: the real _started_memory builds the client.
        recorded = await run_post_compact(payload, settings_for(live_env, tmp_path))

        assert recorded is True
        database_url = live_env["OPENBRAIN_TEST_DATABASE_URL"]
        # Exactly one row, keyed by prompt_id, content whole in both senses.
        assert count_for(database_url, prompt_id) == 1
        stored = fetch_one(database_url, prompt_id)
        assert stored is not None
        assert len(stored) == len(summary)
        assert stored == summary


class TestPostCompactDedupStabilityLive:
    """prompt_id is the dedup key; a re-fire with the same one is a server no-op."""

    async def test_re_firing_the_same_prompt_id_stays_one_row(
        self, live_env: dict[str, str], tmp_path: Path
    ) -> None:
        session = f"postcompact-dedup-{uuid.uuid4()}"
        prompt_id = f"pc-{uuid.uuid4()}"
        summary = captured_summary()
        payload = PostCompactHook(
            compact_summary=summary, session_id=session, prompt_id=prompt_id
        )
        settings = settings_for(live_env, tmp_path)
        database_url = live_env["OPENBRAIN_TEST_DATABASE_URL"]

        first = await run_post_compact(payload, settings)
        assert first is True
        assert count_for(database_url, prompt_id) == 1

        # Re-fire the IDENTICAL payload: same prompt_id -> same turn_uuid ->
        # UNIQUE(namespace, turn_uuid) makes the second write a no-op. Still one.
        again = await run_post_compact(payload, settings)
        assert again is True
        assert count_for(database_url, prompt_id) == 1

    async def test_a_changed_prompt_id_stores_again(
        self, live_env: dict[str, str], tmp_path: Path
    ) -> None:
        # The documented dedup BOUNDARY: dedup keys on prompt_id, not content. The
        # SAME summary text under a NEW prompt_id is a NEW row. This is honest
        # about the behavior, not a claim it is desirable -- if a real harness
        # re-fire assigns a fresh prompt_id per compaction, this two-row case is a
        # latent double-store to confirm against harness behavior (residual in
        # _plans/hard-pass-2026-08-01.md and _plans/rewrite-gotchas.md).
        session = f"postcompact-boundary-{uuid.uuid4()}"
        summary = captured_summary()
        first_id = f"pc-{uuid.uuid4()}"
        second_id = f"pc-{uuid.uuid4()}"
        settings = settings_for(live_env, tmp_path)
        database_url = live_env["OPENBRAIN_TEST_DATABASE_URL"]

        await run_post_compact(
            PostCompactHook(
                compact_summary=summary, session_id=session, prompt_id=first_id
            ),
            settings,
        )
        await run_post_compact(
            PostCompactHook(
                compact_summary=summary, session_id=session, prompt_id=second_id
            ),
            settings,
        )

        # Two distinct prompt_ids -> two rows, even though the text is identical.
        assert count_for(database_url, first_id) == 1
        assert count_for(database_url, second_id) == 1
        assert fetch_one(database_url, first_id) == fetch_one(database_url, second_id)
