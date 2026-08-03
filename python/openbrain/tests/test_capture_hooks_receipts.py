"""The lifecycle wiring: which hook writes which receipt, and when it must not.

``test_receipts_state`` proves the writer works and ``test_receipts_gate_crosslang``
proves the gate accepts what it writes. Neither proves the hooks CALL it -- a
correct writer nobody invokes leaves the gate exactly as blocked as no writer at
all, which is the state the #420 cutover left behind and this change exists to
end.

These run the capabilities with injected lanes, so nothing here reaches a server
or a database, and every receipt lands in a per-test temporary file rather than
the running session's own state.

See Also:
    - ``openbrain.apps.hooks.receipts`` - the module being invoked
    - ``openbrain.apps.hooks.session`` - the capabilities that invoke it
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from conftest import (
    CanonPackReader,
    LaneUnreachableError,
    RecordingLane,
    UnreachableLane,
    operator_line,
    write_lines,
)
from openbrain.apps.hooks import receipts as hook_receipts
from openbrain.apps.hooks.session import (
    PostCompactHook,
    SessionStartHook,
    StartedLane,
    StopHook,
    run_post_compact,
    run_session_start,
    run_stop,
)
from openbrain.config import CanonSettings, CaptureSettings
from openbrain.receipts.scope import DEVELOPMENT_ROOT

#: A directory the scope resolver accepts, so a receipt is actually written.
IN_SCOPE_CWD = DEVELOPMENT_ROOT / "open-brain"

#: A directory it does not, so nothing is.
OUT_OF_SCOPE_CWD = Path.home()

SESSION_ID = "wiring-session"

pytestmark = pytest.mark.skipif(
    not IN_SCOPE_CWD.is_dir(),
    reason=(
        "receipt wiring is keyed on a project slug resolved from the real "
        "Development checkout; without it no receipt is written by design"
    ),
)


@pytest.fixture
def receipts_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect the shared receipt file into this test's temporary directory.

    The capabilities call the receipt helpers with no explicit path, so the only
    way to keep them off the running session's state is to move the default. This
    is also the honest shape: it exercises ``default_receipt_state_path`` rather
    than bypassing it.
    """
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    return (
        tmp_path
        / "state"
        / "agent-runtime"
        / "openbrain-memory"
        / "receipts.json"
    )


def _document(path: Path) -> dict[str, Any]:
    """The receipt file, decoded, or an empty document when nothing was written."""
    if not path.exists():
        return {}
    decoded = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(decoded, dict)
    return decoded


def _capture_settings(tmp_path: Path) -> CaptureSettings:
    """Capture config whose watermark store is per-test."""
    return CaptureSettings(watermark_path=tmp_path / "watermarks.sqlite")


def _lane_factory(lane: object) -> Any:
    """A factory returning ``lane`` with a no-op closer, as the tests' spine does."""
    return lambda _settings, _key: StartedLane(lane=lane, close=lambda: None)


def _transcript(tmp_path: Path) -> Path:
    """One operator turn on disk, the smallest thing a ``Stop`` can deliver."""
    path = tmp_path / "transcript.jsonl"
    write_lines(path, [operator_line("u1", "hello")])
    return path


def _stop(transcript: Path, cwd: Path, settings: CaptureSettings, lane: object) -> Any:
    """Run one ``Stop`` through the real capability with an injected lane."""
    return asyncio.run(
        run_stop(
            StopHook(transcript_path=transcript, session_id=SESSION_ID, cwd=cwd),
            settings,
            lane_factory=_lane_factory(lane),
        )
    )


def test_stop_writes_a_capture_receipt(
    tmp_path: Path, receipts_path: Path
) -> None:
    """A delivered turn leaves the evidence the gate's capture block clears on."""
    transcript = _transcript(tmp_path)

    _stop(transcript, IN_SCOPE_CWD, _capture_settings(tmp_path), RecordingLane())

    sessions = _document(receipts_path)["sessions"]
    assert set(sessions[SESSION_ID]) == {"capture"}
    assert sessions[SESSION_ID]["capture"]["mode"] == "verified-remote"


def test_a_failed_delivery_writes_no_capture_receipt(
    tmp_path: Path, receipts_path: Path
) -> None:
    """A lane that raised produced no durable write, so it earns no evidence.

    This is the property that makes the receipt worth reading. If a failed
    delivery still filed one, the gate would clear its block on a turn that never
    reached Open Brain -- which is precisely the claim-versus-evidence confusion
    the gate exists to catch.
    """
    transcript = _transcript(tmp_path)

    with pytest.raises(LaneUnreachableError):
        _stop(transcript, IN_SCOPE_CWD, _capture_settings(tmp_path), UnreachableLane())

    assert _document(receipts_path) == {}


def test_an_out_of_scope_cwd_writes_no_receipt(
    tmp_path: Path, receipts_path: Path
) -> None:
    """A session outside Development files nothing -- the gate tracks no block for it."""
    transcript = _transcript(tmp_path)

    _stop(transcript, OUT_OF_SCOPE_CWD, _capture_settings(tmp_path), RecordingLane())

    assert _document(receipts_path) == {}


def test_post_compact_opens_the_cycle_the_gate_blocks_on(
    tmp_path: Path, receipts_path: Path
) -> None:
    """Recording the summary also arms the correlation the recall must later name."""
    payload = PostCompactHook(
        compact_summary="a summary",
        session_id=SESSION_ID,
        prompt_id="00000000-0000-4000-8000-000000000001",
        cwd=IN_SCOPE_CWD,
    )

    asyncio.run(
        run_post_compact(
            payload, _capture_settings(tmp_path), lane_factory=_lane_factory(RecordingLane())
        )
    )

    cycles = _document(receipts_path)["compactCycles"]
    assert cycles[SESSION_ID]["attemptedParticipants"] == ["post-compact"]
    assert "verifiedRecallAt" not in cycles[SESSION_ID]


def test_a_post_compact_with_no_summary_opens_no_cycle(
    tmp_path: Path, receipts_path: Path
) -> None:
    """No summary recorded means no compaction to arm a block over.

    Arming the gate for a compaction whose summary was never stored would block
    the session over work that did not happen.
    """
    payload = PostCompactHook(session_id=SESSION_ID, cwd=IN_SCOPE_CWD)

    asyncio.run(
        run_post_compact(
            payload, _capture_settings(tmp_path), lane_factory=_lane_factory(RecordingLane())
        )
    )

    assert _document(receipts_path) == {}


def test_a_compact_session_start_writes_the_verified_recall(
    tmp_path: Path, receipts_path: Path
) -> None:
    """The full arm-then-release pair, through the real capabilities.

    ``PostCompact`` opens the cycle; the ``compact`` ``SessionStart`` reads canon
    and stamps ``verifiedRecallAt`` on that SAME cycle. That stamp is what the
    gate reads to unblock, so this is the wiring the whole change exists for.
    """
    settings = _capture_settings(tmp_path)
    asyncio.run(
        run_post_compact(
            PostCompactHook(
                compact_summary="a summary",
                session_id=SESSION_ID,
                prompt_id="00000000-0000-4000-8000-000000000001",
                cwd=IN_SCOPE_CWD,
            ),
            settings,
            lane_factory=_lane_factory(RecordingLane()),
        )
    )
    opened = _document(receipts_path)["compactCycles"][SESSION_ID]["id"]

    asyncio.run(
        run_session_start(
            SessionStartHook(session_id=SESSION_ID, source="compact", cwd=IN_SCOPE_CWD),
            CanonSettings(),
            canon_factory=CanonPackReader(),
        )
    )

    cycle = _document(receipts_path)["compactCycles"][SESSION_ID]
    assert cycle["id"] == opened, "the recall must join the cycle PostCompact opened"
    assert "verifiedRecallAt" in cycle


def test_a_startup_session_start_writes_no_recall_receipt(
    tmp_path: Path, receipts_path: Path
) -> None:
    """An ordinary session start is not a post-compaction read-back.

    Writing a ``compact`` recall receipt here would clear a read-back block that a
    real compaction had every right to hold -- the gate would be released by a
    session merely opening.
    """
    asyncio.run(
        run_session_start(
            SessionStartHook(session_id=SESSION_ID, source="startup", cwd=IN_SCOPE_CWD),
            CanonSettings(),
            canon_factory=CanonPackReader(),
        )
    )

    assert _document(receipts_path) == {}


def test_a_receipt_failure_does_not_break_the_capability(
    tmp_path: Path, receipts_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The evidence is never worth failing the work it describes.

    The turn is already delivered by the time the receipt is written. A hook that
    raised because it could not file the note would discard a successful capture
    to protect the record of it.
    """

    class UnwritableReceiptFileError(OSError):
        """The receipt file could not be written -- the failure being swallowed."""

        def __init__(self) -> None:
            """State what failed. No path is named; the log line is content-free."""
            super().__init__("the receipt file could not be written")

    def explode(*_args: object, **_kwargs: object) -> None:
        raise UnwritableReceiptFileError

    monkeypatch.setattr(hook_receipts, "record_provider_receipt", explode)
    transcript = _transcript(tmp_path)
    lane = RecordingLane()

    delivery = _stop(transcript, IN_SCOPE_CWD, _capture_settings(tmp_path), lane)

    assert delivery is not None
    assert lane.turns, "the turn must still have been delivered"
