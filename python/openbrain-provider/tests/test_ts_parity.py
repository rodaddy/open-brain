"""Byte-parity with the live TypeScript gates, on their own recorded I/O.

Every case here is a recording of the TypeScript gate answering a real event.
The Python gate is fed the same stdin and arguments and must produce the same
stdout and the same exit code, modulo the two things that differ between any two
runs of the same program: instants and freshly-generated UUIDs.

THE CASES REPLAY IN ORDER, AGAINST ONE STATE DIRECTORY, because that is how they
were recorded. Half of them only mean anything as a sequence -- a `post-compact`
arms a session and the next case proves the block, so replaying each in a fresh
directory would test a different program. The whole sequence runs once in a
session fixture and every case then asserts against its own recorded answer.

A failure here is not a formatting nit. The hook contract IS the bytes: a
`decision` key spelled differently is an unenforced gate, and a recovery command
rendered differently is a command the gate then refuses.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import NamedTuple

import pytest
from parity_runner import ParityCase, load_cases, normalise, run_case

FIXTURE = Path(__file__).parent / "fixtures" / "ts_gate_parity" / "recorded.json"
CASES = load_cases(FIXTURE)


class Replay(NamedTuple):
    """One case's recorded answer beside the answer Python produced."""

    case: ParityCase
    produced: str
    code: int
    scratch: Path


@pytest.fixture(scope="module")
def replays(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Replay]:
    """Replay every recorded case, in order, against one state directory.

    Args:
        tmp_path_factory: pytest's per-module temp directory factory.

    Returns:
        Each case's produced answer, keyed by case name.
    """
    scratch = tmp_path_factory.mktemp("ts-parity")
    results: dict[str, Replay] = {}
    for case in CASES:
        produced, code = run_case(case, scratch)
        results[case.name] = Replay(case, produced, code, scratch)
    return results


def test_the_recordings_exist_and_cover_both_gates() -> None:
    # A fixture file that silently became empty would make every parity test
    # below pass while proving nothing -- the same class of defect as a live
    # test that skips without its database.
    assert len(CASES) >= 30
    assert {case.script for case in CASES} == {"budget", "policy"}


@pytest.mark.parametrize("name", [case.name for case in CASES])
def test_matches_the_typescript_gate(name: str, replays: dict[str, Replay]) -> None:
    replay = replays[name]
    assert normalise(replay.produced, replay.scratch) == normalise(
        replay.case.stdout, replay.scratch
    ), name
    assert replay.code == replay.case.status, name


def test_a_block_is_json_with_a_reason_and_exit_zero(
    replays: dict[str, Replay],
) -> None:
    # The shape a runtime actually enforces on: a block is DATA on stdout, and
    # the exit code stays 0. A non-zero exit means the hook itself failed, which
    # the harness handles differently.
    blocked = [
        replay
        for replay in replays.values()
        if replay.case.stdout.startswith("{") and '"decision"' in replay.case.stdout
    ]
    assert blocked, "no recorded block to compare against"
    for replay in blocked:
        payload = json.loads(replay.produced)
        assert payload["decision"] == "block", replay.case.name
        assert isinstance(payload["reason"], str) and payload["reason"]
        assert replay.code == 0, replay.case.name


def test_an_allow_emits_nothing_at_all(replays: dict[str, Replay]) -> None:
    # Not an empty JSON object, not a newline: NOTHING. Both runtimes read empty
    # stdout as allow, and a top-level `decision: "allow"` is invalid.
    allowed = [replay for replay in replays.values() if replay.case.stdout == ""]
    assert allowed, "no recorded allow to compare against"
    for replay in allowed:
        assert replay.produced == "", replay.case.name
        assert replay.code == 0, replay.case.name


def test_a_refusal_exits_one_and_says_why(replays: dict[str, Replay]) -> None:
    # A REFUSED operator command is the one case that exits non-zero, because
    # the operator asked for something and did not get it. It must also say what
    # to do instead -- an exit code alone is not an error message.
    refused = [replay for replay in replays.values() if replay.case.status == 1]
    assert refused, "no recorded refusal to compare against"
    for replay in refused:
        assert replay.code == 1, replay.case.name
        assert replay.produced.startswith("REFUSED:"), replay.case.name
