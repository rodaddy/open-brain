#!/usr/bin/env bash
# DONE-MEANS check for issue #666 — "the E2E scenario transport spawns the
# provider WITH OPENBRAIN_DELEGATE_NAMESPACE=1, so the per-run eval namespace it
# always derives can actually be bound".
#
#   bash scripts/done-means/666-transport-delegates-namespace.sh
#
# ---------------------------------------------------------------------------
# THE DEFECT
# ---------------------------------------------------------------------------
# eval/open-brain/live/scenario-transport.ts:109-119 spawns
# `uv run openbrain-memory` with four env keys — OPENBRAIN_BASE_URL, _TOKEN,
# _NAMESPACE, _PROJECT — and no delegation flag, while ALWAYS deriving a
# per-run `eval-live-recall-*` namespace (config.ts `runNamespaces`) that the
# token does not already grant.
#
# Since PR #657 the provider's namespace delegation is opt-in and default OFF,
# so `session_start` binds the token's own namespace instead and refuses the
# configured one. #662 then made that refusal name its own remedy. Both are
# working as designed; the transport is the thing that never asked.
#
# Verifiable at origin/main:
#
#   $ rg -n 'DELEGATE' eval/open-brain/live/scenario-transport.ts
#   (no matches)
#
# Operator ruling, ledger item 30.1 (docs/issue-graph.md): the TRANSPORT owns
# the delegation request, because the component that derives foreign namespaces
# is the one that always needs the header, and intent belongs in code with its
# reason. REJECTED: putting the flag in live-eval.env (buries intent in
# machine-local operator config, and every future credential assembly has to
# remember it); rejected: both places (redundant).
#
# ---------------------------------------------------------------------------
# COVERAGE SPLIT — STUB VS LIVE. READ BEFORE CITING THIS GREEN AS PROOF.
# ---------------------------------------------------------------------------
# This check is a UNIT-LEVEL proof that the transport ASKS for delegation. It
# proves nothing about the composed end-to-end capture, by construction:
#
#   * WHAT IT COVERS — the real `LiveScenarioTransport.executeProvider` runs
#     unmodified and the env it hands to the process boundary is read at the
#     actual `Bun.spawn` call site (the boundary is stubbed with the repo's
#     existing convention from src/tools/__tests__/search-all.test.ts:85).
#
#   * WHAT IT DOES NOT COVER — the provider process, the X-Namespace header it
#     derives from the flag, the server's role gate on that header, and the
#     durable row that should land in the derived namespace. All are past the
#     stubbed boundary.
#
#   * WHY #655's GREEN NEVER COVERED THIS — that driver
#     (scripts/done-means/655-eval-teardown.driver.ts:116) supplies its own
#     ScenarioTransport whose executeProvider writes direct SQL, so the real
#     spawn is never reached in it. Its passing state was never evidence about
#     this env and could not have caught this defect. That is the trap named in
#     the SME KB as injected_destination_bypasses_broken_composition.
#
#   * WHERE THE COMPOSED PROOF LIVES — the #578 gate's CREDENTIALED run, which
#     the controller re-verifies after this merges and PR #653 syncs main
#     again. This lane holds no credentials and harvests none, so it cannot and
#     does not attempt that leg.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) The spawn env carries OPENBRAIN_DELEGATE_NAMESPACE="1". RED on
#       origin/main: the key is absent entirely.
#   (b) CONTROL — the four keys the transport already passed still carry their
#       configured values, and an ambient process-env key still passes through.
#       Passes PRE-fix by design (round 13: a check failing everywhere proves
#       only that it fails). Fails any "fix" that rebuilds the env instead of
#       adding one key to it.
#   (c) MUTATION — clause (a) re-run against the observed env with the
#       delegation key stripped must FAIL. A single-key presence assertion is
#       exactly the shape that passes for the wrong reason, so it gets a mutant.
#
# No database, no network, no credentials, no child process. Content-free
# output: clause names, states, and env KEY names.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

DRIVER="scripts/done-means/666-transport-delegates-namespace.driver.ts"

if [[ ! -f "$DRIVER" ]]; then
  echo "FAIL  driver missing: $DRIVER"
  echo "DONE-MEANS #666: FAIL"
  exit 1
fi

echo "INFO  repo:   $REPO_ROOT"
echo "INFO  driver: $DRIVER (real executeProvider, stubbed Bun.spawn; no DB, no network, no credentials)"
echo "INFO  scope:  unit-level delegation REQUEST only — the composed live proof is the #578 gate's credentialed run"
echo

set +e
bun "$DRIVER"
DRIVER_STATUS=$?
set -e

echo
if [[ $DRIVER_STATUS -eq 0 ]]; then
  echo "DONE-MEANS #666: PASS — the scenario transport spawns the provider with OPENBRAIN_DELEGATE_NAMESPACE=1 and its other env keys unchanged."
else
  echo "DONE-MEANS #666: FAIL — the scenario transport still spawns the provider without requesting namespace delegation, or it disturbed the existing env keys."
fi
exit $DRIVER_STATUS
