#!/usr/bin/env bash
# DONE-MEANS check for issue #671 — "E2E gate verdict channel: clause (e)
# asserts a tally instead of residue, and teardownRecords swallows the archive
# error — red on a clean database".
#
#   bash scripts/done-means/671-teardown-verdict-residue.sh
#
# ---------------------------------------------------------------------------
# WHAT THE EXISTING DESIGN SAYS, AND WHAT THE DELTA IS
# ---------------------------------------------------------------------------
# The teardown design added by #655 is not being replaced. `teardownRecords`
# (eval/open-brain/live/gate.ts) still removes seeded records one at a time by
# exact id and tallies attempted/archived/already_absent/failed;
# `LiveScenarioTransport.cleanup` (eval/open-brain/live/scenario-transport.ts)
# still runs that record pass first and the prefix-guarded `purgeNamespace`
# after it. Both stay exactly as they were.
#
# UNVERIFIED, stated rather than implied: `qmd search "teardown residue
# namespace purge"` and `aqmd search "teardown"` both returned "No results
# found" fast (not a hang — round 22's distinction), so the design above was
# read from the source files directly rather than recovered from the index.
#
# The delta is the VERDICT CHANNEL, and it is a correctness delta, not a
# cosmetic one. Two defects, observed on the third credentialed #653 verify
# (2026-08-08, head d9d3712) where all three scenarios PASSED live and a
# 12-purge-table residue query returned ZERO rows, and the gate still exited 1:
#
#   1. THE TALLY CONFLATES "A CLEANUP CALL THREW" WITH "ROWS REMAIN". The
#      receipt read `attempted=6 archived=4 already_absent=0 failed=2`. The
#      arithmetic (4+0+2=6) proves both failures were record-loop `archive_entry`
#      throws, because the purge's own failures increment `failed` WITHOUT
#      touching `attempted`. The purge that followed then removed everything and
#      nothing corrected the count. Round 16's Tightening — "a teardown that
#      reports success is not evidence of removal" — has a mirror, and this is
#      it: a teardown that reports FAILURE is not evidence of residue.
#
#   2. THE ARCHIVE ERROR WAS DISCARDED. `teardownRecords` caught into a bare
#      `catch {}`, so only the integer survived; the throw's label was
#      unrecoverable from the receipt, the log, or anywhere else. That is the
#      dead-end-error class (Tightenings rounds 15/19) inside our own tooling.
#
# So: residue (a database query) becomes the load-bearing signal, the tally is
# demoted to diagnostics but is still REPORTED, and each swallowed error now
# contributes a content-free label to the receipt. The catch stays — a teardown
# that aborts on the first bad record strands every later one.
#
# NOT IN SCOPE, DELIBERATELY. The underlying `archive_entry` throw on memory-kind
# records is REAL and its cause is NOT ESTABLISHED. #671 says to surface the
# label and file separately, never to absorb a fix for it. This check therefore
# STUBS the archive to throw; it proves the verdict channel handles a throwing
# archive correctly and makes no claim about why the live tool throws.
#
# ---------------------------------------------------------------------------
# WHERE THIS CHECK STANDS TO SEE THE DEFECT, AND WHAT IT CANNOT SEE
# ---------------------------------------------------------------------------
# Residue is a database fact, so the database is REAL: a throwaway database this
# script creates, migrates and drops. The gate, the teardown, the purge, the
# residue counter and the verdict logic are all the SHIPPED functions. Exactly
# one thing is substituted — the `archive_entry` call, made to throw a labelled
# `LiveTransportError`, because a throwing archive AND a working purge in the
# same run is the combination that produced the false red, and on a live
# deployment that combination is intermittent.
#
# ITS LIMITATION, STATED (round 22 Tightening). The #655 driver's known gap was
# that a stubbed seam hides defects living in the real seam — which is how #666
# slipped past #655's green. The same gap applies here: the stub is a local
# throw, not the live MCP `archive_entry`. This check CANNOT establish why the
# live tool throws. It proves only its own claim.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) A throwing archive over a CLEAN database is GREEN. The archive throws,
#       the purge cleans, zero rows remain — and the gate PASSES. RED before the
#       fix: the gate reads `teardown.failed` and fails on a clean database.
#
#   (b) CONTROL — genuine residue still FAILS, naming the table and the count.
#       The purge is disabled so the rows really do remain. A check that only
#       ever goes green proves nothing; this is the clause that proves the new
#       verdict channel still discriminates.
#
#   (c) THE LABEL REACHES THE RECEIPT. The thrown error's label appears in the
#       gate's diagnostics and in the tally's `failure_labels`. MUTATION-PROVEN:
#       the expected label is read from the driver's own JSON output rather than
#       hardcoded here, and the check additionally asserts the label is NOT the
#       empty string and NOT a generic placeholder — so renaming the thrown error
#       moves both sides together and cannot leave a stale literal passing.
#
#   (d) THE TALLY IS STILL REPORTED, as diagnostics, and is NOT in the verdict
#       channel. Both halves in ONE clause (round 18): `failed` is nonzero AND
#       the gate's `failures` array contains no teardown-tally entry. Split into
#       two, each half passes for the wrong reason.
#
# ---------------------------------------------------------------------------
# WHAT THIS SCRIPT TOUCHES, AND WHAT IT REFUSES TO
# ---------------------------------------------------------------------------
# It creates ONE throwaway database by a name it generates itself, and drops
# that same database via `dropdb` on the way out. It contains no `rm` of any
# kind. It never reads OPENBRAIN_TEST_DATABASE_URL from the environment. It
# needs no credentials, talks to no deployment, and touches neither the dogfood
# database nor core01. Output is content-free: clause names, counts, statuses,
# and this driver's own error labels.
#
# The check resolves the driver from its OWN tree (BASH_SOURCE-derived root), so
# it structurally cannot measure a different checkout than the one it ships in
# (round 23 Tightening).
#
# ---------------------------------------------------------------------------
# EXPECTED TO FAIL BEFORE THE FIX
# ---------------------------------------------------------------------------
# On `origin/main` the transport's `cleanup` returns a bare tally with no
# residue, `teardownRecords` discards the error, and `runScenarioGate` pushes
# `teardown_failed:<n>` into `failures`. Clause (a) fails (green run reported
# red), clause (c) fails (no label anywhere), clause (d) fails (the tally IS the
# verdict). RED transcript is in the PR body.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}" || exit 1

PG_HOST="${DONE_MEANS_671_PGHOST:-127.0.0.1}"
PG_PORT="${DONE_MEANS_671_PGPORT:-5432}"
PG_USER="${DONE_MEANS_671_PGUSER:-${USER}}"
DB_NAME="done_means_671_$$_$(date +%s)"
DB_URL="postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${DB_NAME}"

DRIVER="${REPO_ROOT}/scripts/done-means/671-teardown-verdict-residue.driver.ts"

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

printf '=== done-means #671: does the teardown verdict read residue, and does the swallowed archive label reach the receipt? ===\n'
printf 'throwaway database: %s\n\n' "${DB_NAME}"

if [[ ! -f "${DRIVER}" ]]; then
  fail "missing required component: ${DRIVER}"
  printf '\n=== RESULT: FAIL (%d) ===\n' "${FAILURES}"
  exit 1
fi

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

# Precondition: a fresh database holds no eval-prefixed rows. Without it, every
# residue count below proves nothing (the #613 standard).
BEFORE="$(q "SELECT (SELECT count(*) FROM thoughts WHERE namespace LIKE 'eval-live-recall-%')
              + (SELECT count(*) FROM decisions WHERE namespace LIKE 'eval-live-recall-%')
              + (SELECT count(*) FROM ob_session_lanes WHERE namespace LIKE 'eval-live-recall-%');")"
if [[ "${BEFORE}" == "0" ]]; then
  pass "precondition: 0 eval-live-recall-% rows before the run"
else
  fail "precondition broken: ${BEFORE} eval-live-recall-% row(s) already present in a FRESH database"
fi

SCRATCH_DIR="${OPENBRAIN_TEMP_WORKSPACE:-/Volumes/ThunderBolt/_tmp}/open-brain/_scratch/671-teardown-verdict"
mkdir -p "${SCRATCH_DIR}"

read_json() {
  # $1 = file, $2 = key. Prints the value; a JSON array prints as compact JSON.
  #
  # Prints the sentinel MISSING when the file or key is absent, rather than the
  # empty string. On the first RED run an empty result flowed into `[[ "${X}" -gt
  # 0 ]]`, which bash evaluated as the unset variable `undefined` and aborted the
  # script mid-clause under `set -u` — the remaining clauses never printed and the
  # transcript looked like a crash rather than a verdict. A sentinel keeps every
  # clause reachable and makes the absence visible in the output.
  local value
  value="$(bun -e 'const f=Bun.file(process.argv[2]);if(!(await f.exists())){console.log("MISSING");process.exit(0)}let r;try{r=await f.json()}catch{console.log("MISSING");process.exit(0)}const v=r[process.argv[3]];console.log(v===undefined||v===null?"MISSING":(Array.isArray(v)?JSON.stringify(v):String(v)))' \
    x "$1" "$2" 2>/dev/null)"
  printf '%s' "${value:-MISSING}"
}

# Numeric comparison that survives a MISSING sentinel: `[[ MISSING -gt 0 ]]`
# is a bash arithmetic evaluation of a bare word, which under `set -u` aborts.
is_positive_int() { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 > 0 )); }
is_zero_int() { [[ "$1" == "0" ]]; }

run_driver() {
  # $1 = mode, $2 = out path. Echoes the driver log; returns the driver's exit.
  local mode="$1" out="$2"
  DONE_MEANS_671_DB_URL="${DB_URL}" DONE_MEANS_671_OUT="${out}" \
    DONE_MEANS_671_MODE="${mode}" bun "${DRIVER}" 2>&1
}

# ---------------------------------------------------------------------------
# (a)+(c)+(d) — one run with a THROWING archive and a WORKING purge.
# ---------------------------------------------------------------------------
printf '\n--- run 1: throwing archive, purge enabled (clauses a, c, d) ---\n'
OUT_A="${SCRATCH_DIR}/throwing-archive-${DB_NAME}.json"
info "receipt: ${OUT_A}"
set +e
LOG_A="$(run_driver throwing_archive "${OUT_A}")"
EXIT_A=$?
set -e
printf '%s\n' "${LOG_A}" | tail -25
if [[ ${EXIT_A} -ne 0 ]]; then
  fail "run 1 driver exited ${EXIT_A} — clause results below may be unreadable"
fi

printf '\n--- (a) a throwing archive over a clean database is GREEN ---\n'
A_SCENARIOS="$(read_json "${OUT_A}" scenario_count)"
if is_positive_int "${A_SCENARIOS}"; then
  pass "(a) the run really executed ${A_SCENARIOS} scenario(s) — not a silent empty run"
else
  fail "(a) the run reported ${A_SCENARIOS} scenario(s); every count below would be meaningless"
fi

A_FAILED="$(read_json "${OUT_A}" teardown_failed)"
if is_positive_int "${A_FAILED}"; then
  pass "(a) the archive really threw (${A_FAILED} cleanup call(s) failed) — the defect's precondition is present"
else
  fail "(a) no cleanup call failed (failed=${A_FAILED}); this run did NOT reproduce the throwing-archive condition, so a green verdict below would prove nothing"
fi

A_RESIDUE_CHECKED="$(read_json "${OUT_A}" residue_checked)"
A_RESIDUE_ROWS="$(read_json "${OUT_A}" residue_rows)"
A_INDEPENDENT="$(read_json "${OUT_A}" independent_residue_rows)"
if [[ "${A_RESIDUE_CHECKED}" == "true" ]]; then
  pass "(a) residue was actually OBSERVED (checked=true) — the verdict rests on a reading that ran"
else
  fail "(a) residue was not observed (checked=${A_RESIDUE_CHECKED}); an unperformed check may not support a verdict"
fi
if is_zero_int "${A_RESIDUE_ROWS}" && is_zero_int "${A_INDEPENDENT}"; then
  pass "(a) 0 rows remain, confirmed twice — by the gate and by an independent count taken after it returned"
else
  fail "(a) rows remain (gate=${A_RESIDUE_ROWS}, independent=${A_INDEPENDENT}); this run is not the clean-database case clause (a) needs"
fi

A_PASSED="$(read_json "${OUT_A}" gate_passed)"
A_GATE_FAILURES="$(read_json "${OUT_A}" gate_failures)"
if [[ "${A_PASSED}" == "true" ]]; then
  pass "(a) the gate PASSED on a clean database despite the archive throw — the false red is gone"
else
  fail "(a) the gate FAILED on a database with zero residue: ${A_GATE_FAILURES}"
fi

printf '\n--- (c) the swallowed archive error reaches the receipt, by label ---\n'
# The expected label comes from the DRIVER'S OWN OUTPUT, never a literal here.
# Renaming the thrown error moves both sides together, so a stale hardcoded
# string cannot keep this clause green (the mutation requirement).
EXPECTED_LABEL="$(read_json "${OUT_A}" expected_label)"
A_LABELS="$(read_json "${OUT_A}" teardown_failure_labels)"
A_DIAGNOSTICS="$(read_json "${OUT_A}" gate_diagnostics)"

if [[ -n "${EXPECTED_LABEL}" && "${EXPECTED_LABEL}" != "undefined" && "${EXPECTED_LABEL}" != "null" \
      && "${EXPECTED_LABEL}" != "unknown" && "${EXPECTED_LABEL}" != "Error" ]]; then
  pass "(c) the driver declared a specific expected label — not empty, not a generic placeholder"
else
  fail "(c) the expected label is empty or generic ('${EXPECTED_LABEL}'); a label that names nothing is the dead end this clause exists to remove"
fi

if [[ "${A_LABELS}" == *"${EXPECTED_LABEL}"* ]]; then
  pass "(c) the tally carries the thrown label in failure_labels"
else
  fail "(c) the thrown label '${EXPECTED_LABEL}' is NOT in failure_labels: ${A_LABELS}"
fi

if [[ "${A_DIAGNOSTICS}" == *"${EXPECTED_LABEL}"* ]]; then
  pass "(c) the gate receipt's diagnostics carry the thrown label — an operator can recover WHY the call failed"
else
  fail "(c) the thrown label '${EXPECTED_LABEL}' is NOT in the receipt diagnostics: ${A_DIAGNOSTICS}"
fi

printf '\n--- (d) the tally is reported as diagnostics and is NOT the verdict ---\n'
# Both halves in one clause (round 18): reported AND non-verdict. Split apart,
# each half passes for the wrong reason — a gate that drops the tally entirely
# would satisfy "not in failures", and the old broken gate satisfied "reported".
if is_positive_int "${A_FAILED}" && [[ "${A_DIAGNOSTICS}" == *"teardown_call_failures"* \
      && "${A_GATE_FAILURES}" != *"teardown"* ]]; then
  pass "(d) failed=${A_FAILED} is REPORTED in diagnostics AND absent from the verdict channel"
else
  fail "(d) tally reporting/verdict separation not proven — failed=${A_FAILED} diagnostics=${A_DIAGNOSTICS} failures=${A_GATE_FAILURES}"
fi

# ---------------------------------------------------------------------------
# (b) CONTROL — genuine residue must still FAIL, naming the table and count.
# ---------------------------------------------------------------------------
printf '\n--- run 2: purge disabled, rows genuinely remain (clause b) ---\n'
OUT_B="${SCRATCH_DIR}/residue-control-${DB_NAME}.json"
info "receipt: ${OUT_B}"
set +e
LOG_B="$(run_driver residue_control "${OUT_B}")"
EXIT_B=$?
set -e
printf '%s\n' "${LOG_B}" | tail -20
if [[ ${EXIT_B} -ne 0 ]]; then
  fail "run 2 driver exited ${EXIT_B} — clause (b) results below may be unreadable"
fi

B_ROWS="$(read_json "${OUT_B}" residue_rows)"
B_INDEPENDENT="$(read_json "${OUT_B}" independent_residue_rows)"
B_PASSED="$(read_json "${OUT_B}" gate_passed)"
B_GATE_FAILURES="$(read_json "${OUT_B}" gate_failures)"
B_TABLES="$(read_json "${OUT_B}" residue_tables)"

# The PRECONDITION reads the INDEPENDENT count, deliberately, not the gate's own
# reading: whether the control actually produced residue is a fact about the
# database, and asking the gate would make this clause unable to distinguish
# "no rows were left" from "the gate cannot see rows" — which is #671 itself.
if is_positive_int "${B_INDEPENDENT}"; then
  pass "(b) the control really produced residue (${B_INDEPENDENT} row(s), counted independently of the gate) — it is testing the failing case"
else
  fail "(b) the control produced no residue (independent=${B_INDEPENDENT}); it is not exercising the failure branch"
fi

# "The gate failed" alone is NOT this clause. Observed in the RED run: the
# pre-fix gate also failed here, but it failed on `teardown_failed:2` — the very
# tally #671 removes from the verdict channel — while its residue reading did not
# exist. A clause satisfied by the OLD verdict on the pre-fix tree is the
# round-9/17 negative-match family: it would report "still discriminates" about a
# mechanism that is not present. So the clause requires the failure to be a
# RESIDUE failure specifically, and requires the gate to have observed residue at
# all.
B_RESIDUE_CHECKED="$(read_json "${OUT_B}" residue_checked)"
if [[ "${B_PASSED}" == "false" && "${B_RESIDUE_CHECKED}" == "true" \
      && "${B_GATE_FAILURES}" == *"teardown_residue"* ]]; then
  pass "(b) the gate FAILED specifically on OBSERVED residue — the new verdict channel discriminates on the right signal"
else
  fail "(b) the gate's failure is not a residue verdict — passed=${B_PASSED} residue_checked=${B_RESIDUE_CHECKED} failures=${B_GATE_FAILURES}"
fi

if [[ "${B_GATE_FAILURES}" == *"teardown_residue:rows="* ]]; then
  pass "(b) the failure names the residue and its count"
else
  fail "(b) the failure does not name residue: ${B_GATE_FAILURES}"
fi

# Naming the COUNT is not naming WHERE. A residue failure that cannot say which
# table is the dead-end-error class (rounds 15/19) in a new spelling.
NAMED_A_TABLE=0
for table in ob_session_lanes thoughts decisions sessions; do
  if [[ "${B_GATE_FAILURES}" == *"${table}="* ]]; then NAMED_A_TABLE=1; break; fi
done
if [[ ${NAMED_A_TABLE} -eq 1 ]]; then
  pass "(b) the failure names the TABLE holding the residue (observed tables: ${B_TABLES})"
else
  fail "(b) the failure names a count but no table: ${B_GATE_FAILURES}"
fi

printf '\n'
if [[ ${FAILURES} -eq 0 ]]; then
  printf '=== RESULT: PASS — the teardown verdict reads residue, a throwing archive over a clean database is green with its label reported, and genuine residue still fails naming the table ===\n'
  exit 0
fi
printf '=== RESULT: FAIL (%d failing clause(s)) ===\n' "${FAILURES}"
exit 1
