"""A promoted DREAM candidate is retrievable by a supported client, live.

Release gate 3 (issue 1469, gap G1) asks for "supported-client retrieval
afterward": once a candidate is approved and applied with
``promote_reviewed_candidate``, a real client searching a RUNNING service must
find the new thought. Today that is proven only in-process, through the lexical
arm only, with a zero query vector -- ``searchIds`` in
``server/maintenance/reviewed-candidate-chain.pg.test.ts:76`` embeds every query
as 768 zeros, so the vector arm carries no signal there and no real client is
involved.

This module closes both halves against the playground service: the full chain
ingest -> distill -> human approval -> dry run -> apply -> retrieval runs
end to end, and retrieval is asserted through ``OpenBrainClient.search_brain``
in BOTH ``vector`` and ``hybrid`` mode, with the vector arm queried by a
PARAPHRASE that shares no distinctive word with the stored sentence.

Two stages of the chain have no client-callable trigger and are driven here the
way an operator drives them:

* DISTILL is the operator script ``scripts/distill-run.ts`` (rule-based, no
  LLM), run as a subprocess against the same database. A running service also
  distills on its own maintenance schedule (``memory.distill``), so the two
  race; the test waits for the candidate and accepts it from either.
* HUMAN APPROVAL is the ``UPDATE candidate_memory`` the real grader issues at
  ``server/domain/candidate-review/batch-grade.ts:251``; ``_approve`` below
  issues that same statement for this test's ONE candidate.

Environment (all required; the fixture FAILS loudly without them, because a
live gate that skips silently may have tested nothing):

    OPENBRAIN_TEST_BASE_URL       the PLAYGROUND service, e.g. http://127.0.0.1:3101
    OPENBRAIN_TEST_TOKEN          identity A's token -- the promoter
    OPENBRAIN_TEST_OTHER_TOKEN    identity B's token -- a DIFFERENT identity
    OPENBRAIN_TEST_DATABASE_URL   the PLAYGROUND clone, for row verification
    DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD   what the distill script reads
    EMBEDDING_BASE_URL            the embedder, or the candidate lands NULL

Point these at the playground only (``docs/local-playground.md``).
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import psycopg
import pytest
from openbrain_memory import OpenBrainClient

from conftest import Secret

if TYPE_CHECKING:
    from collections.abc import Iterator

pytestmark = pytest.mark.live

REQUIRED_ENV = (
    "OPENBRAIN_TEST_BASE_URL",
    "OPENBRAIN_TEST_TOKEN",
    "OPENBRAIN_TEST_OTHER_TOKEN",
    "OPENBRAIN_TEST_DATABASE_URL",
)

DISTILL_ENV = (
    "DB_HOST",
    "DB_PORT",
    "DB_NAME",
    "DB_USER",
    "DB_PASSWORD",
    "EMBEDDING_BASE_URL",
)

#: The dogfood database. The distill script writes, so pointing this test at it
#: would stamp ``distilled_at`` across real memory.
FORBIDDEN_DATABASE = "open_brain_local_20260724"

NODE = "/opt/homebrew/opt/node@24/bin/node"
REPO_ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "..")

#: The distill script's configuration, read AT IMPORT TIME and deliberately.
#:
#: ``conftest._clean_environment`` is autouse and strips every ``DB_``,
#: ``EMBEDDING_`` and ``OPENBRAIN_`` variable from ``os.environ`` for every test
#: (``conftest.py:37``, ``conftest.py:108``) -- correctly, because those leaks
#: once hung the suite against production. By the time a test body runs, the
#: distill script's coordinates are gone, and a subprocess would inherit the
#: scrubbed environment and fail to connect.
#:
#: So this module snapshots them here, at collection, before the fixture can
#: run, and hands them to the subprocess explicitly. Nothing is put back into
#: ``os.environ``: the scrubbing stays intact for every other test.
#:
#: By PREFIX, not by a fixed list, for the reason the conftest docstring gives
#: about its own prefixes -- the variable that breaks you is the one nobody
#: enumerated. Measured here: snapshotting only ``EMBEDDING_BASE_URL`` left
#: ``EMBEDDING_API_KEY`` and ``EMBEDDING_MODEL`` behind
#: (``scripts/settings.ts:104``), the sweep could not reach the provider, and
#: the candidate landed with a NULL embedding -- which is a normal repairable
#: state for the sweep, so it exits 0 and only the vector arm notices.
_DISTILL_PREFIXES = ("DB_", "EMBEDDING_")
_DISTILL_CONFIG = {
    name: value
    for name, value in os.environ.items()
    if name.upper().startswith(_DISTILL_PREFIXES)
}


@pytest.fixture
def live_env() -> dict[str, Secret]:
    """The live configuration, or a FAILURE naming what is missing.

    A skip here would recreate the measured defect this marker exists to
    prevent: ``AGENTS.md`` -- live tests that "SKIP SILENTLY ... so a green run
    may have tested nothing".
    """
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    missing += [name for name in DISTILL_ENV if not _DISTILL_CONFIG.get(name)]
    if missing:
        pytest.fail(
            "live gate misconfigured -- refusing to pass while testing "
            f"nothing. Missing: {', '.join(missing)}"
        )
    return {name: Secret(os.environ[name]) for name in REQUIRED_ENV}


@pytest.fixture
def guarded_database(live_env: dict[str, Secret]) -> Secret:
    """The playground database URL, once it is proven safe to distill into.

    The distill subprocess reads ``DB_*``, not this URL, so the two could name
    different databases and the test would verify rows it never wrote. It would
    also happily sweep the dogfood database. Both are refused here, before
    anything is written.
    """
    url = live_env["OPENBRAIN_TEST_DATABASE_URL"].get()
    named = url.rsplit("/", 1)[-1].split("?")[0]
    if named != _DISTILL_CONFIG["DB_NAME"]:
        pytest.fail(
            f"refusing to run: OPENBRAIN_TEST_DATABASE_URL names {named!r} but the "
            f"distill script would write to DB_NAME={_DISTILL_CONFIG['DB_NAME']!r}"
        )
    if named == FORBIDDEN_DATABASE:
        pytest.fail(f"refusing to distill into the dogfood database {named!r}")
    return Secret(url)


def _client(base_url: str, token: str) -> OpenBrainClient:
    """A client for one token; the server derives the namespace from it."""
    return OpenBrainClient(
        base_url,
        token,
        "promoted-memory-retrieval-probe",
        timeout=60.0,
        allow_insecure_http=True,
    )


@pytest.fixture
def client_a(live_env: dict[str, Secret]) -> Iterator[OpenBrainClient]:
    """Identity A -- ingests the turn, promotes the candidate, finds the thought."""
    client = _client(live_env["OPENBRAIN_TEST_BASE_URL"].get(), live_env["OPENBRAIN_TEST_TOKEN"].get())
    try:
        yield client
    finally:
        client.close()


@pytest.fixture
def client_b(live_env: dict[str, Secret]) -> Iterator[OpenBrainClient]:
    """Identity B -- a different valid token, which must find none of it."""
    client = _client(
        live_env["OPENBRAIN_TEST_BASE_URL"].get(), live_env["OPENBRAIN_TEST_OTHER_TOKEN"].get()
    )
    try:
        yield client
    finally:
        client.close()


def _tool_payload(result: dict[str, Any]) -> Any:
    """The decoded tool payload, or the envelope itself when there is no content."""
    if "content" not in result:
        return result
    content = result["content"]
    assert isinstance(content, list) and content
    text = content[0].get("text")
    assert isinstance(text, str)
    return json.loads(text)


def _nonsense_word(marker: str) -> str:
    """A pronounceable word that exists nowhere else in the corpus.

    Derived from the marker so the sentence is unique per run: the keyword arm
    can then prove retrieval by a token no other row can carry.
    """
    return f"zorbil{marker.replace('-', '')[:10]}"


def _sentence(word: str) -> str:
    """One plain declarative sentence carrying the nonsense word.

    Modelled on ``RETRIEVAL_CONTENT`` in the pg test: an ordinary operational
    statement, so the paraphrase used for the vector arm is a fair test of
    meaning rather than of the odd token.
    """
    return (
        f"Weekly {word} telemetry rollups reconcile against the ledger snapshot "
        "before the finance team signs off on the quarter."
    )


#: A paraphrase: the same meaning, none of the distinctive words, and crucially
#: NOT the nonsense word -- so a hit can only come from the vector arm.
PARAPHRASE = (
    "Each week the usage metrics summaries are checked against the accounting "
    "record copy so the money people can approve the three-month period."
)


def _ingest(client: OpenBrainClient, marker: str, sentence: str) -> str:
    """Identity A ingests ONE raw turn. Returns its ``turn_uuid``.

    No namespace is passed: the server derives it from the token
    (``server/tools/memory-helpers.ts:141``).
    """
    turn_uuid = str(uuid.uuid4())
    payload = _tool_payload(
        client.ingest_raw_turn(
            turns=[
                {
                    "turn_uuid": turn_uuid,
                    "session_ref": f"promoted-retrieval-{marker}",
                    "turn_index": 0,
                    "role": "user",
                    "is_human_prompt": True,
                    "content": sentence,
                    "runtime": "issue-1469-live",
                    "occurred_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                }
            ]
        )
    )
    assert payload.get("ingested") == 1, payload
    return turn_uuid


def _distill() -> str:
    """Run the operator distill script until nothing is left. Returns its output.

    ``scripts/distill-run.ts`` takes no namespace or session option --
    ``accumulateSweeps`` (``scripts/distill-run.ts:93``) calls
    ``runDistillSweep`` without one -- so a single sweep distills whichever
    session is next, not necessarily this test's. Measured 2026-09-21: run after
    the other live tests had written their turns, one sweep took another
    session and this test's turn got no candidate. ``--all`` drains until a
    sweep stamps nothing (``scripts/distill-run.ts:120``), which is the only
    form that is certain to reach this turn.
    """
    completed = subprocess.run(  # noqa: S603 - fixed argv, absolute node, no shell
        [NODE, "scripts/distill-run.ts", "--all"],
        cwd=os.path.abspath(REPO_ROOT),
        env={**os.environ, **_DISTILL_CONFIG},
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    output = completed.stdout + completed.stderr
    assert completed.returncode == 0, f"distill-run failed:\n{output}"
    return output


def _candidate_for(database_url: str, turn_uuid: str) -> tuple[str, bool]:
    """The one candidate distilled from this turn, and whether it has an embedding.

    The join mirrors ``candidateFor`` in the pg test
    (``reviewed-candidate-chain.pg.test.ts:152``).

    It WAITS, because two actors distill a running playground and either may
    win: the operator script this test runs, and the service's own
    ``memory.distill`` maintenance job (``server/maintenance/distill-claim.ts``).
    When the service claims the session first, the script yields and returns
    having written nothing, and the candidate lands a moment later. Measured
    2026-09-21: run after the other live tests, this test looked once, found
    nothing, and the candidate for that same turn was in the table seconds
    afterwards. Who distilled it does not matter to the claim under test.
    """
    deadline = time.monotonic() + 90
    rows: list[Any] = []
    while not rows and time.monotonic() < deadline:
        with psycopg.connect(database_url) as connection:
            rows = connection.execute(
                "SELECT c.id, c.embedding IS NOT NULL "
                "FROM candidate_memory c "
                "JOIN ob_raw_turns t ON t.id = ANY(c.source_turn_ids) "
                "WHERE t.turn_uuid = %s",
                (turn_uuid,),
            ).fetchall()
        if not rows:
            time.sleep(0.5)
    assert len(rows) == 1, f"expected exactly one candidate for {turn_uuid}, got {rows}"
    return str(rows[0][0]), bool(rows[0][1])


def _approve(database_url: str, candidate_id: str) -> None:
    """Stand in for the human grader.

    Approval has no service trigger. This is the statement the real grader
    issues -- ``server/domain/candidate-review/batch-grade.ts:251`` -- narrowed
    to this test's one candidate.
    """
    with psycopg.connect(database_url) as connection:
        connection.execute(
            "UPDATE candidate_memory "
            "SET review_action = 'promoted', reviewed_at = now(), graded_by = %s "
            "WHERE id = %s",
            ("issue-1469-live-gate", candidate_id),
        )
        connection.commit()


def _live_thought_count(database_url: str, sentence: str) -> int:
    """How many un-archived thought rows carry exactly this content."""
    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT COUNT(*) FROM thoughts WHERE content = %s AND archived_at IS NULL",
            (sentence,),
        ).fetchone()
    assert row is not None
    return int(row[0])


def _archive_thought(database_url: str, sentence: str) -> None:
    """Take this run's thought out of search once the run is over.

    Every run promotes a sentence that differs from the last run's only by its
    nonsense word, so their embeddings are near-identical. Left searchable,
    they pile up and outrank each other for the paraphrase, and the rank
    assertion would start failing on this test's own leftovers. Search excludes
    archived rows (``server/tools/search-engine.ts:233``), so archiving is
    enough; the row stays for inspection.
    """
    with psycopg.connect(database_url) as connection:
        connection.execute(
            "UPDATE thoughts SET archived_at = now() "
            "WHERE content = %s AND archived_at IS NULL",
            (sentence,),
        )
        connection.commit()


def _search_rank(client: OpenBrainClient, query: str, mode: str, word: str) -> int | None:
    """The 1-based rank of the first result carrying ``word``, or ``None``.

    Rank, not a boolean: "findable at position 31" is not retrieval, and the
    brief asks the vector arm to place the promoted thought in the top 5.
    """
    found = _tool_payload(
        client.search_brain(query=query, table="thoughts", search_mode=mode, limit=10)
    )
    # ``search_brain`` returns the hit array itself, not a ``{"results": ...}``
    # envelope (measured against the playground at revision 16d912d7); the
    # dict form is tolerated so a later envelope change fails loudly elsewhere
    # rather than silently reporting "not found" here.
    results = found.get("results") if isinstance(found, dict) else found
    assert isinstance(results, list), found
    for index, item in enumerate(results, start=1):
        if word in json.dumps(item):
            return index
    return None


@dataclass(frozen=True)
class _Subject:
    """The one candidate under test, and the text that identifies its thought."""

    candidate_id: str
    sentence: str
    word: str


def _assert_absent(client: OpenBrainClient, query: str, word: str, why: str) -> None:
    """Neither search mode hands this client anything carrying ``word``."""
    for mode in ("vector", "hybrid"):
        rank = _search_rank(client, query, mode, word)
        assert rank is None, f"{why}: {mode} mode returned it at rank {rank}"


class TestAPromotedCandidateIsRetrievableByARealClient:
    """Gate 3 / gap G1: the chain, end to end, through a supported client."""

    def test_applied_promotion_is_found_by_its_promoter_and_by_nobody_else(
        self,
        guarded_database: Secret,
        client_a: OpenBrainClient,
        client_b: OpenBrainClient,
    ) -> None:
        """Ingest, distill, approve, dry run, apply, retrieve -- live."""
        marker = str(uuid.uuid4())
        word = _nonsense_word(marker)
        sentence = _sentence(word)

        turn_uuid = _ingest(client_a, marker, sentence)
        _distill()
        candidate_id, embedded = _candidate_for(guarded_database.get(), turn_uuid)
        assert embedded, (
            f"candidate {candidate_id} has a NULL embedding -- the vector arm "
            "cannot be proven. Check EMBEDDING_BASE_URL is reachable."
        )
        _approve(guarded_database.get(), candidate_id)

        dry = _tool_payload(client_a.promote_reviewed_candidate(candidate_id=candidate_id))
        assert dry.get("status") == "dry_run", dry
        assert dry.get("dry_run") is True, dry
        assert _live_thought_count(guarded_database.get(), sentence) == 0
        _assert_absent(client_a, sentence, word, "a dry run must stay unsearchable")

        try:
            self._apply_and_retrieve(
                guarded_database.get(),
                (client_a, client_b),
                _Subject(candidate_id=candidate_id, sentence=sentence, word=word),
            )
        finally:
            _archive_thought(guarded_database.get(), sentence)

    def _apply_and_retrieve(
        self,
        database_url: str,
        clients: tuple[OpenBrainClient, OpenBrainClient],
        subject: _Subject,
    ) -> None:
        """The second half: apply, then who can and cannot find the thought."""
        client_a, client_b = clients
        candidate_id, sentence, word = (
            subject.candidate_id,
            subject.sentence,
            subject.word,
        )
        applied = _tool_payload(
            client_a.promote_reviewed_candidate(candidate_id=candidate_id, dry_run=False)
        )
        assert applied.get("status") == "promoted", applied
        assert applied.get("is_new") is True, applied
        assert isinstance(applied.get("thought_id"), str), applied

        # Keyword-capable arm: the exact sentence, through hybrid.
        hybrid_rank = _search_rank(client_a, sentence, "hybrid", word)
        assert hybrid_rank is not None, "the promoter cannot find its own promoted thought"

        # Vector arm: a PARAPHRASE with none of the stored words, so a hit can
        # only come from similarity. The promoted thought copies the candidate's
        # embedding (reviewed-candidate-promotion-repository.ts:117), so this is
        # searchable the instant the apply returns.
        vector_rank = _search_rank(client_a, PARAPHRASE, "vector", word)
        assert vector_rank is not None, (
            "vector mode did not return the promoted thought for a paraphrase"
        )
        assert vector_rank <= 5, f"paraphrase ranked the promoted thought {vector_rank}"

        _assert_absent(client_b, sentence, word, "LEAK: identity B found A's thought")

        repeated = _tool_payload(
            client_a.promote_reviewed_candidate(candidate_id=candidate_id, dry_run=False)
        )
        assert repeated.get("status") == "duplicate", repeated
        assert repeated.get("is_new") is False, repeated
        assert _live_thought_count(database_url, sentence) == 1
