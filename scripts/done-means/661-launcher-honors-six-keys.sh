#!/usr/bin/env bash
# DONE-MEANS check for issue #661 — "the local-clone launcher HONORS the five
# ruled configuration keys it announces as dropped, and stops announcing the
# sixth, which was never a configuration at all".
#
#   bash scripts/done-means/661-launcher-honors-six-keys.sh
#
# ---------------------------------------------------------------------------
# THE GAP THIS CLOSES
# ---------------------------------------------------------------------------
# #659 (PR #660) made the launcher's env drops VISIBLE. The first boot after
# that change named six more configured keys the allowlist had been discarding
# in silence for their whole life — observed RUNNING on the deployed clone
# 2026-08-08 22:45Z. Ledger item 29.2 ruled that all six be honored.
#
# Writing this check RED-first proved one of the six could not be. The launcher
# THREW on it, at a guard, before the allowlist was ever consulted:
#
#   FAIL (b) Local clone mode prohibits EMBEDDING_WATCHDOG_RESTART_SCRIPT
#
# src/local-clone-mode.ts:15 lists that key in PROHIBITED_PATH_KEYS; lines
# 190-194 refuse any non-empty value; src/local-clone-mode.test.ts:138-145 pins
# it. The deployed env file sets it EMPTY (local-clone.env:17), which
# docs/local-clone-dogfood.md:147 documents as the suppression form — the same
# shape as QMD_PATH=. It reached the boot line only because the drop reporter
# skipped on `undefined` and not on the empty string, so an explicitly-DISABLED
# key was reported as a dropped CONFIGURATION, and a human filed an issue asking
# for a prohibited key to be honored.
#
# Amended operator ruling 2026-08-08 (29.2a): honor the FIVE keys carrying real
# values, keep the watchdog key out because the clone-mode prohibition guard
# wins, and teach the reporter to tell unset / set-empty / set-valued apart.
#
#   HONORED:      LOG_LEVEL, LOG_MAX_BYTES, LOG_MAX_FILES,
#                 OPENBRAIN_MCP_AUDIT_ENABLED, SERVICE_NAME
#   NOT honored:  EMBEDDING_WATCHDOG_RESTART_SCRIPT
#
# Verifiable at the pre-fix tree:
#
#   $ rg -n 'LOG_LEVEL|SERVICE_NAME|MCP_AUDIT' scripts/local-clone.ts
#   (no matches)
#
# Announcing a drop is the correct mechanism and is NOT the resolution: an
# announced-and-ignored deliberate setting is accept-and-ignore with a receipt.
# Announcing a deliberate SUPPRESSION is the mirror defect — a false positive
# that teaches an operator the line is noise.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) Each of the five honored keys, set in the input env, appears in
#       buildChildEnvironment output with its configured value, and the
#       empty-suppressed watchdog key does NOT. Asserted per key, never as a
#       tally — a partial fix is an ignored operator decision. RED pre-fix.
#   (b) With the five honored and the watchdog key empty-suppressed, the
#       launcher's boot announcement for this env file goes SILENT. Both halves
#       in ONE clause: zero announce lines AND the five keys present in the
#       SPAWNED CHILD's env. Split apart, "quiet" passes on the pre-#659
#       launcher that announced nothing and delivered nothing. Driven through
#       the real runLocalCloneLauncher start path via its injected boundaries —
#       the launcher spawn chain is the seam #659 lived in, and a unit-level
#       check had it outside its vantage. RED pre-fix.
#   (c) CONTROL, mutation-proofed both ways — a junk unlisted key must still NOT
#       reach the child AND must still be announced, with no value echoed and no
#       ambient host var named. The junk keys carry the LOG_ and SERVICE_
#       prefixes on purpose: the lazy way to honor LOG_LEVEL is a whole-family
#       passthrough, and that fails the first half. Deleting the drop report to
#       silence the boot line — which would make (b) pass for the wrong reason —
#       fails the second. Passes PRE-fix by design.
#   (d) CONTROL — DB_*, AUTH_TOKEN_*, AUTH_TOKEN_USER_*, OPENBRAIN_TRACING_* and
#       the #659 OPENBRAIN_CAPTURE_HEALTH_* keys still reach the child. Passes
#       PRE-fix by design (round 13: a check that fails everywhere proves only
#       that it fails).
#   (e) The three-state rule, with its own mutation proof: an explicitly-EMPTY
#       key is NOT announced (a suppression), while the SAME KEY carrying a real
#       value IS (a drop). Both halves over one key name differing only in value
#       state — flip "" to a string and the expected answer inverts. Neither
#       half alone constrains anything. RED pre-fix.
#
# No database, no network, no real child process — the subjects are a pure
# function over a record plus the launcher's already-injectable boundaries.
# Content-free output: clause names, states, key names.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

DRIVER="scripts/done-means/661-launcher-honors-six-keys.driver.ts"

if [[ ! -f "$DRIVER" ]]; then
  echo "FAIL  driver missing: $DRIVER"
  echo "DONE-MEANS #661: FAIL"
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
  echo "DONE-MEANS #661: PASS — the five operator-ruled keys reach the server child, the empty-suppressed watchdog key is neither delivered nor announced, the fully-honored env file boots quiet, and the allowlist plus its drop report both still hold."
else
  echo "DONE-MEANS #661: FAIL — the launcher still drops operator-ruled configuration keys, or the fix abolished the allowlist or its drop report."
fi
exit $DRIVER_STATUS
