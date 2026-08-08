#!/usr/bin/env bash
# DONE-MEANS check for issue #613 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/613-fixtures-torn-down.sh
#
# Issue #613, verbatim ask:
#   "Fix cleanup in the suites that create `parity-source-registry-*` fixtures
#    so they tear down what they seed. The next global producer added to the
#    codebase will hit the same rows."
#
# ---------------------------------------------------------------------------
# What is measured, and why it is measured THIS way
# ---------------------------------------------------------------------------
# The defect is not "a query returns the wrong answer" — it is RESIDUE. A row
# that outlives the suite that created it. Residue cannot be observed from
# inside the suite, and it cannot be observed in a database other work has
# touched, because a pre-existing `parity-source-registry-%` row would be
# indistinguishable from one this run leaked.
#
# So this check requires a FRESH DATABASE and owns the whole lifecycle:
#   1. createdb + migrate a throwaway database (the same mechanism as
#      scripts/lane-bootstrap.ts --fresh-db: createdb, then `bun run migrate`).
#   2. Assert it starts with ZERO `parity-source-registry-%` rows. Without this
#      the final count proves nothing.
#   3. Run the OWNING suite (contracts/server-tool-parity.test.ts) against it.
#   4. Assert the suite actually exercised the fixture. A suite that silently
#      skips (no OPENBRAIN_TEST_DATABASE_URL → `describe.skip`,
#      contracts/server-tool-parity.test.ts:51) leaves zero rows too, and that
#      zero is a FALSE PASS. Per docs/sme/correctness.md, a gate that can pass
#      without the real path running is not a gate.
#   5. Count `ob_sources` rows matching `parity-source-registry-%`. Must be 0.
#
# The gate calls the REAL suite rather than re-deriving cleanup itself. A check
# that hand-rolls its own copy of the teardown can pass while the product stays
# broken (docs/sme/correctness.md:1921).
#
# EXPECTED TO FAIL on origin/main (leftover rows > 0). It is the reward
# function, not a test of the fix author's diligence.
#
# TEARDOWN: this script drops ONLY the database it created itself, by a name it
# generated, via `dropdb`. It contains no `rm` of any kind and touches no
# worktree, no repo file, and no database it did not create.
#
# The dogfood database and core01 are NOT touched. This check never reads
# OPENBRAIN_TEST_DATABASE_URL from the environment; it sets its own.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}" || exit 1

PG_HOST="${DONE_MEANS_613_PGHOST:-127.0.0.1}"
PG_PORT="${DONE_MEANS_613_PGPORT:-5432}"
PG_USER="${DONE_MEANS_613_PGUSER:-${USER}}"
DB_NAME="done_means_613_$$_$(date +%s)"
DB_URL="postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${DB_NAME}"

FAILURES=0
DB_CREATED=0
fail() { printf 'FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
pass() { printf 'PASS  %s\n' "$*"; }
info() { printf 'INFO  %s\n' "$*"; }

cleanup() {
  if [[ ${DB_CREATED} -eq 1 ]]; then
    if dropdb "${DB_NAME}" >/dev/null 2>&1; then
      info "teardown: dropped ${DB_NAME}"
    else
      printf 'WARN  teardown: dropdb %s failed; drop it by hand\n' "${DB_NAME}"
    fi
  fi
}
trap cleanup EXIT

q() { psql -At "${DB_URL}" -c "$1"; }

printf '=== done-means #613: do parity suites tear down what they seed? ===\n'
printf 'throwaway database: %s\n\n' "${DB_NAME}"

# ---------------------------------------------------------------------------
# (1) Fresh database.
# ---------------------------------------------------------------------------
if ! createdb -h "${PG_HOST}" -p "${PG_PORT}" -U "${PG_USER}" "${DB_NAME}" 2>&1; then
  fail "(1) createdb ${DB_NAME} failed; cannot run the check"
  printf '\n=== RESULT: FAIL (%d) ===\n' "${FAILURES}"
  exit 1
fi
DB_CREATED=1
pass "(1) created ${DB_NAME}"

if MIGRATE_LOG="$(DB_HOST="${PG_HOST}" DB_PORT="${PG_PORT}" DB_NAME="${DB_NAME}" \
  DB_USER="${PG_USER}" bun run migrate 2>&1)"; then
  pass "(1) migrations applied"
else
  fail "(1) migrations failed:"
  printf '%s\n' "${MIGRATE_LOG}" | tail -20
  printf '\n=== RESULT: FAIL (%d) ===\n' "${FAILURES}"
  exit 1
fi

# ---------------------------------------------------------------------------
# (2) Precondition: the fresh database holds no parity source rows.
# ---------------------------------------------------------------------------
BEFORE="$(q "SELECT count(*) FROM ob_sources WHERE namespace LIKE 'parity-source-registry-%';")"
if [[ "${BEFORE}" == "0" ]]; then
  pass "(2) precondition: 0 parity-source-registry-% rows before the run"
else
  fail "(2) precondition broken: ${BEFORE} parity-source-registry-% row(s) already present in a fresh database"
fi

# ---------------------------------------------------------------------------
# (3) Run the owning suite.
# ---------------------------------------------------------------------------
info "(3) running contracts/server-tool-parity.test.ts ..."
SUITE_LOG="$(OPENBRAIN_TEST_DATABASE_URL="${DB_URL}" \
  bun test contracts/server-tool-parity.test.ts 2>&1)"
SUITE_EXIT=$?
printf '%s\n' "${SUITE_LOG}" | tail -12
if [[ ${SUITE_EXIT} -eq 0 ]]; then
  pass "(3) suite exited 0"
else
  fail "(3) suite exited ${SUITE_EXIT} — a failing suite makes the row count unreadable"
fi

# ---------------------------------------------------------------------------
# (4) The suite actually ran the source-registry fixture.
# ---------------------------------------------------------------------------
# Bun's default reporter names a test only when it FAILS, so grepping the log
# for the fixture id cannot confirm a passing run. The count line is the signal
# that survives both outcomes: `describe.skip` reports `0 pass`, a real run
# reports the full fixture matrix.
PASS_COUNT="$(printf '%s' "${SUITE_LOG}" | rg -o '^\s*(\d+) pass' -r '$1' | head -1)"
if [[ "${PASS_COUNT:-0}" -gt 0 ]]; then
  pass "(4) suite really executed (${PASS_COUNT} passing tests, not a silent skip)"
else
  fail "(4) suite reported 0 passing tests — skipped, so the count in step (5) would be meaningless"
fi

# ---------------------------------------------------------------------------
# (5) THE GATE: nothing is left behind.
# ---------------------------------------------------------------------------
AFTER="$(q "SELECT count(*) FROM ob_sources WHERE namespace LIKE 'parity-source-registry-%';")"
if [[ "${AFTER}" == "0" ]]; then
  pass "(5) 0 parity-source-registry-% rows remain in ob_sources"
else
  fail "(5) ${AFTER} parity-source-registry-% row(s) left behind in ob_sources"
  printf '\n--- leftover rows ---\n'
  psql "${DB_URL}" -c "SELECT namespace, source_kind, external_id, approval_state, lifecycle_state
                         FROM ob_sources WHERE namespace LIKE 'parity-source-registry-%';" 2>&1 || true
fi

printf '\n'
if [[ ${FAILURES} -eq 0 ]]; then
  printf '=== RESULT: PASS — parity suites tear down what they seed ===\n'
  exit 0
fi
printf '=== RESULT: FAIL (%d failing clause(s)) ===\n' "${FAILURES}"
exit 1
