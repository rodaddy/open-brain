#!/usr/bin/env bash
# DONE-MEANS check for issue #652 — "compose the merged capture-liveness reader
# into live /health".
#
#   bash scripts/done-means/652-capture-health-composed.sh
#
# ---------------------------------------------------------------------------
# WHAT #648 LEFT UNDONE, and why that is the whole of this issue
# ---------------------------------------------------------------------------
# PR #648 (issue #647) merged the reader and the health-endpoint plumbing:
#
#   - `server/transport/health.ts` accepts `captureHealth` as an input
#     (SingleWorkerHealthInput), publishes a `capture` block, and lets
#     `stale: true` move `status` to "degraded" (health.ts:194-199).
#   - `python/openbrain/src/openbrain/apps/capture/liveness.py` decides
#     staleness from counts alone.
#
# And its OWN report named the gap in its "Known residual risk" field:
#
#     "the reading is WRITTEN, not RUNNING. This PR builds the reader and the
#      health composition; NO PROCESS COMPOSES `captureHealth` YET, so no live
#      /health reports capture today."
#
# That is verifiable, not a matter of opinion. At origin/main:
#
#   $ rg -n 'captureHealth' server/ --glob '!*.test.ts'
#   server/transport/health.ts:138    (the input declaration)
#   server/transport/health.ts:194    (the read)
#
# The ONLY composition root — `createShadowApplication`
# (server/application/index.ts:114), which `server/main.ts:280` calls to build
# the serving app — supplies `producerHealth` (index.ts:159) and supplies
# NOTHING for capture. An optional input that no composition root ever passes
# is dead code with a docstring: the endpoint CAN report capture and never DOES.
#
# So the RED here is not "the reader is wrong". The reader is correct and
# proven by #647's own 13 clauses. The RED is that the composition contains no
# capture input, and therefore a live `/health` from the real application
# composition can never name capture regardless of what the lane is doing.
#
# ---------------------------------------------------------------------------
# WHY THE GATHERER READS ob_raw_turns AND NOT THE WATERMARK/SPOOL
# ---------------------------------------------------------------------------
# #647's residual-risk field also named the reason no gatherer shipped: the
# watermark store and the outage latch are strictly single-key and expose no
# enumeration (`watermark.py:196-245`, `outage.py:375-440`), so a server cannot
# ask them "which sessions exist?". They are also per-hook CLIENT-SIDE files on
# whatever machine ran the session — a server process cannot read them at all.
#
# The server CAN see what those two mechanisms exist to protect: ARRIVALS in
# `ob_raw_turns`. `docs/decisions/capture-never-drops-a-turn.md:193-197`
# publishes the exact per-role SQL as the correct health check, and says to run
# it PER ROLE because #447 hid for six days behind a healthy lane total.
#
# So the gatherer observes the two counts a server genuinely owns —
# `sessions_observed` and per-role `turns_delivered` — and reports the two it
# cannot observe as zero, which the reader treats as "no fault" rather than as
# a fault (`spool_pending > 0` is required for `spool_unannounced`;
# `watermark_bytes_advanced == 0` would otherwise fire, so the gatherer must
# NOT leave that at zero while claiming sessions ran — clause (h) pins exactly
# that, because getting it wrong makes every healthy deployment degrade).
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) The REAL application composition (`createShadowApplication`, the one
#       `server/main.ts` calls) supplies a `captureHealth` input. This is the
#       clause that is RED on main: today the composition has no capture input
#       at all. Proven by driving the composed app, not by grepping source.
#
#   (b) A live `/health` HTTP response from that composed application NAMES
#       capture — the block is published over the wire, from an ephemeral
#       listener, through the real Express route. #647 proved the function;
#       this proves the endpoint.
#
#   (c) A SILENT capture lane observed through the composition takes that live
#       `/health` non-green (status degraded, HTTP 503) and names capture as
#       the reason. The per-role shape survives composition: 365 user turns
#       beside 0 assistant turns is stale, not busy (#447).
#
#   (d) CONTROL — HEALTHY. A delivering capture lane keeps the live `/health`
#       green (HTTP 200) AND still publishes the block. A field that appears
#       only on failure cannot be graphed, and code that always degraded would
#       otherwise pass (a)-(c) while destroying the signal.
#
#   (e) CONTROL — ABSENCE IS NOT STALENESS (docs/lane-contract.md Tightenings
#       round 13, generalized from round 8/#625). A deployment that legitimately
#       runs NO capture lane composes no observer, publishes NO capture block,
#       and stays green (HTTP 200). This is the ordinary case for most of
#       core01's workers, not an edge (AGENTS.md), and it is the clause that
#       stops this feature degrading every opted-out process. It must pass
#       PRE-fix as well as post-fix — a check that fails everywhere proves only
#       that it fails.
#
#   (f) CONTROL — the gatherer's own absence path. An observer that is composed
#       but whose observation is unavailable (no sessions seen at all — a fresh
#       process, a quiet window) returns undefined and stays green, rather than
#       fabricating either a healthy reading or a stale one.
#
#   (g) CONTROL — the clock is INJECTED, not slept. The driver simulates a
#       silence orders of magnitude longer than its own wall-clock runtime. If
#       this fails, the check has become a sleep-based test and inherits the
#       flake class round 5 forbids (#632/#634). No wall-clock assertion decides
#       any verdict here; `silence_seconds` is carried and never compared.
#
#   (h) The reading is LATE-BOUND, not captured at boot. Two successive
#       `/health` requests against ONE composed application must report
#       DIFFERENT capture states when the underlying observation changes. A
#       value read once at composition time is the stale-but-confident answer
#       the whole issue is about (server/application/index.ts:152-158 gives
#       exactly this reasoning for `producerHealth`).
#
# All clauses drive the REAL subjects — `createShadowApplication` and the
# shipped `getSingleWorkerHealth`, over a real ephemeral HTTP listener — never a
# re-implementation. An injected-dependency check that rebuilds its subject
# proves the rebuild works (docs/lane-contract.md, #624 harvest).
#
# No database, no network beyond 127.0.0.1 on a kernel-assigned ephemeral port,
# no live clone. Content-free output: clause names, states, and counts only.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

DRIVER="scripts/done-means/652-capture-health-composed.driver.ts"

if [[ ! -f "$DRIVER" ]]; then
  echo "FAIL  driver missing: $DRIVER"
  echo "DONE-MEANS #652: FAIL"
  exit 1
fi

echo "INFO  repo:   $REPO_ROOT"
echo "INFO  driver: $DRIVER (injected clock, ephemeral listener, no DB)"
echo

set +e
bun "$DRIVER"
DRIVER_STATUS=$?
set -e

echo
if [[ $DRIVER_STATUS -eq 0 ]]; then
  echo "DONE-MEANS #652: PASS — the serving composition reports capture state on live /health."
else
  echo "DONE-MEANS #652: FAIL — /health still cannot report capture state from the real composition."
fi
exit $DRIVER_STATUS
