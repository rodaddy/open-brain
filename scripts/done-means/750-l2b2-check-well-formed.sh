#!/usr/bin/env bash
# DONE-MEANS check for the DONE-MEANS check of lane L2b-2 (issue #825).
#
#   bash scripts/done-means/750-l2b2-check-well-formed.sh
#
# ---------------------------------------------------------------------------
# Why a check about a check
# ---------------------------------------------------------------------------
# `scripts/done-means/750-l2b2-env-readers-take-config.sh` is written RED first:
# it asserts a state four later rewiring PRs will create, so at the head that
# INTRODUCES it the honest answer is exit 1. `scripts/verify-lane.ts` refuses to
# post a receipt for a done-means that exits non-zero, so the PR that adds the
# red check has no receipt line it can name — and the usual escapes (weaken the
# check, name an unrelated one) both destroy the thing being landed.
#
# The way out is to receipt a DIFFERENT property, one that is true today and
# stays true after the rewirings land: the L2b-2 check is WELL-FORMED. It runs
# without harness error, it reports every clause it claims to, its structural
# clauses (targets present, scanner proven to match) are green, and its exit
# code agrees with the state clauses it printed. A red check that is well-formed
# is a working gate pointed at unfinished work; a red check that is malformed is
# a typo nobody has read. This script tells the two apart.
#
# Four clauses, and all four must pass:
#
# CLAUSE 1 — THE INNER CHECK RAN AND JUDGED.
#   Exit 0 (the rewirings have landed) or exit 1 (they have not) are both fine.
#   Anything else — the inner script's own 3 for a harness error, a 127 for a
#   missing interpreter, a 2 from a shell syntax error — means the check did not
#   reach a verdict, so nothing it printed can be trusted. That is a harness
#   error HERE too, not a fail: this script cannot judge a check that did not run.
#
# CLAUSE 2 — THE STRUCTURAL CLAUSE IS GREEN.
#   Exactly one `CLAUSE 1` line, saying PASS. That clause asserts the four target
#   files exist; if it goes red the inner scan is over missing paths and every
#   other clause is vacuous. Exactly one, because two would mean the output is
#   being generated twice and the reader cannot tell which verdict is in force.
#
# CLAUSE 3 — THE POSITIVE CONTROL IS GREEN.
#   Exactly one `CLAUSE 3` line, saying PASS. That is the inner check's own
#   proof that its scanner still matches a hit where one MUST exist. It is the
#   clause that separates "clean tree" from "broken scan", and it is the one
#   clause whose value does not change when the rewirings land — so requiring it
#   green here costs the rewiring lanes nothing and catches a dead scanner today.
#
# CLAUSE 4 — THE EXIT CODE AGREES WITH THE STATE CLAUSES.
#   `CLAUSE 2` and `CLAUSE 4` are the STATE clauses: red until the rewirings
#   land, green after. Both lines must be present, and the exit code must agree
#   with them — exit 0 demands both PASS, exit 1 demands at least one FAIL. A
#   check that exits 1 while printing all-PASS, or exits 0 while printing a FAIL,
#   is reporting one thing and returning another, which is the failure mode that
#   makes a gate worse than no gate.
#
# The four clauses hold at BOTH ends of the rung. Today: 1 and 3 PASS, 2 and 4
# FAIL, inner exit 1, and clause 4 is satisfied by the FAILs. After the four
# rewirings: every inner clause PASSes, inner exit 0, and clause 4 is satisfied
# by the PASSes. Nothing here has to be edited out when the work finishes, which
# is the property that makes it a permanent check rather than scaffolding.
#
# NO ARGUMENTS. `DONE_MEANS_L2B2_INNER` exists ONLY so this script's own
# red/green can be demonstrated against a deliberately broken stand-in; it
# defaults to the real sibling and no caller in the repo sets it.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v rg >/dev/null 2>&1 || fail_hard "rg (ripgrep) not on PATH"

INNER="${DONE_MEANS_L2B2_INNER:-$REPO_ROOT/scripts/done-means/750-l2b2-env-readers-take-config.sh}"
[ -f "$INNER" ] || fail_hard "inner check not found at $INNER"

CLAUSE1=FAIL; CLAUSE1_EVIDENCE=""
CLAUSE2=FAIL; CLAUSE2_EVIDENCE=""
CLAUSE3=FAIL; CLAUSE3_EVIDENCE=""
CLAUSE4=FAIL; CLAUSE4_EVIDENCE=""

INNER_OUT="$(cd "$REPO_ROOT" && bash "$INNER" 2>&1)"
INNER_STATUS=$?

# Count and read back a single clause line by its leading label.
clause_lines() {
  printf '%s\n' "$INNER_OUT" | rg -c "^$1" || true
}
clause_text() {
  printf '%s\n' "$INNER_OUT" | rg -m 1 "^$1" || true
}

# ---------------------------------------------------------------------------
# CLAUSE 1 — the inner check reached a verdict.
# ---------------------------------------------------------------------------
if [ "$INNER_STATUS" -eq 0 ] || [ "$INNER_STATUS" -eq 1 ]; then
  CLAUSE1=PASS
  CLAUSE1_EVIDENCE="inner check exited $INNER_STATUS — a real verdict (0 = wired, 1 = not yet)"
else
  CLAUSE1_EVIDENCE="inner check exited $INNER_STATUS — no verdict was reached, so its output cannot be judged"
fi

if [ "$CLAUSE1" != PASS ]; then
  printf 'CLAUSE 1 (inner check reached a verdict):        %s — %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
  printf '%s\n' "$INNER_OUT" | sed 's/^/    /'
  fail_hard "inner check exited $INNER_STATUS; it did not run to a verdict"
fi

# ---------------------------------------------------------------------------
# CLAUSE 2 — the structural clause (targets exist) is green.
# ---------------------------------------------------------------------------
C1_N="$(clause_lines 'CLAUSE 1')"
C1_TEXT="$(clause_text 'CLAUSE 1')"
if [ "$C1_N" -ne 1 ]; then
  CLAUSE2_EVIDENCE="expected exactly one 'CLAUSE 1' line, found $C1_N"
elif printf '%s' "$C1_TEXT" | rg -q 'PASS'; then
  CLAUSE2=PASS
  CLAUSE2_EVIDENCE="the inner structural clause is green: $C1_TEXT"
else
  CLAUSE2_EVIDENCE="the inner structural clause is not green, so every later clause is vacuous: $C1_TEXT"
fi

# ---------------------------------------------------------------------------
# CLAUSE 3 — the positive control is green.
# ---------------------------------------------------------------------------
C3_N="$(clause_lines 'CLAUSE 3')"
C3_TEXT="$(clause_text 'CLAUSE 3')"
if [ "$C3_N" -ne 1 ]; then
  CLAUSE3_EVIDENCE="expected exactly one 'CLAUSE 3' line, found $C3_N"
elif printf '%s' "$C3_TEXT" | rg -q 'PASS'; then
  CLAUSE3=PASS
  CLAUSE3_EVIDENCE="the inner scanner is proven to still match: $C3_TEXT"
else
  CLAUSE3_EVIDENCE="the inner positive control is red — its clean results mean nothing: $C3_TEXT"
fi

# ---------------------------------------------------------------------------
# CLAUSE 4 — the exit code agrees with the state clauses.
# ---------------------------------------------------------------------------
C2_N="$(clause_lines 'CLAUSE 2')"
C4_N="$(clause_lines 'CLAUSE 4')"
C2_TEXT="$(clause_text 'CLAUSE 2')"
C4_TEXT="$(clause_text 'CLAUSE 4')"

STATE_PASSES=0
printf '%s' "$C2_TEXT" | rg -q 'PASS' && STATE_PASSES=$((STATE_PASSES + 1))
printf '%s' "$C4_TEXT" | rg -q 'PASS' && STATE_PASSES=$((STATE_PASSES + 1))

if [ "$C2_N" -ne 1 ] || [ "$C4_N" -ne 1 ]; then
  CLAUSE4_EVIDENCE="expected exactly one each of 'CLAUSE 2' and 'CLAUSE 4', found $C2_N and $C4_N"
elif [ "$INNER_STATUS" -eq 0 ] && [ "$STATE_PASSES" -ne 2 ]; then
  CLAUSE4_EVIDENCE="inner exited 0 but only $STATE_PASSES/2 state clauses say PASS — it returns success while reporting a failure"
elif [ "$INNER_STATUS" -eq 1 ] && [ "$STATE_PASSES" -eq 2 ]; then
  CLAUSE4_EVIDENCE="inner exited 1 but both state clauses say PASS — it returns failure while reporting success"
else
  CLAUSE4=PASS
  CLAUSE4_EVIDENCE="exit $INNER_STATUS agrees with $STATE_PASSES/2 state clauses passing"
fi

printf 'CLAUSE 1 (inner check reached a verdict):        %s — %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
printf 'CLAUSE 2 (inner structural clause is green):     %s — %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"
printf 'CLAUSE 3 (inner positive control is green):      %s — %s\n' "$CLAUSE3" "$CLAUSE3_EVIDENCE"
printf 'CLAUSE 4 (exit code agrees with its clauses):    %s — %s\n' "$CLAUSE4" "$CLAUSE4_EVIDENCE"

if [ "$CLAUSE2" = PASS ] && [ "$CLAUSE3" = PASS ] && [ "$CLAUSE4" = PASS ]; then
  exit 0
fi
exit 1
