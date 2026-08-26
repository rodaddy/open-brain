#!/usr/bin/env bash
# DONE-MEANS check for the qmd-search timeout race (Closes #608, #632).
#
#   bash scripts/done-means/608-qmd-timeout-does-not-fire-after-exit.sh
#
# WHAT THIS GATES, AND WHY IT IS NOT JUST "RUN THE TEST"
#
# src/tools/search-all.ts raced a qmd subprocess against a setTimeout that
# called proc.kill(). Nothing cleared the timer when the subprocess won, so the
# callback fired later — typically after the test that started it had already
# ended — and called .kill() on a mocked spawn handle that has none. Bun does
# not attribute that to any test. It reports:
#
#   # Unhandled error between tests
#   TypeError: proc.kill is not a function
#
# and exits 1 with `0 fail`. That is the whole reason a bare `bun test` exit
# code is insufficient evidence here: on the BROKEN code the run can report
# every test passing. Clause b therefore greps the run output for the unhandled
# marker rather than trusting the status, because the two disagree by design in
# exactly the failure mode this gate exists to catch.
#
# The observed cost: `db-integration` and `check` red on PRs #771, #772, #776,
# and on 2 of main's own last 6 runs, each time on a diff that touched nothing
# in src/. Re-running the same job with no code change flipped it to green,
# which is the definition of a race and is what taught readers to discount red.
#
# Clauses:
#   a — the search-all test file is green.
#   b — the run emitted no `Unhandled error between tests` (the real gate).
#   c — the regression test still DISCRIMINATES: with the clearTimeout removed
#       from src/tools/search-all.ts, the file must go red. A mutation that
#       survives means the test is decoration.
#   d — the server/ twin carries the same cancellation, so the fix cannot be
#       half-applied. Both files ship the identical race; fixing one leaves the
#       other armed.
#   z — CONTROL: both twins still arm a timeout at all. Deleting the timeout
#       would trivially satisfy a/b/c while removing the protection the timer
#       exists to provide. Must PASS on both sides of the fix.
#
# RED PROOF (pre-fix tree, origin/main @ 1e1e006, regression test present):
#   clause a FAILS — `expect(cleared).toBe(1)` gets `Received: 0`, i.e. the
#   timer was never cancelled; and firing the captured callback throws
#   `TypeError: proc.kill is not a function. (In 'proc.kill()', 'proc.kill' is
#   undefined)` — the verbatim #632 error. Clause d FAILS (no clearTimeout in
#   either twin). Clause z PASSES pre-fix, as a control must.
#
# Output is content-free: counts, names, and pass/fail states only.

set -uo pipefail

# Resolve the repo from THIS script's own location, so the check cannot reach
# across trees when verify-lane runs it from a fresh worktree at the PR head.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}" || exit 1

TEST_FILE="src/tools/__tests__/search-all.test.ts"
SRC_TWIN="src/tools/search-all.ts"
SERVER_TWIN="server/tools/search-all.ts"
REGRESSION_NAME="clears the qmd timeout when the subprocess finishes first"
UNHANDLED_MARKER="Unhandled error between tests"

# Scratch is gitignored; a run leaves the working tree clean.
WORK_DIR="${REPO_ROOT}/_scratch/608"
mkdir -p "${WORK_DIR}"

fail_count=0
pass_count=0

pass() { printf '  PASS  %s\n' "$1"; pass_count=$((pass_count + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; fail_count=$((fail_count + 1)); }

printf 'done-means: #608/#632 qmd timeout does not fire after the process exits\n'
printf '  repo: %s\n\n' "${REPO_ROOT}"

for f in "${TEST_FILE}" "${SRC_TWIN}" "${SERVER_TWIN}"; do
  if [[ ! -f "${f}" ]]; then
    printf 'FATAL: %s not found — wrong tree or the file was renamed.\n' "${f}"
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# clause a — the search-all test file is green, and the regression is present
# ---------------------------------------------------------------------------
A_LOG="${WORK_DIR}/clause-a.log"
bun test "${TEST_FILE}" > "${A_LOG}" 2>&1
a_status=$?

if [[ ${a_status} -ne 0 ]]; then
  fail "a: ${TEST_FILE} is RED (exit ${a_status}) — see ${A_LOG}"
  rg -e 'Expected:|Received:|proc\.kill|\(fail\)' "${A_LOG}" 2>/dev/null | head -5 | sed 's/^/        | /'
elif rg -qF -e "${REGRESSION_NAME}" "${TEST_FILE}"; then
  pass "a: ${TEST_FILE} green and the #608/#632 regression is present by name"
else
  fail "a: the file is green but the regression test NAME is gone — renamed or deleted"
fi

# ---------------------------------------------------------------------------
# clause b — no unhandled error between tests (the actual defect signature)
# ---------------------------------------------------------------------------
# Checked against the RUN OUTPUT, not the exit code. The defect's signature is
# precisely a run that reports `0 fail` while exiting non-zero, so greenness of
# the test list proves nothing about it.
if rg -qF -e "${UNHANDLED_MARKER}" "${A_LOG}"; then
  fail "b: the run emitted '${UNHANDLED_MARKER}' — a timer fired after its test ended"
  rg -A6 -F -e "${UNHANDLED_MARKER}" "${A_LOG}" 2>/dev/null | head -8 | sed 's/^/        | /'
else
  pass "b: no '${UNHANDLED_MARKER}' in the run output"
fi

# ---------------------------------------------------------------------------
# clause c — the regression still DISCRIMINATES (mutation)
# ---------------------------------------------------------------------------
# Removes the clearTimeout from the src twin, restoring the #608 behaviour.
# The test file must go red. Restored via `mv` from a backup in an EXIT trap —
# no delete path anywhere in this script.
MUT_BACKUP="${WORK_DIR}/search-all.ts.orig"
restore_mutation() {
  if [[ -f "${MUT_BACKUP}" ]]; then
    mv -f "${MUT_BACKUP}" "${SRC_TWIN}"
  fi
}
trap restore_mutation EXIT

cp "${SRC_TWIN}" "${MUT_BACKUP}"
MUT_LOG="${WORK_DIR}/clause-c.log"

# A KILL IS ONLY A KILL IF THE BASELINE WAS ALIVE. On an already-red tree,
# "red under mutation" is satisfied by the pre-existing failure — a survived
# mutant banked as a kill. So clause c is gated on clause a's baseline.
if [[ ${a_status} -ne 0 ]]; then
  restore_mutation
  fail "c: INCONCLUSIVE — the baseline is already RED, so 'red under mutation' proves nothing"
elif bun --eval '
  const fs = require("fs");
  const p = "'"${SRC_TWIN}"'";
  const src = fs.readFileSync(p, "utf8");
  const needle = "    clearTimeout(timeoutHandle);\n";
  if (!src.includes(needle)) { console.error("MUTATION-TARGET-NOT-FOUND"); process.exit(3); }
  fs.writeFileSync(p, src.replace(needle, ""));
' >> "${MUT_LOG}" 2>&1; then
  bun test "${TEST_FILE}" >> "${MUT_LOG}" 2>&1
  mut_status=$?
  restore_mutation

  if [[ ${mut_status} -ne 0 ]]; then
    pass "c: green baseline + mutation (clearTimeout removed) goes RED — it discriminates"
  else
    fail "c: mutation SURVIVED — the test passes with the timer left armed; it is decoration"
  fi
else
  restore_mutation
  fail "c: could not apply the mutation (target string not found) — clause measured nothing"
fi

# ---------------------------------------------------------------------------
# clause d — the server/ twin carries the same cancellation
# ---------------------------------------------------------------------------
# Both files ship byte-equivalent copies of this race. A fix applied to one
# leaves the other armed, and the server twin has no test file of its own to
# notice — so the structural check is the only thing standing between it and a
# silent half-fix.
d_ok=1
for twin in "${SRC_TWIN}" "${SERVER_TWIN}"; do
  if ! rg -qF -e "clearTimeout(timeoutHandle)" "${twin}"; then
    fail "d: ${twin} arms the qmd timeout but never clears it — the #608 race is live there"
    d_ok=0
  elif ! rg -qF -e 'typeof proc.kill === "function"' "${twin}"; then
    fail "d: ${twin} calls proc.kill() unguarded — a partial spawn handle still throws"
    d_ok=0
  fi
done
if (( d_ok == 1 )); then
  pass "d: both twins clear the timer and guard proc.kill"
fi

# ---------------------------------------------------------------------------
# clause z — CONTROL: both twins still ARM a timeout at all
# ---------------------------------------------------------------------------
# Must PASS on both sides of the fix. Deleting the timeout entirely would
# satisfy a, b, c and d while removing the bound that stops a hung qmd from
# stalling federated search forever. A red z means the protection was removed,
# not that the race was fixed.
z_ok=1
for twin in "${SRC_TWIN}" "${SERVER_TWIN}"; do
  if ! rg -qF -e "QMD_TIMEOUT_MS" "${twin}" || ! rg -qF -e "timedOut: true" "${twin}"; then
    fail "z: ${twin} no longer bounds the qmd subprocess — the timeout itself is gone"
    z_ok=0
  fi
done
if (( z_ok == 1 )); then
  pass "z: both twins still bound the qmd subprocess with QMD_TIMEOUT_MS"
fi

# ---------------------------------------------------------------------------
printf '\n  passed: %d   failed: %d\n' "${pass_count}" "${fail_count}"

if (( fail_count > 0 )); then
  printf '  VERDICT: FAIL\n'
  exit 1
fi

printf '  VERDICT: PASS\n'
exit 0
