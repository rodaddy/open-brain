#!/usr/bin/env bash
# DONE-MEANS check for issue #904 step 1 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/904-isolated-runner-supplies-clone-and-admin.sh
#
# #904 (under #878): two Postgres suites gate themselves on env vars that
# `bun run test:isolated` never set, so both skipped every local run. A suite
# that skips reports `0 fail` and exits 0, which at the exit code is
# indistinguishable from a suite that ran and passed — the false green. The ask
# is that the runner SUPPLY what those suites ask for.
#
# ACCEPTANCE, as this script enforces it — two checks:
#
#   C1. `bun run test:isolated scripts/test-support/print-env.test.ts` passes.
#       That test asserts, inside the child process, that both
#       OPENBRAIN_SCRATCH_ADMIN_URL and OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL
#       are set, and that the clone URL's username is `open_brain_local_clone`
#       and its database name starts with `open_brain_local_` — the same three
#       properties scripts/local-clone.test.ts itself demands. Asserting only
#       "non-empty" would let a wrong URL pass here and throw there.
#
#   C2. `bun run test:isolated scripts/local-clone.test.ts` shows the
#       `local clone real PostgreSQL boundary (live Postgres)` suite actually
#       RAN: pass count > 0 and skip count 0. This is the check that cannot be
#       satisfied by the exit code alone, which is the entire point of #878.
#
# RED at origin/main: C1 fails (both vars unset in the child), and C2 reports
# 19 pass / 1 skip — the boundary suite skipped. GREEN after the fix: C1 passes
# 2/2 and C2 reports 20 pass / 0 skip. Measured 2026-08-27.
#
# ---------------------------------------------------------------------------
# Isolation and teardown
# ---------------------------------------------------------------------------
# This script creates NOTHING in the database. `test:isolated` owns every
# database created here and drops both of them itself; if it ever fails to, it
# prints the orphan's name and a dropdb line, and this script surfaces that
# text rather than dropping anything — a checker that repairs what it measures
# cannot measure it.
#
# Its own transcripts live under {temp_workspace}/open-brain/_scratch and are
# retired on exit. Output is content-free: counts and verdicts only.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ENV_TEST="scripts/test-support/print-env.test.ts"
CLONE_TEST="scripts/local-clone.test.ts"
CLONE_SUITE="local clone real PostgreSQL boundary"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
command -v rg >/dev/null 2>&1 || fail_hard "rg not on PATH"
[ -f "$REPO_ROOT/$CLONE_TEST" ] || fail_hard "missing $CLONE_TEST"

RUN_ID="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
SCRATCH="${TEMP_WORKSPACE:-/Volumes/ThunderBolt/_tmp}/open-brain/_scratch"
mkdir -p "$SCRATCH" 2>/dev/null || fail_hard "cannot create scratch dir $SCRATCH"
OUT_C1="$SCRATCH/done-means-904-c1-${RUN_ID}.log"
OUT_C2="$SCRATCH/done-means-904-c2-${RUN_ID}.log"

teardown() {
  mv -f "$OUT_C1" "$OUT_C1.done" 2>/dev/null
  mv -f "$OUT_C2" "$OUT_C2.done" 2>/dev/null
}
trap teardown EXIT

OVERALL=PASS
RESULTS=""
ORPHANS=""

record_fail() {
  OVERALL=FAIL
  RESULTS="${RESULTS}$1"$'\n'
}
record_pass() {
  RESULTS="${RESULTS}$1"$'\n'
}

# Surface any orphan the runner reported, without acting on it.
collect_orphans() {
  local log="$1"
  if rg -qi 'ORPHANED DATABASE' "$log" 2>/dev/null; then
    ORPHANS="${ORPHANS}$(rg -N -i -A4 'ORPHANED DATABASE' "$log" 2>/dev/null)"$'\n'
  fi
}

# bun prints a trailing "N pass" / "N skip" tally. Absent means zero.
tally() {
  local log="$1" word="$2" n
  n="$(rg -o -N "^\s*(\d+) ${word}\b" -r '$1' "$log" 2>/dev/null | tail -1 | tr -d '[:space:]')"
  [ -n "$n" ] || n=0
  printf '%s' "$n"
}

# ---------------------------------------------------------------------------
# C1 — the runner exports both vars, in a shape the clone suite accepts.
# ---------------------------------------------------------------------------
if [ ! -f "$REPO_ROOT/$ENV_TEST" ]; then
  record_fail "C1 env-contract: FAIL — $ENV_TEST does not exist, so nothing asserts what the runner exports"
else
  (cd "$REPO_ROOT" && bun run test:isolated "$ENV_TEST") >"$OUT_C1" 2>&1
  C1_EXIT=$?
  collect_orphans "$OUT_C1"
  C1_PASS="$(tally "$OUT_C1" pass)"
  C1_FAIL="$(tally "$OUT_C1" fail)"

  if [ "$C1_PASS" -lt 2 ] || [ "$C1_FAIL" -ne 0 ] || [ "$C1_EXIT" -ne 0 ]; then
    record_fail "C1 env-contract: FAIL — ${C1_PASS} pass / ${C1_FAIL} fail, exit ${C1_EXIT}: the runner did not export both OPENBRAIN_SCRATCH_ADMIN_URL and a well-formed OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL into the child"
  else
    record_pass "C1 env-contract: PASS — ${C1_PASS} assertions passed in the child: both vars set, clone URL names open_brain_local_clone on an open_brain_local_ database"
  fi
fi

# ---------------------------------------------------------------------------
# C2 — the live-Postgres clone suite RAN, rather than skipping to a green exit.
# ---------------------------------------------------------------------------
(cd "$REPO_ROOT" && bun run test:isolated "$CLONE_TEST") >"$OUT_C2" 2>&1
C2_EXIT=$?
collect_orphans "$OUT_C2"
C2_PASS="$(tally "$OUT_C2" pass)"
C2_FAIL="$(tally "$OUT_C2" fail)"
C2_SKIP="$(tally "$OUT_C2" skip)"

# The suite name appearing in a skip line is the direct signal; the skip tally
# is the backstop, since bun does not always name a skipped describe block.
if rg -q "»\s*skip.*${CLONE_SUITE}" "$OUT_C2" 2>/dev/null; then
  SUITE_SKIPPED=yes
else
  SUITE_SKIPPED=no
fi

if [ "$C2_EXIT" -ne 0 ] || [ "$C2_FAIL" -ne 0 ]; then
  record_fail "C2 clone-suite-ran: FAIL — ${C2_PASS} pass / ${C2_FAIL} fail / ${C2_SKIP} skip, exit ${C2_EXIT}"
elif [ "$SUITE_SKIPPED" = yes ] || [ "$C2_SKIP" -ne 0 ]; then
  record_fail "C2 clone-suite-ran: FAIL — ${C2_SKIP} test(s) skipped in ${CLONE_TEST}: the \"${CLONE_SUITE}\" suite did not run, so its green is the false green #878 names"
elif [ "$C2_PASS" -lt 1 ]; then
  record_fail "C2 clone-suite-ran: FAIL — ${CLONE_TEST} reported ${C2_PASS} passing tests"
else
  record_pass "C2 clone-suite-ran: PASS — ${C2_PASS} pass / 0 skip: the \"${CLONE_SUITE}\" suite executed against a real clone database"
fi

printf '\n=== DONE-MEANS #904: the isolated runner supplies the clone database and an admin URL ===\n\n'
printf '%s' "$RESULTS"
if [ -n "$ORPHANS" ]; then
  printf '\nORPHANS REPORTED BY THE RUNNER — this checker drops nothing it did not create:\n\n%s\n' "$ORPHANS"
fi
printf '\ntranscripts: %s.done  %s.done\n' "$OUT_C1" "$OUT_C2"
printf '\nVERDICT: %s\n\n' "$OVERALL"

[ "$OVERALL" = PASS ] || exit 1
exit 0
