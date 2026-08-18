#!/usr/bin/env bash
# DONE-MEANS check for #721 — "merge-gate-and-verify-lane.sh records its only
# live clause as PASS when any non-empty MGVL_IN_VERIFY_LANE is inherited."
#
#   bash scripts/done-means/721-verify-lane-guard-earned.sh
#
# ---------------------------------------------------------------------------
# The defect
# ---------------------------------------------------------------------------
# Family B, from the 2026-08-10 gate-layer audit (docs/gate-layer-audit-2026-08-10.md):
# a gate letting its ENVIRONMENT decide the verdict instead of the code. Same
# shape as #705 (inherited env) and CLOSED #483 (inherited GIT_DIR).
#
# merge-gate-and-verify-lane.sh clause 9 is the ONLY clause that exercises
# verify-lane end to end against a real PR, worktree and receipt. Before this
# fix it skipped on the mere PRESENCE of MGVL_IN_VERIFY_LANE and recorded that
# skip as PASS:
#
#   $ MGVL_IN_VERIFY_LANE=fabricated-value bash scripts/done-means/merge-gate-and-verify-lane.sh
#   CLAUSE 9 (LIVE: ...): PASS — SKIP-BY-GUARD: ... (MGVL_IN_VERIFY_LANE=fabricated-value)
#   $ echo $?
#   0
#
# Full green, exit 0, the live proof never executed. A stale export, a CI env
# leak, or a value set by hand turns the live clause off and the transcript a
# controller pastes into a PR body is indistinguishable from a genuine run.
#
# The GUARD ITSELF IS RIGHT — the recursion it prevents is measured (331
# worktrees, 2026-08-08). The defect is that the guard is ASSERTED rather than
# EARNED, and that a skip is recorded as a pass.
#
# ---------------------------------------------------------------------------
# What "earned" means here
# ---------------------------------------------------------------------------
# verify-lane.ts:479-480 sets BOTH markers together, and they are structured:
#
#   MGVL_IN_VERIFY_LANE  = `pr-${args.pr}`
#   MGVL_VERIFY_LANE_PRS = [...ancestry, args.pr].join(",")
#
# Only the real verify-lane path can produce that PAIR in agreement. So the
# guard re-derives the claim from the value instead of trusting its presence:
# the marker must match `pr-<n>` AND `<n>` must appear in the ancestry list.
# Anything else is a POLLUTED ENVIRONMENT — a HARNESS-ERROR (exit 3), not a
# free pass, because the operator needs to know their shell is lying to their
# gates rather than have a gate quietly accommodate it.
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
#   1  fabricated MGVL_IN_VERIFY_LANE => NOT a clean exit 0. This single
#      command is the whole red/green of the issue.
#   2  ... and the refusal is a HARNESS-ERROR naming the variable and the
#      shape it expected — never a silent pass and never a bare failure.
#   3  a SHAPE-VALID marker with NO matching ancestry (pr-999 + empty
#      MGVL_VERIFY_LANE_PRS) is ALSO refused. Without this, "validation" is
#      satisfiable by anyone who reads the source and types `pr-1`.
#   4  a GENUINE nested pair (pr-<n> + <n> in the ancestry) still skips
#      politely, records SKIP (not PASS), and does not recurse.
#   5  a skipped live clause does NOT report a clean all-passed exit 0, and
#      the summary SAYS the live clause is unproven this run —
#      issue-resolution-artifacts.sh's "skipped is not passed" convention.
#   6  the PASS verdict is no longer reachable for clause 9 without the live
#      run: the string SKIP-BY-GUARD and the token PASS are not recorded
#      together anywhere in the subject.
#   7  SIBLING SWEEP (the pattern, not the instance): MGVL_LIVE_PR — the other
#      inherited variable that steers the live clause — is validated as a
#      number and refused when it names the PR that contains this check.
#
# Clauses 1-5 drive THE REAL INVOCATION PATH: they execute the subject script
# itself with the environment under test, exactly as the issue's reproduction
# does. Nothing here calls an --explain seam or a helper function (round 28's
# rule), and the fixture environment is the very thing that expresses the
# defect (round 30's rule) — an inherited variable is the input under test, so
# setting it IS the fixture.
#
# COST NOTE, announced rather than silent: clauses 1-5 each run the subject to
# completion. On the SKIP paths (2, 3, 4, 5) the live clause does not fire, so
# no PR is created. Clause 1 pre-#721 would ALSO skip; post-fix it refuses at
# exit 3 BEFORE the live clause, so this check never creates a throwaway PR.
# That is deliberate: a done-means check for a guard must not itself depend on
# network mutation.
#
# Exit 0 only when every clause passes. Exit 3 is a harness error (missing
# tool), which is NOT a fail of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUBJECT="$REPO_ROOT/scripts/done-means/merge-gate-and-verify-lane.sh"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bash >/dev/null 2>&1 || fail_hard "bash not on PATH"
command -v rg   >/dev/null 2>&1 || fail_hard "rg not on PATH"
[ -r "$SUBJECT" ] || fail_hard "no subject script at $SUBJECT"

FAILURES=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

# Run the subject with a controlled environment. Sets S_OUT and S_EXIT.
#
# MGVL_LIVE_PR is cleared on every invocation. It is an operator override that
# redirects the live clause's subject, and inheriting one from the controller's
# shell would make these clauses measure a different PR than they name. Cleared
# deliberately and announced here, per "nothing is adjusted silently".
S_OUT=""
S_EXIT=0
run_subject() {
  local marker="$1" ancestry="$2"
  S_OUT="$(
    MGVL_IN_VERIFY_LANE="$marker" \
    MGVL_VERIFY_LANE_PRS="$ancestry" \
    MGVL_LIVE_PR="" \
      bash "$SUBJECT" 2>&1
  )"
  S_EXIT=$?
}

# ===========================================================================
# CLAUSE 1 — the issue's reproduction. A fabricated value must NOT yield a
# clean exit 0. This is the whole red/green.
# ===========================================================================
run_subject "fabricated-value" ""
if [ "$S_EXIT" -eq 0 ]; then
  fail "(1) MGVL_IN_VERIFY_LANE=fabricated-value still exits 0 — #721 live: the live clause is disabled by an inherited variable and the run reads as full green"
else
  pass "(1) MGVL_IN_VERIFY_LANE=fabricated-value no longer exits 0 (exit=$S_EXIT)"
fi

# ===========================================================================
# CLAUSE 2 — and it refuses OUT LOUD, as a harness error, naming the variable
# and the shape expected. A bare non-zero would leave the operator unable to
# tell a polluted environment from a genuine regression — the #722 lesson
# ("I could not parse the output" and "the subject regressed" are different
# defects with different owners).
# ===========================================================================
if [ "$S_EXIT" -ne 3 ]; then
  fail "(2) fabricated marker exited $S_EXIT, not 3 — a polluted environment must be a HARNESS-ERROR, distinct from a clause failure"
elif ! printf '%s' "$S_OUT" | rg -qF -- 'MGVL_IN_VERIFY_LANE'; then
  fail "(2) refused but never names the variable that caused it"
elif ! printf '%s' "$S_OUT" | rg -qF -- 'fabricated-value'; then
  fail "(2) refused but never quotes the offending value the operator must go find"
elif ! printf '%s' "$S_OUT" | rg -qF -- 'pr-'; then
  fail "(2) refused but never states the pr-<n> shape it required"
else
  pass "(2) fabricated marker is a HARNESS-ERROR (exit 3) naming the variable, the value, and the expected shape"
fi

# ===========================================================================
# CLAUSE 3 — the ANTI-GUESS clause. A shape-valid marker with no corroborating
# ancestry must still be refused. Without this, the "validation" is a password
# printed in the source: anyone (or any stale export) spelling `pr-1` gets the
# same free pass the old guard gave to `fabricated-value`.
# ===========================================================================
run_subject "pr-999" ""
if [ "$S_EXIT" -eq 0 ]; then
  fail "(3) a shape-valid marker with EMPTY ancestry exited 0 — the guard checks spelling, not provenance; pr-<n> is now the new magic word"
elif [ "$S_EXIT" -ne 3 ]; then
  fail "(3) shape-valid-but-uncorroborated marker exited $S_EXIT, not 3 — it is the same polluted-environment class as clause 2"
elif ! printf '%s' "$S_OUT" | rg -qF -- 'MGVL_VERIFY_LANE_PRS'; then
  fail "(3) refused but never names the ancestry variable that failed to corroborate it"
else
  pass "(3) shape-valid marker with no matching ancestry is refused (exit 3), naming the ancestry variable"
fi

# ===========================================================================
# CLAUSE 4 — POSITIVE CONTROL. A genuine nested run — the exact pair
# verify-lane.ts:479-480 exports together — must still skip politely rather
# than recursing. A guard that refuses everything is not a fix; it just moves
# the 331-worktree recursion into a permanent refusal.
# ===========================================================================
run_subject "pr-4242" "4242"
if [ "$S_EXIT" -eq 3 ]; then
  fail "(4) a GENUINE nested pair was refused as a harness error (exit 3) — the guard now blocks the legitimate nested run it exists to permit"
elif ! printf '%s' "$S_OUT" | rg -qF -- 'SKIP-BY-GUARD'; then
  fail "(4) genuine nested pair did not report SKIP-BY-GUARD (exit=$S_EXIT) — it either recursed or failed for another reason"
elif ! printf '%s' "$S_OUT" | rg -qF -- 'pr-4242'; then
  fail "(4) skipped but never echoes the marker it honoured"
else
  pass "(4) genuine nested pair (pr-4242 + ancestry 4242) skips politely without recursing"
fi

# ===========================================================================
# CLAUSE 5 — A SKIP IS NOT A PASS. Same run as clause 4. The exit status must
# distinguish "all clauses passed" from "passed with the live clause skipped",
# and the summary must SAY the live clause is unproven — the convention
# issue-resolution-artifacts.sh already follows in this same directory.
# ===========================================================================
if [ "$S_EXIT" -eq 0 ]; then
  fail "(5) a run whose live clause was SKIPPED still exits 0 — indistinguishable from a run that genuinely exercised verify-lane, which is the #721 defect surviving in its second form"
elif ! printf '%s' "$S_OUT" | rg -qi -e 'skipped is not passed|unproven'; then
  fail "(5) exit=$S_EXIT but the summary never says the skipped live clause leaves verify-lane unproven this run"
elif ! printf '%s' "$S_OUT" | rg -q -e 'CLAUSE 9 .*: *SKIP'; then
  fail "(5) clause 9 is not recorded with a SKIP verdict — a distinct verdict is what stops a skip reading as a pass"
else
  pass "(5) skipped live clause exits non-zero ($S_EXIT) and the summary states verify-lane is unproven this run"
fi

# ===========================================================================
# CLAUSE 6 — the PASS verdict is structurally unreachable for a skip. Asserted
# on the SOURCE because clauses 1-5 can only sample the paths they run: a
# lingering `record 9 PASS "SKIP-...` on some other branch would be invisible
# to them and would reintroduce the exact defect.
# ===========================================================================
if rg -q -e 'record +9 +PASS +"SKIP' "$SUBJECT"; then
  fail "(6) the subject still records clause 9 PASS on a SKIP path — the skip-reported-as-pass defect is live in the source"
else
  pass "(6) no 'record 9 PASS \"SKIP...' remains in the subject — a skip cannot be recorded as a pass"
fi

# ===========================================================================
# CLAUSE 7 — SIBLING SWEEP. #721 named ONE clause; the audit's lesson is that
# the family reproduces through new surfaces, so fix the PATTERN.
#
# MGVL_LIVE_PR is the file's other inherited variable that steers the live
# clause — it chooses the clause's SUBJECT. Pre-fix it was announced but never
# validated, so a stale export sent the live proof at an arbitrary PR, and the
# file's own comments warn that pointing it at the PR containing this check is
# the measured 331-worktree recursion. An announcement is not a check.
# ===========================================================================
SWEEP_OK=1
if ! rg -q -e 'MGVL_LIVE_PR' "$SUBJECT"; then
  fail "(7) MGVL_LIVE_PR no longer appears in the subject — this clause has lost its subject and must be re-aimed, not deleted"
  SWEEP_OK=0
else
  # NOTE, self-caught while writing this clause and recorded rather than
  # quietly corrected: the first spelling was
  #   rg -q -e 'MGVL_LIVE_PR' -A 12 "$SUBJECT" | rg -q '\[0-9\]'
  # which ALWAYS reports the defect, because `-q` makes ripgrep exit on the
  # first match and print NOTHING — the second rg reads an empty stream. It
  # produced a confident, specific, FALSE claim ("used without any numeric
  # validation") against a subject that had just been fixed. Round 30's family:
  # a broken query is indistinguishable from a real finding, and it pointed at
  # the alarming direction. `-q` never feeds a pipe.
  SWEEP_WINDOW="$(rg -e 'MGVL_LIVE_PR' -A 12 "$SUBJECT")"

  # POSITIVE CONTROL for the window itself, so a malformed extraction fails
  # loudly instead of silently confirming an absence (round 30's rule for any
  # check whose verdict authorises a conclusion).
  if ! printf '%s' "$SWEEP_WINDOW" | rg -qF -- 'MGVL_LIVE_PR'; then
    fail "(7) the sweep window is empty or malformed — this clause cannot see its subject, which is a broken query, NOT evidence the validation is missing"
    SWEEP_OK=0
  else
    # It must be validated as a number, not merely interpolated into a message.
    if ! printf '%s' "$SWEEP_WINDOW" | rg -q -e '\[0-9\]\+|\[\[:digit:\]\]'; then
      fail "(7) MGVL_LIVE_PR is used without any numeric validation — an inherited non-numeric value reaches gh unchecked"
      SWEEP_OK=0
    fi
    # ... and self-targeting must be REFUSED, not merely warned about. The
    # pre-#721 file already "announced loudly" that the operator must not point
    # this at its own PR; an announcement is not a check.
    if ! printf '%s' "$SWEEP_WINDOW" | rg -qi -e 'fail_hard'; then
      fail "(7) nothing REFUSES an MGVL_LIVE_PR that names the PR containing this check — the measured 331-worktree recursion stays reachable by an inherited value, with only a printed warning in front of it"
      SWEEP_OK=0
    fi
  fi
fi
[ "$SWEEP_OK" -eq 1 ] && pass "(7) MGVL_LIVE_PR is validated (numeric, and refused when it self-targets), not merely announced"

printf '\n'
if [ "$FAILURES" -eq 0 ]; then
  printf '=== RESULT: PASS — the verify-lane skip guard is EARNED (structured marker corroborated by ancestry), a skip is recorded as SKIP and never PASS, a skipped live clause does not exit 0, a genuine nested run still skips politely, and the sibling MGVL_LIVE_PR surface is validated rather than trusted ===\n'
  exit 0
fi
printf '=== RESULT: FAIL (%d failing clause(s)) ===\n' "$FAILURES"
exit 1
