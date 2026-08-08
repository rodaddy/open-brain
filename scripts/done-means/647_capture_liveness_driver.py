#!/usr/bin/env python
"""Done-means driver for #647 — the capture-side clauses.

Run through ``scripts/done-means/647-capture-liveness.sh``, which owns the
summary line. This file owns clauses (a), (b), (c), (c-role), (e), (f), (g) and
its own exit code.

DETERMINISM CONTRACT (docs/lane-contract.md, Tightenings round 5): there is no
``sleep`` and no wall-clock threshold anywhere in the assertions. Time is a
variable this driver assigns and injects. Every verdict is derived from EVENT
COUNTS -- sessions observed, turns delivered, spool depth, announcements made.

EXISTING DESIGN THIS IS A DELTA ON
----------------------------------
``docs/decisions/capture-never-drops-a-turn.md`` already specifies the correct
capture health check, and specifies it twice:

  :182-186  "The correct health check is the simple one, not hook mechanics:
            compare typed-in-transcript against ``is_human_prompt`` rows in
            ``ob_raw_turns`` for a live session ... the instinct to measure
            window sizes should be resisted."

  :188-200  "Run it PER ROLE, not just for the operator. As written above this
            check watches one speaker, and that blind spot is exactly how #447
            went unnoticed for six days: the operator numbers stayed healthy
            the entire time the assistant side was at zero."

That document does not lack a design -- it lacks an EXECUTABLE one. It says at
:280 that "the check it asks for was never run". This driver is the delta: the
documented comparison, made executable, count-based, and composed into health.

The per-role dimension is therefore NOT an embellishment. A liveness reader
that sums across roles reproduces the exact blind spot the decision names:
2026-08-02 measured 13 assistant rows against 365 user rows (:291), and a
whole-lane total would have read as healthy traffic.

SUBJECT: the real ``openbrain.apps.capture.liveness`` reader. Nothing under
test is re-implemented here -- the #624 harvest ("injected-dependency tests can
100%-cover a module whose production composition is broken") is why the check
drives the shipped reader and fakes only its leaf inputs.
"""

from __future__ import annotations

import sys
import time

_RESULTS: list[tuple[str, bool, str]] = []


def clause(name: str, ok: bool, detail: str) -> None:
    _RESULTS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  ({name}) {detail}")


#: Deliberately vast relative to the driver's own runtime -- see clause (g).
SIMULATED_SILENCE_S = 30 * 60.0

#: Clause names this driver owns, used to report the RED path uniformly.
_CAPTURE_CLAUSES = ("a", "b", "b-announced", "c", "c-single", "c-role", "e", "f")


def _all_absent(reason: str) -> None:
    """Report every capture-side clause as failed for one structural reason."""
    for name in _CAPTURE_CLAUSES:
        clause(name, False, reason)


def main() -> int:
    driver_started_at = time.monotonic()

    # The import is INSIDE main and guarded so the RED on current code is a
    # reported clause failure, not a traceback at module load. A check that
    # cannot start cannot distinguish "not built yet" from "check is broken".
    try:
        from openbrain.apps.capture import liveness as liveness_mod
    except ImportError as exc:
        _all_absent(f"no capture liveness reader exists to import: {exc}")
        return _verdict(driver_started_at)

    read_liveness = getattr(liveness_mod, "read_capture_liveness", None)
    observation = getattr(liveness_mod, "CaptureObservation", None)
    role_observation = getattr(liveness_mod, "RoleObservation", None)
    if read_liveness is None or observation is None or role_observation is None:
        _all_absent(
            "capture liveness module is missing one of read_capture_liveness / "
            "CaptureObservation / RoleObservation"
        )
        return _verdict(driver_started_at)

    def healthy_roles() -> dict[str, object]:
        """Role counts that are themselves in good order.

        Used by every clause that is probing a NON-role fault, so that clause
        cannot pass on the strength of a role imbalance it did not intend.
        """
        return {
            "user": role_observation(turns_delivered=120),
            "assistant": role_observation(turns_delivered=118),
        }

    def silent_roles() -> dict[str, object]:
        return {
            "user": role_observation(turns_delivered=0),
            "assistant": role_observation(turns_delivered=0),
        }

    # ------------------------------------------------------------------
    # Clause (a) -- watermark not advancing while sessions run.
    #
    # Counts only: 12 sessions were observed delivering, and the summed
    # watermark advance across all of them is ZERO bytes. No clock reading is
    # part of this verdict; the injected `now` supplies only the age FIELD the
    # reading reports, never the pass condition.
    # ------------------------------------------------------------------
    wedged = read_liveness(
        observation(
            sessions_observed=12,
            watermark_bytes_advanced=0,
            spool_pending=0,
            outage_announcements=0,
            roles=silent_roles(),
            last_delivery_at=1_000_000.0,
        ),
        now=lambda: 1_000_000.0 + SIMULATED_SILENCE_S,
    )
    clause(
        "a",
        wedged is not None
        and wedged.stale is True
        and wedged.watermark_wedged is True,
        f"12 sessions delivering, 0 bytes advanced -> stale="
        f"{getattr(wedged, 'stale', None)} watermark_wedged="
        f"{getattr(wedged, 'watermark_wedged', None)} "
        f"reason={getattr(wedged, 'reason', None)!r}",
    )

    # ------------------------------------------------------------------
    # Clause (b) -- spool accumulating with NO outage latch announced.
    #
    # The nastiest real shape. OutageLatch.note_spooled/note_delivered
    # (outage.py:411/424) return None for THREE different situations -- no
    # change, already degraded, suppressed by cooldown -- so a latch that never
    # fires at all is indistinguishable from a healthy one at the call site.
    # Depth rising while announcements stay at zero is the discriminator.
    # ------------------------------------------------------------------
    silent_spool = read_liveness(
        observation(
            sessions_observed=6,
            watermark_bytes_advanced=4096,
            spool_pending=137,
            outage_announcements=0,
            roles=healthy_roles(),
            last_delivery_at=2_000_000.0,
        ),
        now=lambda: 2_000_000.0 + SIMULATED_SILENCE_S,
    )
    clause(
        "b",
        silent_spool is not None
        and silent_spool.stale is True
        and silent_spool.spool_unannounced is True,
        f"spool depth 137 with 0 announcements -> stale="
        f"{getattr(silent_spool, 'stale', None)} spool_unannounced="
        f"{getattr(silent_spool, 'spool_unannounced', None)} "
        f"reason={getattr(silent_spool, 'reason', None)!r}",
    )

    # A spool that is deep but HAS announced its outage is a known, reported
    # condition, not a silent fault: the operator has already been told, which
    # is exactly what OutageLatch exists to do. Flagging it as the silent-spool
    # shape would make the loudest correct behaviour look like the failure.
    announced_spool = read_liveness(
        observation(
            sessions_observed=6,
            watermark_bytes_advanced=4096,
            spool_pending=137,
            outage_announcements=1,
            roles=healthy_roles(),
            last_delivery_at=2_000_000.0,
        ),
        now=lambda: 2_000_000.0 + SIMULATED_SILENCE_S,
    )
    clause(
        "b-announced",
        announced_spool is not None
        and announced_spool.spool_unannounced is False,
        "an ANNOUNCED outage of the same depth is not the silent-spool fault "
        f"-> spool_unannounced="
        f"{getattr(announced_spool, 'spool_unannounced', None)}",
    )

    # ------------------------------------------------------------------
    # Clause (c) -- zero capture events across N recent ACTIVE sessions.
    #
    # "Active" is a COUNT the caller supplies, never a clock reading.
    # ------------------------------------------------------------------
    zero_events = read_liveness(
        observation(
            sessions_observed=9,
            watermark_bytes_advanced=0,
            spool_pending=0,
            outage_announcements=0,
            roles=silent_roles(),
            last_delivery_at=3_000_000.0,
        ),
        now=lambda: 3_000_000.0 + SIMULATED_SILENCE_S,
    )
    clause(
        "c",
        zero_events is not None
        and zero_events.stale is True
        and zero_events.sessions_observed == 9,
        f"9 active sessions, 0 turns delivered -> stale="
        f"{getattr(zero_events, 'stale', None)} sessions_observed="
        f"{getattr(zero_events, 'sessions_observed', None)} "
        f"reason={getattr(zero_events, 'reason', None)!r}",
    )

    # A single observed session that delivered nothing is NOT yet evidence of a
    # dead lane -- a session can legitimately produce no operator turns. The
    # threshold is a count, and it must exceed one, or the signal fires on
    # ordinary quiet and gets ignored, which is how a real alarm dies.
    one_quiet_session = read_liveness(
        observation(
            sessions_observed=1,
            watermark_bytes_advanced=0,
            spool_pending=0,
            outage_announcements=0,
            roles=silent_roles(),
            last_delivery_at=3_000_000.0,
        ),
        now=lambda: 3_000_000.0 + SIMULATED_SILENCE_S,
    )
    clause(
        "c-single",
        one_quiet_session is not None and one_quiet_session.stale is False,
        "one quiet session alone does not declare the lane dead -> "
        f"stale={getattr(one_quiet_session, 'stale', None)}",
    )

    # ------------------------------------------------------------------
    # Clause (c-role) -- ONE ROLE at zero while the other is healthy.
    #
    # This is #447 reproduced as numbers, and it is the clause that proves the
    # reader is not summing. The real measurement
    # (docs/decisions/capture-never-drops-a-turn.md:291) was 13 assistant rows
    # against 365 user rows on 2026-08-02, while the lane looked busy in total.
    # A whole-lane counter reads 365 turns and reports busy traffic; only the
    # per-role view sees a dead speaker.
    # ------------------------------------------------------------------
    half_dead = read_liveness(
        observation(
            sessions_observed=9,
            watermark_bytes_advanced=1_048_576,
            spool_pending=0,
            outage_announcements=0,
            roles={
                "user": role_observation(turns_delivered=365),
                "assistant": role_observation(turns_delivered=0),
            },
            last_delivery_at=4_500_000.0,
        ),
        now=lambda: 4_500_000.0 + 1.0,
    )
    clause(
        "c-role",
        half_dead is not None
        and half_dead.stale is True
        and "assistant" in (half_dead.silent_roles or ()),
        "365 user turns beside 0 assistant turns is a dead speaker, not a busy "
        f"lane -> stale={getattr(half_dead, 'stale', None)} silent_roles="
        f"{getattr(half_dead, 'silent_roles', None)!r} "
        f"reason={getattr(half_dead, 'reason', None)!r}",
    )

    # ------------------------------------------------------------------
    # Clause (e) -- CONTROL: a healthy lane stays healthy.
    #
    # Without this, a reader hard-coded to "stale" passes (a)-(c-role) while
    # destroying the signal entirely, and banks a free GREEN doing it.
    # ------------------------------------------------------------------
    healthy = read_liveness(
        observation(
            sessions_observed=9,
            watermark_bytes_advanced=1_048_576,
            spool_pending=0,
            outage_announcements=0,
            roles=healthy_roles(),
            last_delivery_at=4_000_000.0,
        ),
        now=lambda: 4_000_000.0 + 1.0,
    )
    clause(
        "e",
        healthy is not None
        and healthy.stale is False
        and healthy.watermark_wedged is False
        and healthy.spool_unannounced is False
        and not healthy.silent_roles,
        "control: 9 sessions, 238 turns across both roles, 1MiB advanced, "
        f"spool 0 -> stale={getattr(healthy, 'stale', None)} wedged="
        f"{getattr(healthy, 'watermark_wedged', None)} spool_unannounced="
        f"{getattr(healthy, 'spool_unannounced', None)} silent_roles="
        f"{getattr(healthy, 'silent_roles', None)!r}",
    )

    # ------------------------------------------------------------------
    # Clause (f) -- CONTROL: absence is not staleness.
    #
    # docs/lane-contract.md Tightenings round 8, generalized from #625: "a
    # component that is not composed must not be reported broken, or every
    # opted-out worker degrades itself." A process that composes NO capture
    # lane must produce NO reading -- not a stale one, and not a fabricated
    # healthy one either. None is the honest answer, and it is what lets the
    # health layer omit the block entirely rather than assert a green it did
    # not measure.
    # ------------------------------------------------------------------
    absent = read_liveness(None, now=lambda: 5_000_000.0)
    clause(
        "f",
        absent is None,
        f"an uncomposed capture lane yields {absent!r} (expected None: absent "
        "means 'not my job', not 'broken', and not 'fine')",
    )

    return _verdict(driver_started_at)


def _verdict(driver_started_at: float) -> int:
    # ------------------------------------------------------------------
    # Clause (g) -- the clock really is injected.
    #
    # If this ever fails, the check has silently become a sleep-based test and
    # has inherited the CI-flake class it was written to avoid (#632/#634).
    # ------------------------------------------------------------------
    elapsed = time.monotonic() - driver_started_at
    clause(
        "g",
        elapsed < SIMULATED_SILENCE_S / 10,
        f"simulated {SIMULATED_SILENCE_S:.0f}s of capture silence in "
        f"{elapsed:.3f}s of wall clock -- clock is injected, not slept",
    )

    failed = [name for name, ok, _ in _RESULTS if not ok]
    print()
    print(f"clauses: {len(_RESULTS)} run, {len(failed)} failed")
    if failed:
        print(f"failing: {', '.join(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
