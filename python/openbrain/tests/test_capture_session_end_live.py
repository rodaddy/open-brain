"""``run_session_end`` against the real thing: start a session, close its slot.

The in-process suite proves ``run_session_end`` starts and closes through an
injected recorder, and ``test_capture_hooks.py::TestStartupFailureReleasesThe
SessionSlot`` proves the closing ``DELETE`` is issued against a scripted MCP
server. What only a real server can prove is the layer those two miss: that the
REAL ``openbrain_memory`` client, built from ``CaptureSettings``, drives the
whole ``initialize -> start_session -> DELETE`` lifecycle and the live server
accepts it end to end -- and that ``SessionEnd`` writes NOTHING while doing so.

The server session slot is an in-memory ``Map`` in ``src/transport.ts``
(``sessions``, capped at ``DEFAULT_MAX_SESSIONS = 100``, freed on the closing
``DELETE``), NOT a database row -- the ``sessions`` TABLE is the durable
session-memory store, unrelated. The local single-process playground exposes no
``sessions.size`` on ``/health`` (that ``workers[]`` surface is deployment_host-only), so
the slot count is not remotely observable here. The observable live property is
therefore: the full lifecycle is accepted (``run_session_end`` returns ``True``)
and no ``ob_raw_turns`` row lands for the session -- ``SessionEnd`` frees a slot,
it does not deliver.

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

from openbrain.apps.hooks.session import SessionEndHook, run_session_end
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


def rows_for_session(database_url: str, session_ref: str) -> int:
    """How many ``ob_raw_turns`` rows exist for a session -- SessionEnd writes 0."""
    import psycopg

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT count(*) FROM ob_raw_turns WHERE session_ref = %s",
            (session_ref,),
        ).fetchone()
    return 0 if row is None else int(row[0])


class TestSessionEndClosesTheRealLifecycleWithoutWriting:
    """run_session_end with the default factory starts and closes a live session."""

    async def test_the_full_lifecycle_is_accepted_and_nothing_is_written(
        self, live_env: dict[str, str], tmp_path: Path
    ) -> None:
        # A fresh session id: initialize opens the slot, start_session allocates
        # it, and the closing DELETE frees it. The server must accept all three.
        session = f"session-end-live-{uuid.uuid4()}"
        settings = CaptureSettings(
            base_url=live_env["OPENBRAIN_TEST_BASE_URL"],
            token=live_env["OPENBRAIN_TEST_TOKEN"],
            watermark_path=tmp_path / "wm.sqlite",
        )
        payload = SessionEndHook(session_id=session)

        # No lane_factory: the real _started_memory builds the client, starts the
        # session against the live server, and returns the closer run_session_end
        # calls. True means the whole lifecycle round-tripped.
        released = await run_session_end(payload, settings)

        assert released is True
        # SessionEnd delivers nothing -- every turn was durable on each Stop
        # already. The slot was freed, not filled: no row exists for the session.
        assert rows_for_session(live_env["OPENBRAIN_TEST_DATABASE_URL"], session) == 0


class TestSessionEndNoSessionIdMakesNoNetworkCall:
    """A SessionEnd with no session id is a no-op -- no slot to release, no dial.

    This half needs no live server: the guard returns before the factory is ever
    built, so an injected counting factory proves zero construction. Kept here
    beside the live case so the whole SessionEnd contract reads in one file.
    """

    async def test_no_session_id_returns_false_and_never_builds_a_lane(
        self, tmp_path: Path
    ) -> None:
        calls = 0

        def counting_factory(_s: object, _k: str) -> object:
            # A build here is the bug this test guards against; record it and let
            # the post-call assertion report it rather than raising mid-flight.
            nonlocal calls
            calls += 1
            return None

        # base_url/token intentionally absent: if the guard were skipped, the real
        # factory would raise CaptureNotConfiguredError. The counting factory
        # stands in so a build is COUNTED, not dialed. The guard returns before it.
        settings = CaptureSettings(watermark_path=tmp_path / "wm.sqlite")
        payload = SessionEndHook()  # no session_id

        released = await run_session_end(
            payload, settings, lane_factory=counting_factory  # type: ignore[arg-type]
        )

        assert released is False
        assert calls == 0
