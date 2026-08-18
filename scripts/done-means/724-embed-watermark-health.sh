#!/usr/bin/env bash
# DONE-MEANS check for issue #724, item 3 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/724-embed-watermark-health.sh
#
# #724 item 3: the maintenance producer ticked for three days with no consumer
# draining the embed queue, and every liveness surface stayed green because
# nothing COMPARED raw arrivals against embedded rows. The acceptance surface is
# an `embed_watermark` block on the NATS worker's /health (3110) whose `stale`
# verdict flips the endpoint to degraded/503.
#
# The executable acceptance for that surface is a bun test file:
#
#   scripts/run-nats-worker-embed-watermark.test.ts
#
# This wrapper exists because `scripts/verify-lane.ts` runs every Done-means
# check with `bash` (verify-lane.ts:473, filed as #733), so a Done-means that is
# a bun test file cannot be named directly in a PR body. This script is the
# bash-shaped front door to that test file and adds nothing to its semantics.
#
# ACCEPTANCE, as this script enforces it:
#
#   1. The test FILE exists. A run that examines zero files is a HARNESS ERROR,
#      never a pass — the same silent-skip trap AGENTS.md names for
#      OPENBRAIN_TEST_DATABASE_URL, one level up.
#   2. `bun run test:isolated <that file>` exits 0, having actually executed
#      tests (>0 reported passing). The isolated runner is the trustworthy
#      path per AGENTS.md; a shared-dogfood `bun test` count is not evidence.
#
# EXIT GRAMMAR (repo convention):
#
#   0  the thing under test is present and green
#   1  the thing under test FAILED (tests red, or ran nothing)
#   3  HARNESS ERROR — bun missing, the test file missing, or the isolated
#      database bootstrap could not run. A broken harness is not a red result
#      and must not be reported as one.
#
# ---------------------------------------------------------------------------
# Isolation and teardown
# ---------------------------------------------------------------------------
# This script creates NOTHING in the database. `bun run test:isolated` owns the
# database it creates and drops it on the way out, including on interrupt. What
# this script owns is one transcript file under {temp_workspace}/open-brain/
# _scratch, retired (moved, never deleted) on exit.
#
# Output is content-free: counts, exit codes, and verdicts only.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TEST_FILE="scripts/run-nats-worker-embed-watermark.test.ts"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  printf '\nVERDICT: HARNESS-ERROR\n\n'
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"

# 0-files-examined is not a pass. If the acceptance file is absent from THIS
# tree, the check has nothing to measure and says so loudly.
[ -f "$REPO_ROOT/$TEST_FILE" ] ||
  fail_hard "acceptance file $TEST_FILE does not exist in $REPO_ROOT — zero files examined is not a pass"

rg -q '"test:isolated"' "$REPO_ROOT/package.json" 2>/dev/null ||
  fail_hard "no \`test:isolated\` entry point in package.json; the isolated-database runner is the only trustworthy path (AGENTS.md)"

# .env carries the libpq/DB_* vars the isolated runner needs to create its
# database. A worktree or lane clone may lack it; fall back to the canonical
# checkout's copy so this runs from either (same fallback as 614).
ENV_FILE="$REPO_ROOT/.env"
[ -r "$ENV_FILE" ] || ENV_FILE="/Volumes/ThunderBolt/Development/open-brain/.env"
[ -r "$ENV_FILE" ] || fail_hard "no readable .env for Postgres credentials; the isolated runner cannot create a database"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

RUN_ID="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
SCRATCH="${TEMP_WORKSPACE:-/Volumes/ThunderBolt/_tmp}/open-brain/_scratch"
mkdir -p "$SCRATCH" 2>/dev/null || fail_hard "cannot create scratch dir $SCRATCH"
OUT="$SCRATCH/done-means-724-${RUN_ID}.log"

teardown() {
  mv -f "$OUT" "$OUT.done" 2>/dev/null
}
trap teardown EXIT

(cd "$REPO_ROOT" && bun run test:isolated "$TEST_FILE") >"$OUT" 2>&1
RUN_EXIT=$?

PASS_COUNT="$(rg -o -N '^\s*(\d+) pass' -r '$1' "$OUT" 2>/dev/null | tail -1 | tr -d '[:space:]')"
[ -n "$PASS_COUNT" ] || PASS_COUNT=0
FAIL_COUNT="$(rg -o -N '^\s*(\d+) fail' -r '$1' "$OUT" 2>/dev/null | tail -1 | tr -d '[:space:]')"
[ -n "$FAIL_COUNT" ] || FAIL_COUNT=0
ISO_DB="$(rg -o -N '\bob_isolated_[a-z0-9_]+' "$OUT" 2>/dev/null | head -1)"

printf '\n=== DONE-MEANS #724 item 3: embed watermark liveness on worker /health ===\n\n'
printf 'acceptance file: %s\n' "$TEST_FILE"
printf 'runner:          bun run test:isolated %s\n' "$TEST_FILE"
printf 'isolated db:     %s\n' "${ISO_DB:-<none printed>}"
printf 'tally:           %s pass, %s fail (runner exit %s)\n\n' "$PASS_COUNT" "$FAIL_COUNT" "$RUN_EXIT"

# A runner that never named a database, and never reported a tally, did not get
# far enough to have tested anything: that is a harness problem, not a red test.
if [ -z "$ISO_DB" ] && [ "$PASS_COUNT" -eq 0 ] && [ "$FAIL_COUNT" -eq 0 ]; then
  printf 'transcript: %s.done\n' "$OUT.done"
  tail -20 "$OUT" >&2
  fail_hard "the isolated runner printed no database name and no test tally (exit ${RUN_EXIT}); the database bootstrap or bun itself did not run — a broken harness is not a failing test"
fi

VERDICT=PASS
if [ "$RUN_EXIT" -ne 0 ]; then
  VERDICT=FAIL
  printf 'FAIL — the runner exited %s with %s failing test(s)\n' "$RUN_EXIT" "$FAIL_COUNT"
elif [ "$PASS_COUNT" -lt 1 ]; then
  VERDICT=FAIL
  printf 'FAIL — exit 0 but 0 tests passed: the file was silently skipped, so nothing was proven\n'
else
  printf 'PASS — %s tests executed against %s, 0 failures, exit 0\n' "$PASS_COUNT" "${ISO_DB:-an isolated database}"
fi

printf '\ntranscript: %s.done\n' "$OUT.done"
printf '\nVERDICT: %s\n\n' "$VERDICT"

[ "$VERDICT" = PASS ] || exit 1
exit 0
