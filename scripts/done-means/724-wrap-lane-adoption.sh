#!/usr/bin/env bash
# DONE-MEANS check for issue #724 — the wrap-lane adoption acceptance gate.
#
#   bash scripts/done-means/724-wrap-lane-adoption.sh
#
# The executable acceptance for wrap-lane adoption in the Python runtime is a
# pytest file:
#
#   python/openbrain-memory/tests/test_runtime_wrap_lane_adoption.py
#
# This wrapper exists because `scripts/verify-lane.ts` runs every Done-means
# check with `bash` (verify-lane.ts:473, filed as #733), so a Done-means that is
# a pytest file cannot be named directly in a PR body. This script is the
# bash-shaped front door to that test file and adds nothing to its semantics.
#
# ACCEPTANCE, as this script enforces it:
#
#   1. The test FILE exists. A run that examines zero files is a HARNESS ERROR,
#      never a pass — the same silent-skip trap AGENTS.md names for
#      OPENBRAIN_TEST_DATABASE_URL, one level up.
#   2. `uv run pytest <that file> -q` exits 0, having actually executed tests
#      (>0 reported passing). Exit 0 with a 0-test collection is NOT a pass.
#
# EXIT GRAMMAR (repo convention):
#
#   0  the thing under test is present and green
#   1  the thing under test FAILED (tests red, or ran nothing)
#   3  HARNESS ERROR — `uv` missing, dependencies unavailable, or the test file
#      absent. A broken harness is not a red result and must not be reported as
#      one.
#
# ---------------------------------------------------------------------------
# Isolation and teardown
# ---------------------------------------------------------------------------
# This script creates NOTHING in the database; the test file is transport-fake
# based. What it owns is one transcript file under {temp_workspace}/open-brain/
# _scratch, retired (moved, never deleted) on exit.
#
# Output is content-free: counts, exit codes, and verdicts only.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PKG_DIR="python/openbrain-memory"
TEST_FILE="tests/test_runtime_wrap_lane_adoption.py"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  printf '\nVERDICT: HARNESS-ERROR\n\n'
  exit 3
}

command -v uv >/dev/null 2>&1 || fail_hard "uv not on PATH"

[ -d "$REPO_ROOT/$PKG_DIR" ] ||
  fail_hard "python package dir $PKG_DIR does not exist in $REPO_ROOT"

# 0-files-examined is not a pass. If the acceptance file is absent from THIS
# tree, the check has nothing to measure and says so loudly.
[ -f "$REPO_ROOT/$PKG_DIR/$TEST_FILE" ] ||
  fail_hard "acceptance file $PKG_DIR/$TEST_FILE does not exist in $REPO_ROOT — zero files examined is not a pass"

RUN_ID="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
SCRATCH="${TEMP_WORKSPACE:-/Volumes/ThunderBolt/_tmp}/open-brain/_scratch"
mkdir -p "$SCRATCH" 2>/dev/null || fail_hard "cannot create scratch dir $SCRATCH"
OUT="$SCRATCH/done-means-724-wrap-${RUN_ID}.log"

teardown() {
  mv -f "$OUT" "$OUT.done" 2>/dev/null
}
trap teardown EXIT

(cd "$REPO_ROOT/$PKG_DIR" && uv run pytest "$TEST_FILE" -q) >"$OUT" 2>&1
RUN_EXIT=$?

PASS_COUNT="$(rg -o -N '(\d+) passed' -r '$1' "$OUT" 2>/dev/null | tail -1 | tr -d '[:space:]')"
[ -n "$PASS_COUNT" ] || PASS_COUNT=0
FAIL_COUNT="$(rg -o -N '(\d+) failed' -r '$1' "$OUT" 2>/dev/null | tail -1 | tr -d '[:space:]')"
[ -n "$FAIL_COUNT" ] || FAIL_COUNT=0
ERR_COUNT="$(rg -o -N '(\d+) error' -r '$1' "$OUT" 2>/dev/null | tail -1 | tr -d '[:space:]')"
[ -n "$ERR_COUNT" ] || ERR_COUNT=0

printf '\n=== DONE-MEANS #724: wrap-lane adoption in the Python runtime ===\n\n'
printf 'acceptance file: %s/%s\n' "$PKG_DIR" "$TEST_FILE"
printf 'runner:          uv run pytest %s -q\n' "$TEST_FILE"
printf 'tally:           %s passed, %s failed, %s error(s) (runner exit %s)\n\n' \
  "$PASS_COUNT" "$FAIL_COUNT" "$ERR_COUNT" "$RUN_EXIT"

# uv exit 2 is a usage/collection error; pytest 3 is internal error, 4 usage,
# 5 no-tests-collected. None of those are a failing test — they are a harness
# that never got far enough to measure anything.
if [ "$RUN_EXIT" -ge 2 ] && [ "$FAIL_COUNT" -eq 0 ]; then
  tail -20 "$OUT" >&2
  printf 'transcript: %s.done\n' "$OUT.done"
  fail_hard "the runner exited ${RUN_EXIT} with no failing test reported — uv/pytest could not resolve dependencies or collect the file; a broken harness is not a failing test"
fi

VERDICT=PASS
if [ "$RUN_EXIT" -ne 0 ]; then
  VERDICT=FAIL
  printf 'FAIL — the runner exited %s with %s failing test(s)\n' "$RUN_EXIT" "$FAIL_COUNT"
elif [ "$PASS_COUNT" -lt 1 ]; then
  VERDICT=FAIL
  printf 'FAIL — exit 0 but 0 tests passed: the file was silently skipped, so nothing was proven\n'
else
  printf 'PASS — %s tests executed, 0 failures, exit 0\n' "$PASS_COUNT"
fi

printf '\ntranscript: %s.done\n' "$OUT.done"
printf '\nVERDICT: %s\n\n' "$VERDICT"

[ "$VERDICT" = PASS ] || exit 1
exit 0
