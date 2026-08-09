#!/usr/bin/env bash
# DONE-MEANS check for issue #681 — "the liveness observer is blind to the
# `tool` role; seed EXPECTED_ROLES from the ingest enum".
#
#   bash scripts/done-means/681-tool-role-liveness.sh
#
# ---------------------------------------------------------------------------
# THE GAP THIS CLOSES (cutover blocker B3, docs/core01-cutover-preflight.md)
# ---------------------------------------------------------------------------
# `server/capture/liveness-observer.ts` seeded two roles while the server
# accepts three. A dead role produces no `GROUP BY` group, so it is never a key
# in `turnsByRole` and can never be named silent. Confirmed live this session:
# `tool` frozen at 14,006 rows since 2026-08-01 while `/health` read
# `stale: false, silent_roles: []`.
#
# The observer IS the cutover's evidence that capture works (#647/#648/#652/
# #656). Reporting green over a dead role for eight days is the exact failure
# its own docstring cites as its reason to exist (#447), one role wider.
#
# ---------------------------------------------------------------------------
# WHAT THIS CHECK REFUSES TO ACCEPT
# ---------------------------------------------------------------------------
# Adding "tool" to the literal. That satisfies the behaviour and rebuilds the
# identical trap for role four — which is how role three got here. Clause (d)
# requires the seed to DERIVE from one exported role set and proves it by
# comparing the seeded keys to that set's own members, so an extra or missing
# role fails either way.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) The issue's done-means verbatim: dead `tool` beside live user/assistant
#       -> stale=true, silent_roles=["tool"]. RED on the pre-change tree.
#   (b) The reason NAMES the role — an unactionable verdict is the dead-end
#       error class (round 15).
#   (c) The role is SEEDED (a key at zero), not special-cased in the judge.
#   (d) DERIVATION, the load-bearing clause: the seed and the exported ingest
#       role set are the SAME set. A hardcoded triple fails.
#   (e) No fourth copy: the remaining role-set copies in the tree (legacy
#       ingest schema, the column CHECK) still agree with the derived set.
#   (f) CONTROL — three delivering roles stay green. PASSES pre-fix by design.
#   (g) CONTROL — absence is not staleness: an empty window still publishes no
#       verdict, not three silent roles (rounds 8 and 13).
#   (h) The #447 shape unregressed: a dead ASSISTANT still fires.
#
# No database, no network, no wall-clock verdict (round 5, #632/#634).
# Content-free output: clause names, states, counts.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

DRIVER="scripts/done-means/681-tool-role-liveness.driver.ts"

if [[ ! -f "$DRIVER" ]]; then
  echo "FAIL  driver missing: $DRIVER"
  echo "DONE-MEANS #681: FAIL"
  exit 1
fi

echo "INFO  repo:   $REPO_ROOT"
echo "INFO  driver: $DRIVER (shipped gatherer, fake pool, no DB, no network)"
echo

# The driver's exit code is read DIRECTLY, never through a pipe: `tee` and
# friends mask it, and a masked non-zero reads as a pass (round 19/21).
set +e
bun "$DRIVER"
DRIVER_STATUS=$?
set -e

echo
if [[ $DRIVER_STATUS -eq 0 ]]; then
  echo "DONE-MEANS #681: PASS — a dead tool role is reported stale, and the expected-role seed derives from the ingest role set rather than a literal beside it."
else
  echo "DONE-MEANS #681: FAIL — the observer is still blind to a role the server accepts, or its seed is retyped rather than derived."
fi
exit $DRIVER_STATUS
