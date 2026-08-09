#!/usr/bin/env bash
# DONE-MEANS check for issue #656 — "wire the capture-liveness observer into
# server/main.ts from REQUIRED config, loud on absence".
#
#   bash scripts/done-means/656-capture-observer-wired.sh
#
# ---------------------------------------------------------------------------
# THE GAP THIS CLOSES
# ---------------------------------------------------------------------------
# PR #652 merged the gatherer (server/capture/liveness-observer.ts) and the
# composition port (server/application/index.ts:109, read per-request at :204),
# and its own report named what remained: "server/main.ts wiring awaits an
# operator config ruling — namespace, window, refresh cadence". Verifiable at
# origin/main:
#
#   $ rg -n 'captureObserver' server/main.ts
#   (no matches)
#
# So the serving process publishes no capture block no matter how correct the
# port is. A port no composition root fills is a docstring.
#
# ---------------------------------------------------------------------------
# THE RULING THIS IMPLEMENTS (ledger item 28, docs/issue-graph.md)
# ---------------------------------------------------------------------------
#   - namespace: REQUIRED config, NO fallback. Unset/empty -> the observer is
#     NOT constructed AND a loud config notice is emitted. Never a silent
#     assumption of any tenant. The operator's generalization: identity-selecting
#     config is explicit per deployment, loud on absence, never substituted.
#   - window 6h, refresh 60s, both env-overridable; an APPLIED default is
#     announced (AGENTS.md "Nothing is adjusted silently").
#   - "absence is not staleness" survives intact: no namespace -> no observer ->
#     no capture block -> /health stays GREEN. Loud in the LOG, quiet in the
#     health verdict. Two audiences; conflating them makes an opted-out worker
#     degrade itself (docs/lane-contract.md rounds 8 and 13).
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) namespace SET -> the runtime the composition root calls builds a
#       captureObserver. RED on main: the factory does not exist at all.
#   (b) That observer's reading reaches a live HTTP /health through the REAL
#       createShadowApplication composition, and a silent lane (365 user turns
#       beside 0 assistant — the #447 shape) takes it to 503/degraded naming
#       the assistant role.
#   (c) namespace UNSET and namespace EMPTY -> NO observer built, a loud
#       (>= warn) structured notice naming OPENBRAIN_CAPTURE_HEALTH_NAMESPACE,
#       AND /health stays 200/healthy with no capture block. Both halves in one
#       clause: silence-on-absence alone is the status quo, and a health
#       verdict on absence would violate "absence is not staleness".
#   (d) CONTROL — HEALTHY. A delivering lane keeps /health green AND still
#       publishes the block. Fails any always-degrade implementation, and any
#       gatherer that reports an unobservable watermark as a literal zero.
#   (e) LATE-BINDING (round 14 — the only clause that caught a boot-captured
#       reading): two requests against ONE composed app with the observation
#       changed between them must report different states.
#   (f) CONTROL — absence is not staleness at the composition level. Composes
#       no observer, stays green, publishes nothing. PASSES PRE-FIX by design:
#       a check that fails everywhere proves only that it fails.
#   (g) The applied defaults are ANNOUNCED — a structured line carrying
#       window_minutes=360 and refresh_interval_ms=60000.
#   (m) The COMPOSITION ROOT calls it. server/main.ts references
#       createCaptureHealthRuntime and hands a captureObserver to the
#       application. A source assertion by necessity — driving startServer
#       needs a live Postgres, migrations and a NATS boundary — and paired
#       with the behavioural clauses, never a substitute for them.
#   (t) No wall-clock verdict (round 5, #632/#634).
#
# The logger is a REAL pino instance writing to a captured stream, and the
# notices are proven by parsing the emitted JSON — not by asserting a spy was
# called. Injected-dependency tests can 100%-cover a module whose production
# composition is broken (#624 harvest).
#
# No database, no network beyond a kernel-assigned ephemeral port on 127.0.0.1.
# Content-free output: clause names, states, counts.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

DRIVER="scripts/done-means/656-capture-observer-wired.driver.ts"

if [[ ! -f "$DRIVER" ]]; then
  echo "FAIL  driver missing: $DRIVER"
  echo "DONE-MEANS #656: FAIL"
  exit 1
fi

echo "INFO  repo:   $REPO_ROOT"
echo "INFO  driver: $DRIVER (real pino capture, ephemeral listener, no DB)"
echo

set +e
bun "$DRIVER"
DRIVER_STATUS=$?
set -e

echo
if [[ $DRIVER_STATUS -eq 0 ]]; then
  echo "DONE-MEANS #656: PASS — the serving composition builds the capture observer from required config, and is loud when that config is absent."
else
  echo "DONE-MEANS #656: FAIL — the serving process still composes no capture observer, or absence is silent."
fi
exit $DRIVER_STATUS
