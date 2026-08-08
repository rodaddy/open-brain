#!/usr/bin/env bash
# DONE-MEANS check for issue #625 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/625-sweep-heartbeat.sh
#
# Issue #625, verbatim ask:
#   - reproduce (watch sweep cadence vs config)
#   - root-cause the stall (timer starvation? claim contention? tick swallowed
#     by an error path?)
#   - decide whether /health should reflect producer liveness (last-sweep-age)
#     so quiet-but-green cannot recur.
#
# ---------------------------------------------------------------------------
# WHY THIS CHECK IS DETERMINISTIC AND NOT A LIVE-CLONE WATCH
# ---------------------------------------------------------------------------
# The issue's own "done means" sketch proposes watching the live clone for
# sweep-complete lines "within N x the configured interval over an M-interval
# window". That is a WALL-CLOCK assertion, and the lane contract's Tightenings
# round 5 (docs/lane-contract.md — "Wall-clock assertions ... are CI flake
# generators", #632/#634) forbids exactly that shape. A check whose RED can be
# produced by a busy machine cannot distinguish the defect from the weather.
#
# So the observation moves off the clock and onto EVENT COUNTS with an INJECTED
# clock: the sweep is driven with a tick that never settles, time is advanced by
# assignment rather than by waiting, and the assertions are about which signals
# were emitted and what /health computed. The property being proven is not "the
# sweep was slow" — it is "the sweep was quiet AND health still said healthy",
# which is logic, not timing.
#
# ---------------------------------------------------------------------------
# WHAT IS ACTUALLY BROKEN, read from source at origin/main
# ---------------------------------------------------------------------------
# src/maintenance-sweep.ts:306-322 (startRecurringMaintenanceSweep):
#
#     const runOnce = (): Promise<void> => {
#       if (stopping) return Promise.resolve();
#       if (active) return active;          <-- SILENT
#       ...
#
# Not starting a second overlapping tick is CORRECT behavior. Emitting nothing
# when it happens is the defect. When one tick blocks — a slow
# selectDistillLaneBatches, a pool connection that never returns, a lock — every
# subsequent interval fires, hits that line, and returns with zero output. The
# producer is then indistinguishable from one that is keeping up, because both
# emit nothing between sweeps. That is the ~18 minutes of quiet in #625: not the
# timer starving, but the overlap guard swallowing every tick after the hang.
#
# _DOCS/STANDARDS-observability.md requires a signal at five points and names
# "guard/limit trigger (warning)" as one of them, then states the governing rule
# outright: "Absence of a log line must never be used as proof of success."
#
# Second half: server/transport/health.ts:90 computes
#
#     status = database.connected && !natsDegraded ? "healthy" : "degraded"
#
# The producer is not an input at all, so a wedged sweep cannot move /health off
# "healthy". That is the "quiet but green" the issue names.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) A tick that overlaps a still-running tick EMITS a warning naming the
#       skip, instead of returning silently.
#   (b) The sweep exposes a liveness reading whose quiet duration comes from an
#       INJECTED clock, and it reads stale once quiet exceeds its threshold.
#   (c) /health goes NON-green (status degraded, HTTP 503) while the producer is
#       quiet beyond threshold, and the body names the producer as the reason.
#   (d) CONTROL — the same machinery with a HEALTHY producer reports fresh and
#       keeps /health green. Without this, code that always reported degraded
#       would pass (a)-(c) while destroying the signal, and a hard-coded
#       "degraded" would bank a free GREEN.
#   (e) CONTROL — the injected clock is real: the driver simulates a quiet
#       period orders of magnitude longer than its own wall-clock runtime. If
#       this clause ever fails, the check has silently become a sleep-based
#       test and inherits the flake class it was written to avoid.
#
# All five run through one TypeScript driver against the REAL composition
# (server/application/index.ts wiring health + maintenance), not a
# re-implementation — an injected-dependency check that rebuilds its subject
# proves the rebuild works (docs/lane-contract.md, #624 harvest).
#
# Content-free output: clause names, states, and counts only.
# No database, no network, no live clone — every dependency is a fake, which is
# what makes this runnable in CI and in a fresh worktree.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

DRIVER="scripts/done-means/625-sweep-heartbeat.driver.ts"

if [[ ! -f "$DRIVER" ]]; then
  echo "FAIL  driver missing: $DRIVER"
  echo "DONE-MEANS #625: FAIL"
  exit 1
fi

echo "INFO  repo:   $REPO_ROOT"
echo "INFO  driver: $DRIVER (injected clock, no wall-clock waits)"
echo

set +e
bun "$DRIVER"
DRIVER_STATUS=$?
set -e

echo
if [[ $DRIVER_STATUS -eq 0 ]]; then
  echo "DONE-MEANS #625: PASS — a quiet sweep is loudly visible and turns /health non-green."
else
  echo "DONE-MEANS #625: FAIL — a quiet sweep is still indistinguishable from a healthy one."
fi
exit $DRIVER_STATUS
