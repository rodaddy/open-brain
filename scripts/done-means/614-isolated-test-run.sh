#!/usr/bin/env bash
# DONE-MEANS check for issue #614 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/614-isolated-test-run.sh
#
# #614: a full `bun test` run against the shared dogfood database produces
# unstable failure counts on UNMODIFIED code (49 -> 43 -> 40, 2026-08-06), so a
# red run is not evidence a change is broken and a green one is not proof it is
# safe. Fresh-database runs of the same tree were clean (3701/0). The ask is to
# make the trustworthy path the DEFAULT: a single entry point that runs the
# suite against an isolated database.
#
# ACCEPTANCE, as this script enforces it — four checks:
#
#   1. The entry point exists, and a scoped run executes against a database
#      whose name it PRINTED, and that name is NOT the dogfood database
#      (open_brain_local_20260724). "Executed" is proven by the bun test output
#      showing the pg test actually RAN — >0 tests passed in a file that
#      `describe.skip`s itself when OPENBRAIN_TEST_DATABASE_URL is unset. This
#      check exists because the silent-skip trap (AGENTS.md, Commands) makes
#      "0 fail" indistinguishable from "nothing ran".
#   2. After the run exits, that database no longer exists. It created it, so it
#      removes it.
#   3. After a simulated interrupt (SIGINT to the runner mid-run), the database
#      is ALSO gone, OR the tool printed the orphan's name together with a drop
#      command. A silent leak fails; a loud orphan is acceptable because the
#      operator can act on it.
#   4. AGENTS.md names the entry point, so the trustworthy path is discoverable
#      without reading source.
#
# EXPECTED TO FAIL until #614 is fixed (check 1 fails on a missing entry point).
# It is the reward function, not a test of the fix's author.
#
# ---------------------------------------------------------------------------
# Isolation and teardown
# ---------------------------------------------------------------------------
# This script creates NOTHING in the database itself — the entry point under
# test owns every database created here. What this script owns is its transcript
# files under {temp_workspace}/open-brain/_scratch, retired on exit.
#
# If check 2 or 3 finds a database still standing, the script REPORTS the name
# and the drop command rather than dropping it: cleanup belongs to the tool that
# created it, and a checker that silently repairs the thing it is measuring
# cannot measure it. Any such name is printed in the verdict block.
#
# Output is content-free: database names, counts, and verdicts only.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DOGFOOD_DB="open_brain_local_20260724"
# One fast, genuinely DB-backed file. It skips itself without
# OPENBRAIN_TEST_DATABASE_URL, which is exactly the property check 1 needs.
SCOPE_TEST="src/maintenance-queue.pg.test.ts"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
command -v psql >/dev/null 2>&1 || fail_hard "psql not on PATH"

# .env carries the libpq vars, so bare psql needs no connection arguments (see
# AGENTS.md "Querying the dogfood database"). A worktree may lack .env; fall
# back to the canonical checkout's copy so this runs from either.
ENV_FILE="$REPO_ROOT/.env"
[ -r "$ENV_FILE" ] || ENV_FILE="$HOME/Development/open-brain/.env"
[ -r "$ENV_FILE" ] || fail_hard "no readable .env for Postgres credentials"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

psql -At -d postgres -c 'select 1' >/dev/null 2>&1 ||
  fail_hard "cannot reach the Postgres cluster; existence proofs are impossible, so a PASS could not be trusted"

RUN_ID="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
SCRATCH="${TEMP_WORKSPACE:-$HOME/.cache/open-brain}/open-brain/_scratch"
mkdir -p "$SCRATCH" 2>/dev/null || fail_hard "cannot create scratch dir $SCRATCH"
OUT_CLEAN="$SCRATCH/done-means-614-clean-${RUN_ID}.log"
OUT_INT="$SCRATCH/done-means-614-interrupt-${RUN_ID}.log"

teardown() {
  mv -f "$OUT_CLEAN" "$OUT_CLEAN.done" 2>/dev/null
  mv -f "$OUT_INT" "$OUT_INT.done" 2>/dev/null
}
trap teardown EXIT

# db_exists <name> -> prints "1" when the database is present
db_exists() {
  psql -At -d postgres -c \
    "select 1 from pg_database where datname = '$1';" 2>/dev/null |
    tr -d '[:space:]'
}

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

# ---------------------------------------------------------------------------
# Check 1 — entry point exists, runs the scoped pg test against a printed,
#           non-dogfood database, and that test actually EXECUTED.
# ---------------------------------------------------------------------------
ENTRY_PRESENT=no
if bun run --silent 2>&1 | rg -q '^\s*test:isolated\b' ||
  rg -q '"test:isolated"' "$REPO_ROOT/package.json" 2>/dev/null; then
  ENTRY_PRESENT=yes
fi

CLEAN_DB=""
if [ "$ENTRY_PRESENT" != yes ]; then
  record_fail "1 entry-point: FAIL — no \`test:isolated\` entry point in package.json; there is no single command that runs the suite against an isolated database"
else
  (cd "$REPO_ROOT" && bun run test:isolated "$SCOPE_TEST") >"$OUT_CLEAN" 2>&1
  CLEAN_EXIT=$?

  # The database name must come from the tool's own output — a name this script
  # guessed would prove nothing about what the run actually used.
  CLEAN_DB="$(rg -o -N '\bob_isolated_[a-z0-9_]+' "$OUT_CLEAN" 2>/dev/null | head -1)"

  # Did the pg test really run? bun prints a per-file pass tally; a silently
  # skipped file yields 0 pass and would otherwise read as a clean run.
  PASS_COUNT="$(rg -o -N '^\s*(\d+) pass' -r '$1' "$OUT_CLEAN" 2>/dev/null | tail -1 | tr -d '[:space:]')"
  [ -n "$PASS_COUNT" ] || PASS_COUNT=0

  if [ -z "$CLEAN_DB" ]; then
    record_fail "1 entry-point: FAIL — the run printed no isolated database name (exit ${CLEAN_EXIT}); a run whose database is unnamed cannot be shown to have avoided the dogfood DB"
  elif [ "$CLEAN_DB" = "$DOGFOOD_DB" ]; then
    record_fail "1 entry-point: FAIL — the run used the dogfood database ${DOGFOOD_DB}"
  elif [ "$PASS_COUNT" -lt 1 ]; then
    record_fail "1 entry-point: FAIL — db=${CLEAN_DB} but the pg test reported ${PASS_COUNT} passing tests: it was silently SKIPPED, so OPENBRAIN_TEST_DATABASE_URL never reached it"
  elif [ "$CLEAN_EXIT" -ne 0 ]; then
    record_fail "1 entry-point: FAIL — db=${CLEAN_DB}, ${PASS_COUNT} tests ran, but the runner exited ${CLEAN_EXIT}"
  else
    record_pass "1 entry-point: PASS — ${SCOPE_TEST} ran ${PASS_COUNT} tests against ${CLEAN_DB} (not ${DOGFOOD_DB}), exit 0"
  fi
fi

# ---------------------------------------------------------------------------
# Check 2 — the database it created is gone after a clean exit.
# ---------------------------------------------------------------------------
if [ -z "$CLEAN_DB" ]; then
  record_fail "2 clean-teardown: FAIL — no database name from check 1 to verify"
elif [ "$(db_exists "$CLEAN_DB")" = "1" ]; then
  record_fail "2 clean-teardown: FAIL — ${CLEAN_DB} still exists after a clean exit (leaked)"
  ORPHANS="${ORPHANS}    dropdb --if-exists ${CLEAN_DB}"$'\n'
else
  record_pass "2 clean-teardown: PASS — ${CLEAN_DB} no longer exists"
fi

# ---------------------------------------------------------------------------
# Check 3 — an interrupt mid-run does not leak silently.
# ---------------------------------------------------------------------------
if [ "$ENTRY_PRESENT" != yes ]; then
  record_fail "3 interrupt: FAIL — no entry point to interrupt"
else
  (cd "$REPO_ROOT" && exec bun run test:isolated "$SCOPE_TEST") >"$OUT_INT" 2>&1 &
  RUN_PID=$!

  # Wait for the tool to name its database, then interrupt — interrupting
  # before the name is printed would test process startup, not teardown.
  INT_DB=""
  for _ in $(seq 1 240); do
    INT_DB="$(rg -o -N '\bob_isolated_[a-z0-9_]+' "$OUT_INT" 2>/dev/null | head -1)"
    [ -n "$INT_DB" ] && break
    kill -0 "$RUN_PID" 2>/dev/null || break
    sleep 0.5
  done

  if [ -z "$INT_DB" ]; then
    kill -0 "$RUN_PID" 2>/dev/null && kill -INT "$RUN_PID" 2>/dev/null
    wait "$RUN_PID" 2>/dev/null
    record_fail "3 interrupt: FAIL — the run never printed a database name, so an interrupt leak cannot be distinguished from no database at all"
  else
    # Signal the whole process group: the runner spawns bun test as a child, and
    # signalling only the parent would leave the child holding connections.
    sleep 1
    kill -INT -"$RUN_PID" 2>/dev/null || kill -INT "$RUN_PID" 2>/dev/null
    wait "$RUN_PID" 2>/dev/null
    sleep 2

    STILL_THERE="$(db_exists "$INT_DB")"
    # A loud orphan is acceptable: the operator can act on a printed name plus
    # a drop command. A silent one is the failure.
    if rg -q "$INT_DB" "$OUT_INT" 2>/dev/null && rg -qi 'dropdb' "$OUT_INT" 2>/dev/null; then
      LOUD=yes
    else
      LOUD=no
    fi

    if [ "$STILL_THERE" != "1" ]; then
      record_pass "3 interrupt: PASS — ${INT_DB} was dropped despite the interrupt"
    elif [ "$LOUD" = yes ]; then
      record_pass "3 interrupt: PASS (loud orphan) — ${INT_DB} survives, but the tool printed its name and a dropdb command"
      ORPHANS="${ORPHANS}    dropdb --if-exists ${INT_DB}"$'\n'
    else
      record_fail "3 interrupt: FAIL — ${INT_DB} survives the interrupt and the tool said nothing: a silent leak"
      ORPHANS="${ORPHANS}    dropdb --if-exists ${INT_DB}"$'\n'
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Check 4 — AGENTS.md names the entry point.
# ---------------------------------------------------------------------------
if rg -q 'test:isolated' "$REPO_ROOT/AGENTS.md" 2>/dev/null; then
  record_pass "4 documented: PASS — AGENTS.md names \`test:isolated\`"
else
  record_fail "4 documented: FAIL — AGENTS.md does not name the entry point, so the trustworthy path is not discoverable"
fi

printf '\n=== DONE-MEANS #614: isolated database is the default test path ===\n\n'
printf '%s' "$RESULTS"
if [ -n "$ORPHANS" ]; then
  printf '\nDATABASES STILL STANDING — this checker does not drop what it did not create:\n\n%s' "$ORPHANS"
fi
printf '\ntranscripts: %s.done  %s.done\n' "$OUT_CLEAN" "$OUT_INT"
printf '\nVERDICT: %s\n\n' "$OVERALL"

[ "$OVERALL" = PASS ] || exit 1
exit 0
