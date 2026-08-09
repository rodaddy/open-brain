#!/usr/bin/env bash
# DONE-MEANS check for the #271 get_contract tripwire heal (Refs #271, #691).
#
#   bash scripts/done-means/271-tripwire-acknowledges-contract-moves.sh
#
# WHAT THIS GATES, AND WHY IT IS NOT JUST "RUN THE TEST"
#
# src/tools/__tests__/get-contract.test.ts carries the #271 boundary tripwire:
# hot memory is advertised ONLY through the client-pulled agent_context_pack,
# and any new advertised surface must be consciously acknowledged before it
# lands. #691 bumped tool_contracts.agent_context_pack.version 2 -> 3 without
# touching the tripwire, so the upstream default branch went red and STAYED
# red — which is the failure this gate exists to make impossible to repeat.
#
# The subtle half is why a red tripwire is worse than a failing test. Bun's
# expect() throws on first failure, so every assertion AFTER the stale literal
# stopped executing: the exact-key-set assertion and the push/injection
# negative filter — the two clauses that actually enforce #271 — were dark
# while the file "merely" failed. Measured: 37 expect() calls on the red tree,
# 44 on the healed one. A tripwire whose later clauses do not run is not a
# weakened tripwire; it is an absent one that still shows up in the test list.
#
# So this gate asserts THREE things a bare `bun test` does not:
#   - the tripwire passes (clause a),
#   - the two enforcing clauses actually EXECUTE, proven by the expect() count
#     rather than by the file being green (clause b),
#   - the tripwire still discriminates — it is not green because someone
#     loosened it (clause c, a mutation).
#
# Clause z is a control: it must PASS on both sides of the fix, so a red z
# means the harness broke, not that the boundary moved.
#
# RED PROOF (pre-fix tree, origin/main @ 123cc63): clause a FAILS with
# "Expected: 2 / Received: 3" on the test named
# "advertises hot memory only through the agent_context_pack pull boundary
# (#271)"; clause b FAILS at 37 expect() calls against the required floor.
# Clause z PASSES pre-fix, as a control must.
#
# Output is content-free: counts, names, and pass/fail states only.

set -uo pipefail

# Resolve the repo from THIS script's own location (lane-contract round 23:
# when the subject is in-tree, the check must structurally be unable to reach
# across trees — verify-lane runs it from a fresh worktree at the PR head).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}" || exit 1

TEST_FILE="src/tools/__tests__/get-contract.test.ts"
TRIPWIRE_NAME="advertises hot memory only through the agent_context_pack pull boundary (#271)"

# Scratch is gitignored; a run leaves the working tree clean.
WORK_DIR="${REPO_ROOT}/_scratch/271"
mkdir -p "${WORK_DIR}"

# The expect() floor. 44 on the healed tree; 37 when the stale literal aborts
# the body. Anything at or below the pre-fix count means the enforcing clauses
# did not run. Pinned as a floor, not an equality, so ADDING assertions to the
# tripwire does not fail this gate — only losing them does.
MIN_EXPECT_CALLS=44
PREFIX_EXPECT_CALLS=37

fail_count=0
pass_count=0

pass() { printf '  PASS  %s\n' "$1"; pass_count=$((pass_count + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; fail_count=$((fail_count + 1)); }

printf 'done-means: #271 tripwire acknowledges contract moves\n'
printf '  repo: %s\n\n' "${REPO_ROOT}"

if [[ ! -f "${TEST_FILE}" ]]; then
  printf 'FATAL: %s not found — wrong tree or the file was renamed.\n' "${TEST_FILE}"
  exit 1
fi

# ---------------------------------------------------------------------------
# clause a — the tripwire passes, by name
# ---------------------------------------------------------------------------
# Asserted by NAME rather than by the file's overall exit code: a green file
# whose tripwire was renamed or skipped would otherwise satisfy this.
A_LOG="${WORK_DIR}/clause-a.log"
bun test "${TEST_FILE}" > "${A_LOG}" 2>&1
a_status=$?

if [[ ${a_status} -ne 0 ]]; then
  fail "a: ${TEST_FILE} is RED (exit ${a_status}) — see ${A_LOG}"
  # Surface the assertion cause, not the coverage table.
  rg -e 'Expected:|Received:|✗' "${A_LOG}" 2>/dev/null | head -5 | sed 's/^/        | /'
else
  # A passing file is not yet proof the tripwire itself ran. Bun names tests
  # only on FAILURE (lane-contract, #613), so a name grep cannot prove
  # execution on a green run — clause b carries that burden via the count.
  if rg -qF -e "${TRIPWIRE_NAME}" "${TEST_FILE}"; then
    pass "a: ${TEST_FILE} green and the #271 tripwire is present by name"
  else
    fail "a: the file is green but the #271 tripwire NAME is gone — renamed or deleted"
  fi
fi

# ---------------------------------------------------------------------------
# clause b — the enforcing clauses EXECUTED (expect() count, not greenness)
# ---------------------------------------------------------------------------
# The whole reason this gate exists beyond `bun test`. A first-failure abort
# silently skips the exact-key-set assertion and the push/injection negative
# filter while the suite still reports the test.
expect_calls="$(rg -o -e '([0-9]+) expect\(\) calls' -r '$1' "${A_LOG}" 2>/dev/null | tail -1)"

if [[ -z "${expect_calls:-}" ]]; then
  fail "b: could not read an expect() count from the run — did-not-run, not zero"
elif (( expect_calls >= MIN_EXPECT_CALLS )); then
  pass "b: ${expect_calls} expect() calls executed (floor ${MIN_EXPECT_CALLS}; pre-fix tree ran ${PREFIX_EXPECT_CALLS})"
else
  fail "b: only ${expect_calls} expect() calls executed (floor ${MIN_EXPECT_CALLS}) — clauses after the first failure are dark"
fi

# ---------------------------------------------------------------------------
# clause c — the tripwire still DISCRIMINATES (mutation)
# ---------------------------------------------------------------------------
# A green clause is not evidence until it has been seen to fail
# (lane-contract round 9). The mutation adds a push-shaped top-level key to
# the served contract; the tripwire must go red. If it does not, the tripwire
# is decoration and the heal made it green by loosening it.
#
# The mutation is applied to a COPY-BACK backup and restored in an EXIT trap
# via `mv` — no delete path anywhere in this script.
MUT_TARGET="src/contract.ts"
MUT_BACKUP="${WORK_DIR}/contract.ts.orig"
restore_mutation() {
  if [[ -f "${MUT_BACKUP}" ]]; then
    mv -f "${MUT_BACKUP}" "${MUT_TARGET}"
  fi
}
trap restore_mutation EXIT

cp "${MUT_TARGET}" "${MUT_BACKUP}"

# Insert a push-shaped top-level key into the returned contract object. The
# tripwire's key-set assertion AND its /(hot|inject|push|...)/i negative
# filter should both reject it.
MUT_LOG="${WORK_DIR}/clause-c.log"
#
# A KILL IS ONLY A KILL IF THE BASELINE WAS ALIVE. On a tree where the
# tripwire is ALREADY red (the pre-fix world), "red under mutation" is
# satisfied by the failure that was there all along — a survived mutant
# reported as a kill, which is the false-GREEN family this contract's rounds
# 9/17/24 keep catching. So clause c is gated on clause a's baseline: with a
# red baseline it reports INCONCLUSIVE and fails, rather than banking a free
# pass off someone else's failure.
if [[ ${a_status} -ne 0 ]]; then
  restore_mutation
  fail "c: INCONCLUSIVE — the baseline is already RED, so 'red under mutation' proves nothing"
elif bun --eval '
  const fs = require("fs");
  const p = "'"${MUT_TARGET}"'";
  const src = fs.readFileSync(p, "utf8");
  const needle = "  agent_context_pack: {";
  const at = src.indexOf(needle);
  if (at < 0) { console.error("MUTATION-TARGET-NOT-FOUND"); process.exit(3); }
  const injected = "  hot_memory_push: { status: \"mutation-probe\" as const },\n";
  fs.writeFileSync(p, src.slice(0, at) + injected + src.slice(at));
' >> "${MUT_LOG}" 2>&1; then
  bun test "${TEST_FILE}" >> "${MUT_LOG}" 2>&1
  mut_status=$?
  restore_mutation

  if [[ ${mut_status} -ne 0 ]]; then
    pass "c: green baseline + mutation (push-shaped top-level key) goes RED — it discriminates"
  else
    fail "c: mutation SURVIVED — the tripwire passes with a push-shaped key advertised; it is decoration"
  fi
else
  restore_mutation
  fail "c: could not apply the mutation (target string not found) — clause measured nothing"
fi

# ---------------------------------------------------------------------------
# clause z — CONTROL: the two versions are pinned SEPARATELY and still differ
# ---------------------------------------------------------------------------
# This must PASS on both sides of the fix. The capability entry stayed at 2
# while the tool contract moved to 3; that they are allowed to differ is the
# point of pinning them separately, and a heal that "fixed" the red by making
# them equal would have destroyed the distinction. A red z means the harness
# or the tree is wrong, not that the boundary moved.
cap_version="$(rg -A2 -e 'name: "agent_context_pack"' src/contract.ts 2>/dev/null | rg -o -e 'version: ([0-9]+)' -r '$1' | head -1)"
tool_version="$(rg -A8 -e '^  agent_context_pack: \{' src/contract-schemas.ts 2>/dev/null | rg -o -e 'version: ([0-9]+)' -r '$1' | head -1)"

if [[ -z "${cap_version:-}" || -z "${tool_version:-}" ]]; then
  fail "z: could not read both versions (capability='${cap_version:-}' tool='${tool_version:-}') — did-not-run, not agreement"
elif rg -qF -e "expect(parsed.tool_contracts.agent_context_pack.version).toBe(${tool_version})" "${TEST_FILE}" &&
     rg -qF -e ").toBe(${cap_version});" "${TEST_FILE}"; then
  pass "z: both surfaces pinned in the tripwire and read from source (capability=${cap_version}, tool_contract=${tool_version})"
else
  fail "z: the tripwire's pinned versions do not match source (capability=${cap_version}, tool_contract=${tool_version})"
fi

# ---------------------------------------------------------------------------
printf '\n  passed: %d   failed: %d\n' "${pass_count}" "${fail_count}"

if (( fail_count > 0 )); then
  printf '  VERDICT: FAIL\n'
  exit 1
fi

printf '  VERDICT: PASS\n'
exit 0
