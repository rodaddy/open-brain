#!/usr/bin/env bash
# DONE-MEANS check for issue #655 — "E2E scenario runner leaks one namespace per
# run (eval-live-recall-scenario-*) — teardown missing".
#
#   bash scripts/done-means/655-eval-teardown.sh
#
# ---------------------------------------------------------------------------
# WHAT THE EXISTING DESIGN SAYS, AND WHAT THE DELTA IS
# ---------------------------------------------------------------------------
# The repo already has a teardown design and it is a good one:
# `teardownRecords` (eval/open-brain/live/gate.ts:76) removes seeded records ONE
# AT A TIME by exact id, tallying attempted/archived/already_absent/failed, and
# `LiveScenarioTransport.cleanupRecord` (eval/open-brain/live/scenario-transport.ts:184)
# states the rule in its own words: rows are removed "by exact id plus namespace
# ... never by a broad namespace/query sweep." That rule is not being replaced.
#
# The delta is that record teardown, executed perfectly, still cannot remove a
# NAMESPACE — and both of the reasons were measured, not reasoned:
#
#   1. SOFT-DELETE IS NOT REMOVAL. `archive_entry` sets `archived_at` and leaves
#      the row (src/tools/archive-entry.ts:54). A namespace in this schema has no
#      registry row — there is no namespaces table, so a namespace exists exactly
#      as long as some row carries it. 21 `eval-live-recall-*` namespaces in the
#      dogfood database hold nothing but archived rows: teardown reported
#      success and the namespace is still there, permanently.
#
#   2. A THROWN ARCHIVE LEAVES THE ROW FULLY LIVE. Receipt
#      `_scratch/578-e2e-gate/e2e578-20260808172426-.../scenario-receipt.json`
#      reads `attempted=1 archived=0 already_absent=0 failed=1`, and the matching
#      dogfood row has `archived_at IS NULL`. Six `eval-live-recall-scenario-*`
#      namespaces are in exactly that state.
#
# So the fix ADDS a namespace purge AFTER `teardownRecords`, rather than
# replacing it. The narrow authority for a purge is `docs/issue-graph.md` ledger
# item 20; the prefix guard is what earns it, which is why clause (b) is the
# load-bearing clause below rather than an afterthought.
#
# ---------------------------------------------------------------------------
# WHY THE CLAUSES ARE SHAPED THIS WAY
# ---------------------------------------------------------------------------
# Residue cannot be observed from inside the run that produced it, and it cannot
# be observed in a database other work has touched — a pre-existing
# `eval-live-recall-%` row is indistinguishable from one this run leaked. So
# clause (a) owns a FRESH DATABASE end to end and asserts the zero-row
# precondition BEFORE it asserts anything else (the #613 standard).
#
# Clause (b) is load-bearing. Ledger item 20's second condition is that the
# process be prefix-guarded so it "structurally cannot name anything it did not
# create". A guard that has never been fired against a name it must refuse is an
# unproven claim, and this repo has already paid for treating an unexercised
# control as a control (docs/lane-contract.md Tightenings round 13). Clause (b)
# therefore points the purge at names it MUST refuse — including the bare prefix
# and a name that merely CONTAINS it, the two cases a naive `includes()` guard
# waves through — and requires both a refusal AND proof the refused call touched
# zero rows. A guard that throws after deleting is not a guard. It also requires
# the guard to still ALLOW a genuine per-run namespace: a guard that refuses
# everything proves only that it refuses.
#
# Clause (c) is the control that stops the fix from becoming a worse bug. The
# obvious wrong implementation purges at the START of teardown, before the
# scenario assertions have read their records back — which eats the evidence and
# would make a broken run look clean by rendering its own seed unfindable.
# Clause (c) requires the run to report that verification read its seeded record
# while it still existed, and that real scenario verdicts were produced.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) LEAK — a scenario run leaves ZERO rows in any eval-prefixed namespace it
#       created. RED before the fix: the seeded row survives.
#   (b) GUARD, MUTATION-PROVEN — the purge REFUSES every non-eval-prefixed name,
#       deletes nothing when it refuses, and still allows a real eval namespace.
#   (c) CONTROL — teardown does not eat the evidence.
#
# ---------------------------------------------------------------------------
# WHAT THIS SCRIPT TOUCHES, AND WHAT IT REFUSES TO
# ---------------------------------------------------------------------------
# It creates ONE throwaway database, by a name it generates itself, and drops
# that same database on the way out via `dropdb` — ledger item 20's own worked
# example. It contains no `rm` of any kind. It never reads
# OPENBRAIN_TEST_DATABASE_URL from the environment; it sets its own. The dogfood
# database and core01 are NOT touched, and this check will not purge anything in
# them: the pre-existing leaked rows there are operator-gated (#655 says so
# explicitly) and their cleanup SQL is printed in the PR body for the operator to
# run, never executed here.
#
# Output is content-free — clause names, counts, and statuses only.
#
# ---------------------------------------------------------------------------
# EXPECTED TO FAIL BEFORE THE FIX
# ---------------------------------------------------------------------------
# On `origin/main` there is no purge at all: clause (a) finds the seeded row
# still present and clause (b) cannot even load the guard module. RED transcript
# is in the PR body.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}" || exit 1

PG_HOST="${DONE_MEANS_655_PGHOST:-127.0.0.1}"
PG_PORT="${DONE_MEANS_655_PGPORT:-5432}"
PG_USER="${DONE_MEANS_655_PGUSER:-${USER}}"
DB_NAME="done_means_655_$$_$(date +%s)"
DB_URL="postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${DB_NAME}"

DRIVER="scripts/done-means/655-eval-teardown.driver.ts"

FAILURES=0
DB_CREATED=0
fail() { printf 'FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
pass() { printf 'PASS  %s\n' "$*"; }
info() { printf 'INFO  %s\n' "$*"; }

cleanup() {
  if [[ ${DB_CREATED} -eq 1 ]]; then
    if dropdb -h "${PG_HOST}" -p "${PG_PORT}" -U "${PG_USER}" "${DB_NAME}" >/dev/null 2>&1; then
      info "teardown: dropped ${DB_NAME}"
    else
      printf 'WARN  teardown: dropdb %s failed; drop it by hand:\n' "${DB_NAME}"
      printf 'WARN    dropdb -h %s -p %s -U %s %s\n' "${PG_HOST}" "${PG_PORT}" "${PG_USER}" "${DB_NAME}"
    fi
  fi
}
trap cleanup EXIT

q() { psql -At "${DB_URL}" -c "$1"; }

printf '=== done-means #655: does the scenario runner remove the namespace it created? ===\n'
printf 'throwaway database: %s\n\n' "${DB_NAME}"

if [[ ! -f "${DRIVER}" ]]; then
  fail "missing required component: ${DRIVER}"
  printf '\n=== RESULT: FAIL (%d) ===\n' "${FAILURES}"
  exit 1
fi

# ---------------------------------------------------------------------------
# Fresh database. Same mechanism as scripts/lane-bootstrap.ts --fresh-db.
# ---------------------------------------------------------------------------
if ! createdb -h "${PG_HOST}" -p "${PG_PORT}" -U "${PG_USER}" "${DB_NAME}" 2>&1; then
  fail "createdb ${DB_NAME} failed; cannot run the check"
  printf '\n=== RESULT: FAIL (%d) ===\n' "${FAILURES}"
  exit 1
fi
DB_CREATED=1
pass "created ${DB_NAME}"

if MIGRATE_LOG="$(DB_HOST="${PG_HOST}" DB_PORT="${PG_PORT}" DB_NAME="${DB_NAME}" \
  DB_USER="${PG_USER}" bun run migrate 2>&1)"; then
  pass "migrations applied"
else
  fail "migrations failed:"
  printf '%s\n' "${MIGRATE_LOG}" | tail -20
  printf '\n=== RESULT: FAIL (%d) ===\n' "${FAILURES}"
  exit 1
fi

# ---------------------------------------------------------------------------
# Precondition: the fresh database holds no eval-prefixed rows. Without this the
# count in clause (a) proves nothing.
# ---------------------------------------------------------------------------
BEFORE="$(q "SELECT (SELECT count(*) FROM thoughts WHERE namespace LIKE 'eval-live-recall-%')
              + (SELECT count(*) FROM decisions WHERE namespace LIKE 'eval-live-recall-%')
              + (SELECT count(*) FROM ob_session_lanes WHERE namespace LIKE 'eval-live-recall-%');")"
if [[ "${BEFORE}" == "0" ]]; then
  pass "precondition: 0 eval-live-recall-% rows before the run"
else
  fail "precondition broken: ${BEFORE} eval-live-recall-% row(s) already present in a FRESH database"
fi

# ---------------------------------------------------------------------------
# (a)+(b)+(c) One driver run. It calls runScenarioGate itself rather than
# re-deriving teardown: a check that hand-rolls its own copy of the cleanup can
# pass while the product stays broken (docs/sme/correctness.md).
# ---------------------------------------------------------------------------
printf '\n--- driving the real gate against the fresh database ---\n'
# Scratch goes to the repo's temp-workspace bucket, never the repo root (which
# would leave an untracked file behind — the same class of residue this check
# exists to catch) and never `/tmp`/`$TMPDIR`/`mktemp -d`, which are
# sandbox-local so a runner, a Codex sandbox, and the host each see a different
# one (_DOCS/STANDARDS-core.md). The receipt is what an operator most wants
# AFTER a failure, so it is left in place; the run tag keeps runs distinct.
SCRATCH_DIR="${OPENBRAIN_TEMP_WORKSPACE:-/Volumes/ThunderBolt/_tmp}/open-brain/_scratch/655-eval-teardown"
mkdir -p "${SCRATCH_DIR}"
DRIVER_OUT="${SCRATCH_DIR}/driver-${DB_NAME}.json"
info "receipt: ${DRIVER_OUT}"
set +e
DRIVER_LOG="$(DONE_MEANS_655_DB_URL="${DB_URL}" DONE_MEANS_655_OUT="${DRIVER_OUT}" \
  bun "${DRIVER}" 2>&1)"
DRIVER_EXIT=$?
set -e
printf '%s\n' "${DRIVER_LOG}" | tail -30

if [[ ${DRIVER_EXIT} -ne 0 ]]; then
  fail "driver exited ${DRIVER_EXIT} — clause results below may be unreadable"
fi

read_driver() {
  if [[ ! -f "${DRIVER_OUT}" ]]; then printf 'missing'; return 1; fi
  bun -e "const r=await Bun.file(process.argv[2]).json();console.log(String(r[process.argv[3]]))" \
    x "${DRIVER_OUT}" "$1" 2>/dev/null
}

printf '\n--- (c) control: the run examined something, and teardown did not eat it ---\n'
SCENARIO_COUNT="$(read_driver scenario_count)"
if [[ "${SCENARIO_COUNT:-0}" -gt 0 ]]; then
  pass "(c) the run really executed ${SCENARIO_COUNT} scenario(s) — not a silent empty run"
else
  fail "(c) the run reported 0 scenarios; a suite that examined nothing makes every count below meaningless"
fi

EVIDENCE_OK="$(read_driver evidence_readable_before_teardown)"
if [[ "${EVIDENCE_OK}" == "true" ]]; then
  pass "(c) scenario verification read its own seeded record BEFORE teardown ran"
else
  fail "(c) teardown ate the evidence: verification could not read the seeded record (got '${EVIDENCE_OK}')"
fi

VERDICTS_REAL="$(read_driver scenario_assertions_passed)"
if [[ "${VERDICTS_REAL}" == "true" ]]; then
  pass "(c) the run's own assertions still pass with teardown in place"
else
  fail "(c) the run's assertions did not pass with teardown in place (got '${VERDICTS_REAL}')"
fi

printf '\n--- (a) the leak: nothing eval-prefixed is left behind ---\n'
TEARDOWN_FAILED="$(read_driver teardown_failed)"
if [[ "${TEARDOWN_FAILED}" == "0" ]]; then
  pass "(a) record teardown reported failed=0"
else
  fail "(a) record teardown reported failed=${TEARDOWN_FAILED}"
fi

AFTER="$(q "SELECT (SELECT count(*) FROM thoughts WHERE namespace LIKE 'eval-live-recall-%')
             + (SELECT count(*) FROM decisions WHERE namespace LIKE 'eval-live-recall-%')
             + (SELECT count(*) FROM ob_session_lanes WHERE namespace LIKE 'eval-live-recall-%')
             + (SELECT count(*) FROM sessions WHERE namespace LIKE 'eval-live-recall-%');")"
if [[ "${AFTER}" == "0" ]]; then
  pass "(a) 0 eval-live-recall-% rows remain — the run removed the namespace it created"
else
  fail "(a) ${AFTER} eval-live-recall-% row(s) left behind — the run leaked its namespace"
  printf '\n--- leftover namespaces (names and counts only, no content) ---\n'
  psql -At "${DB_URL}" -c "SELECT 'thoughts', namespace, count(*) FROM thoughts WHERE namespace LIKE 'eval-live-recall-%' GROUP BY 2
                           UNION ALL SELECT 'decisions', namespace, count(*) FROM decisions WHERE namespace LIKE 'eval-live-recall-%' GROUP BY 2
                           UNION ALL SELECT 'ob_session_lanes', namespace, count(*) FROM ob_session_lanes WHERE namespace LIKE 'eval-live-recall-%' GROUP BY 2;" 2>&1 || true
fi

# ---------------------------------------------------------------------------
# (b) GUARD — mutation-proven refusal.
# ---------------------------------------------------------------------------
printf '\n--- (b) control: the prefix guard REFUSES a non-eval name, without mutating ---\n'
GUARD_REFUSED="$(read_driver guard_refusals)"
GUARD_EXPECTED="$(read_driver guard_cases)"
GUARD_ROWS_TOUCHED="$(read_driver guard_rows_touched_on_refusal)"
GUARD_ALLOWED_OK="$(read_driver guard_allows_own_namespace)"

if [[ -n "${GUARD_EXPECTED:-}" && "${GUARD_EXPECTED}" != "missing" \
      && "${GUARD_REFUSED}" == "${GUARD_EXPECTED}" && "${GUARD_EXPECTED}" -gt 0 ]]; then
  pass "(b) the guard refused all ${GUARD_EXPECTED} non-eval name(s) it was pointed at"
else
  fail "(b) the guard refused ${GUARD_REFUSED:-?} of ${GUARD_EXPECTED:-?} non-eval name(s) — it does not structurally refuse"
fi

if [[ "${GUARD_ROWS_TOUCHED}" == "0" ]]; then
  pass "(b) a refused purge deleted ZERO rows — it refuses BEFORE it mutates"
else
  fail "(b) a refused purge deleted ${GUARD_ROWS_TOUCHED:-?} row(s) — it throws AFTER mutating, which is not a guard"
fi

if [[ "${GUARD_ALLOWED_OK}" == "true" ]]; then
  pass "(b) the guard still ALLOWS a genuine per-run eval namespace — it discriminates"
else
  fail "(b) the guard refused a real eval namespace too; a check that refuses everything proves nothing"
fi

printf '\n'
if [[ ${FAILURES} -eq 0 ]]; then
  printf '=== RESULT: PASS — the scenario run removes the namespace it created, the guard refuses everything else without mutating, and the evidence survives long enough to be verified ===\n'
  exit 0
fi
printf '=== RESULT: FAIL (%d failing clause(s)) ===\n' "${FAILURES}"
exit 1
