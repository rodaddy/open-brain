#!/usr/bin/env bash
# DONE-MEANS check for issue #647 — "a dead or silent raw-capture lane must be
# loudly distinguishable from a healthy one".
#
#   bash scripts/done-means/647-capture-liveness.sh
#
# Issue #647 / ledger item 25 (docs/issue-graph.md), verbatim shape:
#   the capture merge-gate tier is retired — raw capture is automatic (Stop
#   hooks -> watermark -> durable spool) and distillation is the DREAM
#   pipeline's job. The enforcement that REPLACES it is LIVENESS on the
#   automatic lane, following the #625 pattern.
#
# ---------------------------------------------------------------------------
# WHY THIS CHECK IS DETERMINISTIC AND NOT A LIVE-LANE WATCH
# ---------------------------------------------------------------------------
# The tempting check is "watch a real session and assert capture rows appeared
# within N minutes". That is a WALL-CLOCK assertion, and the lane contract's
# Tightenings round 5 (docs/lane-contract.md — "Wall-clock assertions ... are CI
# flake generators", #632/#634) forbids exactly that shape. It is also worse
# than flaky here: a machine with no active session produces the same silence as
# a wedged capture lane, so the check would report RED for the weather.
#
# So the observation moves off the clock and onto EVENT COUNTS with an INJECTED
# clock, exactly as scripts/done-means/625-sweep-heartbeat.sh did for the
# maintenance producer. Time is a variable this driver assigns. The property
# proven is not "capture was slow" — it is "capture was SILENT AND everything
# still reported healthy", which is logic, not timing.
#
# ---------------------------------------------------------------------------
# WHAT IS ACTUALLY MISSING, read from source at origin/main
# ---------------------------------------------------------------------------
# The capture lane's three failure signals all exist, and NOTHING READS ANY OF
# THEM as a liveness question:
#
#   1. WATERMARK — python/openbrain/src/openbrain/apps/capture/watermark.py:196
#      `WatermarkStore` is keyed per session: `offset_for` (:219),
#      `position_for` (:233), `advance` (:245). There is NO enumeration method.
#      Nothing can ask "which sessions are being captured, and has any of them
#      advanced?" — the store answers only about a session you already name.
#
#   2. SPOOL — `spool_pending(path)` (outage.py:270) returns a depth, and it is
#      read only to DECORATE a notice (`spool_notice`, outage.py:243). A rising
#      depth with no notice announced is invisible.
#
#   3. OUTAGE LATCH — `OutageLatch` (outage.py:375). `note_spooled` (:411) and
#      `note_delivered` (:424) return a notice line or None, where None is
#      overloaded three ways (no change / already degraded / cooldown). State
#      reads only via `is_degraded(session_key)` (:440) — again per-session,
#      again with no enumeration.
#
# And on the server: `server/transport/health.ts` contains ZERO occurrences of
# "capture". `SingleWorkerHealthInput` (health.ts:60-79) admits exactly
# `databaseHealth`, embedding, `natsHealth` (:71) and `producerHealth` (:78);
# the status derivation at health.ts:131-134 is
#
#     database.connected && !natsDegraded && !producerDegraded
#
# so a capture lane that stopped delivering entirely cannot move /health off
# "healthy". `ob_raw_turns` (src/tools/ingest-raw-turn.ts:277) records
# ARRIVALS; nothing anywhere reads ABSENCE. A silently-dead capture lane is
# server-side indistinguishable from an idle one.
#
# That is the RED: today nothing makes a silent capture lane loud.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) A capture lane whose watermark does NOT advance while sessions deliver
#       turns reports itself STALE. Counts and an injected clock only — the
#       reading is "N sessions ran, zero bytes of transcript advanced", never
#       "it has been X minutes".
#
#   (b) A spool that ACCUMULATES with NO outage latch announced reports a
#       distinct fault. This is the nastiest real shape: the latch's None is
#       overloaded (outage.py:411/424), so a latch that never fires looks
#       identical to a healthy one, while the spool silently grows. Depth
#       rising + zero announcements = loud.
#
#   (c) ZERO capture events across N recent ACTIVE sessions reports stale.
#       "Active" is the load-bearing word and is a COUNT the caller supplies,
#       not a clock reading: sessions that ran, against turns delivered.
#
#   (d) The liveness reading is composed into /health and takes the worker
#       NON-green (status degraded, HTTP 503), naming capture as the reason —
#       the #625 precedent at server/transport/health.ts:129-134, extended.
#
#   (e) CONTROL — HEALTHY. The same machinery with a live capture lane
#       (watermark advancing, spool drained, turns delivered) reports fresh and
#       keeps /health green. Without this, code that always reported degraded
#       would pass (a)-(d) while destroying the signal, and a hard-coded
#       "degraded" would bank a free GREEN.
#
#   (f) CONTROL — ABSENCE IS NOT STALENESS (docs/lane-contract.md Tightenings
#       round 8, generalized from #625). A process that composes NO capture
#       lane — an opted-out worker, a server that no hook reports to — supplies
#       no reading, gets NO capture block in /health, and stays green. Absent
#       means "not my job"; stale means "my job and I am not doing it". Without
#       this clause the feature degrades every worker that legitimately opted
#       out.
#
#   (g) CONTROL — the injected clock is real: the driver simulates a silence
#       orders of magnitude longer than its own wall-clock runtime. If this
#       clause ever fails, the check has silently become a sleep-based test and
#       inherits the flake class it was written to avoid. (#625 clause (e).)
#
# All clauses run through drivers against the REAL subjects — the shipped
# `getSingleWorkerHealth` (server/transport/health.ts) and the shipped capture
# liveness reader — never a re-implementation. An injected-dependency check that
# rebuilds its subject proves the rebuild works (docs/lane-contract.md, #624
# harvest).
#
# Content-free output: clause names, states, and counts only. No database, no
# network, no live session — every dependency is a fake, which is what makes
# this runnable in CI and in a fresh worktree.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TS_DRIVER="scripts/done-means/647-capture-liveness.driver.ts"
PY_DRIVER="scripts/done-means/647_capture_liveness_driver.py"

FAILED=0

if [[ ! -f "$PY_DRIVER" ]]; then
  echo "FAIL  python driver missing: $PY_DRIVER"
  echo "DONE-MEANS #647: FAIL"
  exit 1
fi

if [[ ! -f "$TS_DRIVER" ]]; then
  echo "FAIL  typescript driver missing: $TS_DRIVER"
  echo "DONE-MEANS #647: FAIL"
  exit 1
fi

echo "INFO  repo:   $REPO_ROOT"
echo "INFO  drivers: $PY_DRIVER (capture-side liveness, injected clock)"
echo "INFO           $TS_DRIVER (health composition, injected reading)"
echo

echo "--- capture-side clauses (a) (b) (c) (e) (f) (g) ---"
set +e
(cd python/openbrain && uv run python "../../$PY_DRIVER")
PY_STATUS=$?
set -e
[[ $PY_STATUS -eq 0 ]] || FAILED=1

echo
echo "--- health-composition clauses (d) (e-health) (f-health) ---"
set +e
bun "$TS_DRIVER"
TS_STATUS=$?
set -e
[[ $TS_STATUS -eq 0 ]] || FAILED=1

echo
if [[ $FAILED -eq 0 ]]; then
  echo "DONE-MEANS #647: PASS — a silent capture lane is loudly stale and turns /health non-green; a healthy lane stays green and an absent one is not reported broken."
else
  echo "DONE-MEANS #647: FAIL — a silent or dead capture lane is still indistinguishable from a healthy one."
fi
exit $FAILED
