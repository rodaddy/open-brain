"""``run_session_start`` against the real thing: canon pack, canon-only, whole.

The in-process suite proves ``run_session_start`` requests exactly the three
canon sections through the ``CanonPackReader`` fake and returns the pack
untouched. What only a real server proves is the layer it misses: that the REAL
``agent_context_pack`` contract holds -- it honors ``requested_sections``,
returns the canon tiers under schema ``openbrain.agent_context_pack.v1``, and
does NOT leak any episodic section by default. Wrong sections here is the exact
"back-history poisons the next task" failure the canon ruling exists to prevent
(``_plans/canon-always-known.md``), and a fake pack can never expose a server
that widened the default.

Environment (two required; the fixture FAILS loudly without them, per the plan's
rule that a live gate must never pass having run nothing). No DATABASE_URL: this
path is READ-ONLY -- it makes no writes to verify.

    OPENBRAIN_TEST_BASE_URL   the PLAYGROUND service, e.g. http://127.0.0.1:3101
    OPENBRAIN_TEST_TOKEN      a token that service accepts

Point these at the playground only (``docs/local-playground.md``).
"""

from __future__ import annotations

import os

import pytest

from openbrain.apps.hooks.session import SessionStartHook, run_session_start
from openbrain.config import CanonSettings

pytestmark = pytest.mark.live

REQUIRED_ENV = (
    "OPENBRAIN_TEST_BASE_URL",
    "OPENBRAIN_TEST_TOKEN",
)

#: The canon-only default the ruling mandates.
CANON_DEFAULT_SECTIONS = ("profile_guidance", "process_guidance", "repo_facts")

#: Back-history sections -- auto-loading any of these on session start is exactly
#: what the ruling forbids. The live pack's section keys must contain none.
EPISODIC_SECTIONS = frozenset(
    {
        "working_set",
        "durable_memory",
        "durable_lane_context",
        "recovery",
        "candidate_memory",
        "pointers",
    }
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


def canon_settings(live_env: dict[str, str], **overrides: object) -> CanonSettings:
    """CanonSettings pointed at the live playground, canon-only by default."""
    values: dict[str, object] = {
        "base_url": live_env["OPENBRAIN_TEST_BASE_URL"],
        "token": live_env["OPENBRAIN_TEST_TOKEN"],
        "repo": "open-brain",
    }
    values.update(overrides)
    return CanonSettings(**values)


def section_keys(pack: object) -> set[str]:
    """The section keys of a returned pack, or a failure if the shape is wrong."""
    assert isinstance(pack, dict), f"pack is not a dict: {type(pack).__name__}"
    sections = pack.get("sections")
    assert isinstance(sections, dict), "pack has no sections mapping"
    return set(sections.keys())


class TestSessionStartReadsCanonOnlyLive:
    """The default read returns the canon tiers and nothing episodic, from the server."""

    async def test_the_default_returns_the_three_canon_sections_and_no_episodic(
        self, live_env: dict[str, str]
    ) -> None:
        payload = SessionStartHook(session_id="session-start-live", source="startup")

        # No canon_factory: the real _canon_context builds the client and issues
        # agent_context_pack against the live server.
        pack = await run_session_start(payload, canon_settings(live_env))

        assert pack is not None
        assert isinstance(pack, dict)
        # The server's own contract, not a fixed fake: v1 schema, canon-only keys.
        assert pack.get("schema") == "openbrain.agent_context_pack.v1"
        keys = section_keys(pack)
        # A SUBSET of the three canon tiers -- the server may return fewer if a
        # tier is empty, but never more, and never an episodic key.
        assert keys <= set(CANON_DEFAULT_SECTIONS)
        assert keys.isdisjoint(EPISODIC_SECTIONS)

    async def test_the_compact_source_also_returns_canon(
        self, live_env: dict[str, str]
    ) -> None:
        # source is read but must not gate injection: canon loads on every start.
        payload = SessionStartHook(session_id="session-start-live", source="compact")

        pack = await run_session_start(payload, canon_settings(live_env))

        assert pack is not None
        assert section_keys(pack) <= set(CANON_DEFAULT_SECTIONS)


class TestSessionStartSectionOverrideIsLive:
    """The section override is a live path, not just declared."""

    async def test_an_empty_override_reads_nothing(
        self, live_env: dict[str, str]
    ) -> None:
        # An explicit empty override means inject nothing -- the guard returns
        # None before any client is built, so this needs no server round trip.
        payload = SessionStartHook(session_id="session-start-live", source="startup")

        pack = await run_session_start(
            payload, canon_settings(live_env, sections=())
        )

        assert pack is None

    async def test_a_widened_override_surfaces_the_extra_section_live(
        self, live_env: dict[str, str]
    ) -> None:
        # Widen the request to include an episodic section. The server honors the
        # request list, so the extra section appears -- proving the override list
        # reaches the real agent_context_pack, not a fixed default. This is the
        # operator-permitted widen; the DEFAULT (tested above) stays canon-only.
        payload = SessionStartHook(session_id="session-start-live", source="startup")

        pack = await run_session_start(
            payload,
            canon_settings(live_env, sections=("repo_facts", "working_set")),
        )

        assert pack is not None
        assert "working_set" in section_keys(pack)
