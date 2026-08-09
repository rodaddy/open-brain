#!/usr/bin/env bash
# DONE-MEANS check for issue #659 — "the local-clone launcher's child-env
# allowlist carries the capture-health keys, and announces every configured key
# it drops".
#
#   bash scripts/done-means/659-launcher-env-passthrough.sh
#
# ---------------------------------------------------------------------------
# THE GAP THIS CLOSES
# ---------------------------------------------------------------------------
# PR #656 merged the capture-health observer wiring, ledger item 28 supplied the
# config ruling, and OPENBRAIN_CAPTURE_HEALTH_NAMESPACE was set in the deployed
# clone's env file. The clone was redeployed with a PASSING revision proof — and
# live /health published no capture block. The launcher process had the
# variable; the server child it spawned did not.
#
# Verifiable at origin/main:
#
#   $ rg -n 'CAPTURE_HEALTH' scripts/local-clone.ts
#   (no matches)
#
# `buildChildEnvironment()` passes an allowlist (CHILD_ENV_KEYS) plus two prefix
# families (AUTH_TOKEN_USER_*, OPENBRAIN_TRACING_*). OPENBRAIN_CAPTURE_HEALTH_*
# is in neither, so the launcher drops it. This is the THIRD instance of the
# deploy-coupling class the code documents at its own #530 tracing comment
# ("must reach the server child or createTracingRuntime silently stays off").
#
# ---------------------------------------------------------------------------
# TWO DEFECTS, NOT ONE
# ---------------------------------------------------------------------------
#   1. The three OPENBRAIN_CAPTURE_HEALTH_* keys do not reach the server child.
#   2. The allowlist drops CONFIGURED keys with no signal, so every future
#      server config key re-buys this bug. That violates "Nothing is adjusted
#      silently" (AGENTS.md coding standard, operator ruling 2026-08-08) and is
#      the class already in the SME KB as #464, "An allowlist that drops
#      unrecognized keys is accept-and-ignore, not tolerance" — whose first
#      review question is exactly "does the drop path name what it dropped?"
#
# Fixing only (1) closes this issue and leaves the mechanism that produced it.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) The three capture-health keys reach the child with their configured
#       values. Key names come from the observer's exported constants, so a
#       rename breaks the clause instead of silently passing. RED on main.
#   (b) A configured-but-unlisted key is NAMED in the launcher's drop report.
#       RED on main: the drop is entirely silent. Paired with (b:no-values),
#       which proves the report names keys WITHOUT echoing values — an unlisted
#       AUTH_TOKEN_* spelling would otherwise put a credential in the log.
#   (c) CONTROL — DB_*, AUTH_TOKEN_*, AUTH_TOKEN_USER_*, OPENBRAIN_TRACING_*
#       still pass. Passes PRE-fix by design (round 13: a check that fails
#       everywhere proves only that it fails).
#   (d) CONTROL — the allowlist stays an allowlist. A deliberately-unlisted junk
#       key (carrying the OPENBRAIN_ prefix, so a lazy whole-family passthrough
#       fails too) and the ambient PATH/HOME/SSH_AUTH_SOCK must NOT reach the
#       child. Fails any "fix" that passes the whole environment.
#   (e) MUTATION PROOF for the negative-match scope rule. (b) passes on a filter
#       that announces everything; (d) does not constrain the report at all. So
#       (e) asserts scope from BOTH sides in one clause: ambient host vars are
#       NOT announced AND the configured key IS. A filter announcing nothing
#       fails one half, one announcing everything fails the other.
#   (f) CHAIN — the announcement reaches the launcher's OWN OUTPUT, proven by
#       driving the real runLocalCloneLauncher start path through its injected
#       boundaries. #656's done-means drove createShadowApplication directly and
#       had this whole launcher seam outside its vantage, which is why #659
#       survived a passing check AND a passing revision proof.
#
# No database, no network, no real child process — the subjects are pure
# functions over a record plus the launcher's already-injectable boundaries.
# Content-free output: clause names, states, key names.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

DRIVER="scripts/done-means/659-launcher-env-passthrough.driver.ts"

if [[ ! -f "$DRIVER" ]]; then
  echo "FAIL  driver missing: $DRIVER"
  echo "DONE-MEANS #659: FAIL"
  exit 1
fi

echo "INFO  repo:   $REPO_ROOT"
echo "INFO  driver: $DRIVER (pure env projection + injected launcher boundaries; no DB, no network)"
echo

set +e
bun "$DRIVER"
DRIVER_STATUS=$?
set -e

echo
if [[ $DRIVER_STATUS -eq 0 ]]; then
  echo "DONE-MEANS #659: PASS — the capture-health keys reach the server child, and configured keys the allowlist drops are announced by name."
else
  echo "DONE-MEANS #659: FAIL — the launcher still drops configured server config keys, or drops them silently."
fi
exit $DRIVER_STATUS
