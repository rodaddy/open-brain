"""DONE-MEANS driver (client half) for #680 — a quarantine drop is never silent.

Drives the REAL ``JsonlSpool`` through five genuine consecutive replay failures
(the shipped ``DEFAULT_QUARANTINE_THRESHOLD``) and then asks the question the
pre-flight doc asks: after the drop, does any operator-facing count still know
the records exist?

WHY THIS SHAPE. The defect is not "quarantine happens" — quarantine is designed
(``docs/memory-limits.md:25``). The defect is that the capture lane's own
observability reads the LIVE spool only (``outage.spool_pending``), so the
quarantine move makes the number go DOWN: 15 real turns became pending=0 on
2026-07-30 and nothing said a word. So every clause here is about what a READER
sees after the drop, never about whether the sidecar file was written.

Content-free output: clause names, states, and counts only — never payloads.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "python" / "openbrain-memory" / "src"))
sys.path.insert(0, str(REPO_ROOT / "python" / "openbrain" / "src"))

from openbrain_memory.spool import (  # noqa: E402
    DEFAULT_QUARANTINE_THRESHOLD,
    JsonlSpool,
)

FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str) -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")
    if not ok:
        FAILURES.append(name)


_MISSING = object()


def resolve(module: Any, name: str) -> Any:
    """Look up a symbol that may not exist yet, WITHOUT crashing the run.

    A bare ``module.new_function(...)`` raises ``AttributeError`` at the
    pre-fix tree and kills every clause after it — a crash upstream of the
    measurement, which is a FALSE RED indistinguishable in shape from a real
    one and reached by the ordinary act of checking for a capability that does
    not exist yet (``docs/lane-contract.md`` round 18, the Python spelling of
    the dynamic-import rule). Resolving through a sentinel lets each clause
    report its own honest FAIL for the defect's own reason.
    """
    return getattr(module, name, _MISSING)


def call(fn: Any, *args: Any) -> Any:
    """Call a resolved symbol, or return the sentinel when it is absent."""
    if fn is _MISSING:
        return _MISSING
    return fn(*args)


def quarantine_one_unit(spool_path: Path) -> JsonlSpool:
    """Append one unit and fail its replay exactly ``threshold`` times.

    Returns the spool, with the unit quarantined by the real code path — no
    hand-written sidecar. A hand-built fixture would prove the fixture.
    """
    spool = JsonlSpool(spool_path)

    spool.append(
        operation="ingest_raw_turn",
        payload={"turns": [{"turn_uuid": "done-means-680-turn", "role": "user"}]},
    )

    def always_fails(record: Any) -> Any:
        raise RuntimeError("done-means forced delivery failure")

    for _ in range(DEFAULT_QUARANTINE_THRESHOLD):
        spool.replay_with_report(always_fails)

    return spool


def main() -> int:
    print(f"INFO  quarantine threshold under test: {DEFAULT_QUARANTINE_THRESHOLD}")

    with tempfile.TemporaryDirectory(prefix="done-means-680-") as tmp:
        spool_path = Path(tmp) / "claude-spool.jsonl"
        spool = quarantine_one_unit(spool_path)
        status = spool.status()

        # ------------------------------------------------------------------
        # (setup) The precondition every other clause reasons about: five
        # forced failures really did quarantine the unit and empty the live
        # spool. If this is not true the rest of the run proves nothing, so it
        # is asserted rather than assumed.
        # ------------------------------------------------------------------
        check(
            "setup-quarantined",
            status.quarantined_count == 1 and status.pending_count == 0,
            f"{DEFAULT_QUARANTINE_THRESHOLD} forced failures -> "
            f"quarantined_count={status.quarantined_count} "
            f"pending_count={status.pending_count} "
            "(the live spool is empty and the records are in the sidecar)",
        )

        # ------------------------------------------------------------------
        # (a) THE DEFECT ITSELF. The capture lane's operator-facing count must
        # not read 0 while records sit abandoned in the sidecar. This is the
        # exact live symptom: /health said spool_pending:0 with 15 turns gone.
        #
        # Asserts the COUNT, not the presence of a function: a reader that
        # returns 0 here is the shipped defect regardless of what it is named.
        # ------------------------------------------------------------------
        from openbrain.apps.capture import outage  # noqa: PLC0415

        pending = outage.spool_pending(spool_path)
        check(
            "a-pending-not-blind",
            pending is not None and pending > 0,
            f"after the drop, the capture lane's pending count reads {pending!r} "
            "(0 or None means the records are invisible to every operator surface)",
        )

        # ------------------------------------------------------------------
        # (b) LOUD, AND SPECIFICALLY ABOUT QUARANTINE. A count that merely
        # went up could be an ordinary outage backlog — indistinguishable from
        # the healthy "held for replay" case an operator is trained to ignore.
        # The notice must NAME the abandoned records, because the two states
        # need different operator actions: an outage backlog drains itself, a
        # quarantined unit never will.
        #
        # Both halves in ONE clause (round 17): a count that rose AND a notice
        # that says the word. Split, each half passes for the wrong reason.
        # ------------------------------------------------------------------
        spool_quarantined = resolve(outage, "spool_quarantined")
        quarantined = call(spool_quarantined, spool_path)
        notice = (
            outage.spool_notice(outage.DEGRADED_NOTICE, pending, quarantined)
            if quarantined is not _MISSING
            else "<no quarantine reader exists>"
        )
        check(
            "b-notice-names-quarantine",
            quarantined == 1 and "quarantin" in notice.lower(),
            f"quarantined={quarantined!r} and the operator notice names it: {notice!r}",
        )

        # ------------------------------------------------------------------
        # (c) CONTROL — HEALTHY STAYS QUIET (round 8: every failure-signal
        # check needs a control proving the healthy path stays healthy).
        # A spool with nothing quarantined must produce the ORDINARY notice
        # with no quarantine wording. Without this, "always shout quarantine"
        # passes (a) and (b) and trains the operator to ignore the line.
        # ------------------------------------------------------------------
        clean_path = Path(tmp) / "clean-spool.jsonl"
        clean = JsonlSpool(clean_path)
        clean.append(
            operation="ingest_raw_turn",
            payload={"turns": [{"turn_uuid": "done-means-680-healthy", "role": "user"}]},
        )
        clean_pending = outage.spool_pending(clean_path)
        clean_quarantined = call(spool_quarantined, clean_path)
        clean_notice = (
            outage.spool_notice(
                outage.DEGRADED_NOTICE, clean_pending, clean_quarantined
            )
            if clean_quarantined is not _MISSING
            else "<no quarantine reader exists>"
        )
        check(
            "c-control-healthy-quiet",
            clean_quarantined == 0
            and clean_pending == 1
            and "quarantin" not in clean_notice.lower(),
            f"an ordinary held turn reports quarantined={clean_quarantined} "
            f"pending={clean_pending} and says nothing about quarantine: {clean_notice!r}",
        )

        # ------------------------------------------------------------------
        # (d) UNREADABLE IS NOT ZERO. `spool_pending` already distinguishes
        # "absent -> 0" from "unreadable -> None" on purpose, because a count
        # is the one thing on that line an operator acts on. The quarantine
        # reader inherits that contract: guessing 0 for a sidecar it could not
        # read would recreate this very defect one directory over.
        #
        # Driven by pointing the reader at a DIRECTORY where the sidecar file
        # is expected — a real OSError from the real code path, not a mock.
        # ------------------------------------------------------------------
        unreadable_spool = Path(tmp) / "unreadable-spool.jsonl"
        unreadable_spool.write_text("", encoding="utf-8")
        sidecar_dir = Path(str(unreadable_spool) + ".quarantine.jsonl")
        sidecar_dir.mkdir()
        unreadable = call(spool_quarantined, unreadable_spool)
        check(
            "d-unreadable-is-none",
            unreadable is None,
            f"an unreadable quarantine sidecar reads {unreadable!r}, not a guessed 0",
        )

        # ------------------------------------------------------------------
        # (e) ABSENT IS GENUINELY ZERO. The other side of (d): no sidecar at
        # all is a real, knowable zero and must NOT degrade to None, or every
        # healthy machine on earth prints an unknown-count line forever.
        # ------------------------------------------------------------------
        absent = call(spool_quarantined, Path(tmp) / "never-existed.jsonl")
        check(
            "e-absent-is-zero",
            absent == 0,
            f"a spool with no quarantine sidecar reads {absent!r}",
        )

        # ------------------------------------------------------------------
        # (f) THE SIDECAR IS INTACT AND REPLAYABLE. "Never a silent drop" is
        # only half the promise; the records must still BE there for the
        # operator's replay decision (issue #680 item 4). Reads the envelope
        # back and asserts the abandoned unit is identifiable by operation and
        # spool key — content-free, no payload assertions.
        # ------------------------------------------------------------------
        sidecar = Path(str(spool_path) + ".quarantine.jsonl")
        envelopes = [
            json.loads(line)
            for line in sidecar.read_text(encoding="utf-8").splitlines()
            if line.strip().startswith("{") and '"schema"' in line
        ]
        check(
            "f-sidecar-replayable",
            len(envelopes) == 1
            and envelopes[0].get("consecutive_failures") == DEFAULT_QUARANTINE_THRESHOLD,
            f"the sidecar holds {len(envelopes)} envelope(s) recording "
            f"consecutive_failures="
            f"{envelopes[0].get('consecutive_failures') if envelopes else 'n/a'} "
            "— the records survive for an operator replay decision",
        )

    print()
    if FAILURES:
        print(f"CLIENT-HALF FAIL — {len(FAILURES)} clause(s): {', '.join(FAILURES)}")
        return 1
    print("CLIENT-HALF PASS — a quarantine drop is visible and named at the capture lane.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
