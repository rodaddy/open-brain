#!/usr/bin/env bash
# DONE-MEANS check for issue #680 — "a spool quarantine is never a SILENT drop".
#
#   bash scripts/done-means/680-quarantine-loud.sh
#
# ---------------------------------------------------------------------------
# THE GAP THIS CLOSES (cutover blocker B2, docs/core01-cutover-preflight.md)
# ---------------------------------------------------------------------------
# The spool is presented as the durability backstop, but after
# DEFAULT_QUARANTINE_THRESHOLD=5 consecutive replay failures a unit moves to a
# `<spool>.quarantine.jsonl` sidecar and is abandoned. On 2026-07-30 that took
# 15 real turns and ~44 lifecycle events, and every operator surface stayed
# green:
#
#   - `outage.spool_pending` counts object lines in the LIVE spool only, so the
#     drop makes the counter go DOWN (`outage.py:270-299`).
#   - `liveness-observer.ts:264-265` hardcodes `spoolPending: 0`, and
#     `TransportCaptureHealth` has no quarantine field, so /health read
#     `spool_pending:0, reason:"capture lane delivering"`.
#   - `SpoolStatus.quarantined_count` (`spool.py:101`) exists and is computed on
#     every `status()` call — with ZERO consumers outside the spool module.
#
# The mechanism was DESIGNED loud: `docs/memory-limits.md:25` promises a
# `QUARANTINED` receipt in the triggering drain report and lists
# `quarantined_count` under queue observability. It was BUILT silent at the two
# surfaces an operator actually watches. This check is about what a READER sees
# after a drop, never about whether the sidecar file was written.
#
# ---------------------------------------------------------------------------
# THE DONE-MEANS, as the pre-flight doc states it (ordered item 2)
# ---------------------------------------------------------------------------
#   "forced 5 failures -> still pending OR fault raised, never a silent
#    sidecar; quarantined_count surfaced in /health and the observer."
#
# The client half FORCES FIVE REAL FAILURES through the shipped `JsonlSpool`
# and then asks what a reader sees. It does not hand-write a sidecar: a
# hand-built fixture would prove the fixture.
#
# ---------------------------------------------------------------------------
# CLAUSES — client half (680_quarantine_loud_driver.py)
# ---------------------------------------------------------------------------
#   (setup) 5 forced failures really quarantined the unit and emptied the live
#           spool. Asserted, not assumed: every later clause reasons about it.
#   (a)     THE DEFECT. After the drop the capture lane's pending count must
#           not read 0 — that is the exact live symptom.
#   (b)     LOUD AND SPECIFIC. The count rose AND the operator notice names
#           quarantine. Both halves in ONE clause (round 17): an outage backlog
#           drains itself, a quarantined unit never will, so a line that cannot
#           distinguish them is a line the operator learns to ignore.
#   (c)     CONTROL — an ordinary held turn stays quiet and says nothing about
#           quarantine. Fails any "always shout" implementation.
#   (d)     UNREADABLE IS NOT ZERO — a sidecar that cannot be read reports None,
#           inheriting `spool_pending`'s existing contract. Guessing 0 would
#           recreate this defect one directory over.
#   (e)     ABSENT IS GENUINELY ZERO — the other side of (d); a machine that has
#           never quarantined anything must not print an unknown-count forever.
#   (f)     THE RECORDS SURVIVE — the sidecar still holds the envelope with its
#           consecutive_failures, so the operator's replay-vs-accept decision
#           (issue #680 item 4) has something to act on.
#
# ---------------------------------------------------------------------------
# CLAUSES — server half (680-quarantine-loud.driver.ts)
# ---------------------------------------------------------------------------
#   (a)     The judge (`readCaptureLiveness`) makes a reported quarantine STALE
#           and names it in the reason.
#   (b)     The COUNT is published, not folded into a boolean.
#   (c)     CONTROL — a delivering lane with nothing quarantined stays GREEN and
#           publishes a real 0 (a monitor must see the 0 -> 1 crossing).
#   (d)     UNOBSERVED IS NOT ZERO — a vantage point given no quarantine input
#           publishes the field as ABSENT, never a confident 0. A hardcoded 0
#           standing in for an unmeasured quantity is the defect's own shape.
#   (e)     It reaches a LIVE /health over real HTTP through the real
#           `createShadowApplication` composition, 503 + the count.
#   (f)     CONTROL — absence-is-not-staleness survives: no observer composed
#           means no block and 200/green. PASSES PRE-FIX by design.
#
# Content-free output: clause names, states, counts. No payloads, no secrets.
# No database. No network beyond an ephemeral 127.0.0.1 port. No wall-clock
# verdict (round 5, #632/#634). Never contacts core01.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

PY_DRIVER="scripts/done-means/680_quarantine_loud_driver.py"
TS_DRIVER="scripts/done-means/680-quarantine-loud.driver.ts"

for driver in "$PY_DRIVER" "$TS_DRIVER"; do
  if [[ ! -f "$driver" ]]; then
    echo "FAIL  driver missing: $driver"
    echo "DONE-MEANS #680: FAIL"
    exit 1
  fi
done

echo "INFO  repo:   $REPO_ROOT"
echo "INFO  client: $PY_DRIVER (real JsonlSpool, 5 forced failures, temp dir)"
echo "INFO  server: $TS_DRIVER (real readCaptureLiveness + live /health, no DB)"
echo

# Run from the `openbrain` package env, NOT `openbrain-memory`: the driver
# imports BOTH the spool (openbrain_memory) and the capture lane's reader
# (openbrain.apps.capture.outage), and only the openbrain env carries the
# pydantic/loguru dependencies the latter's package __init__ pulls in. Running
# from openbrain-memory dies at `import openbrain` with ModuleNotFoundError —
# a crash upstream of every clause, which is a FALSE RED, not a result
# (docs/lane-contract.md round 18).
echo "--- CLIENT HALF -----------------------------------------------------"
set +e
(cd python/openbrain && uv run python "$REPO_ROOT/$PY_DRIVER")
CLIENT_STATUS=$?
set -e

echo
echo "--- SERVER HALF -----------------------------------------------------"
set +e
bun "$TS_DRIVER"
SERVER_STATUS=$?
set -e

echo
echo "INFO  client half exit=$CLIENT_STATUS  server half exit=$SERVER_STATUS"

if [[ $CLIENT_STATUS -eq 0 && $SERVER_STATUS -eq 0 ]]; then
  echo "DONE-MEANS #680: PASS — five forced delivery failures leave a LOUD, counted fault at the capture lane and in /health; never a silent sidecar."
  exit 0
fi

echo "DONE-MEANS #680: FAIL — a quarantine drop is still invisible to at least one operator surface."
exit 1
