#!/usr/bin/env bash
# DONE-MEANS check for issue #722 — "both pre-push done-means checks (705, 712)
# are RED on untouched main: unpinned fixture core.hooksPath trips #711's
# assertion, misreported as substantive regressions".
#
#   bash scripts/done-means/722-fixture-hookspath-pinned.sh
#
# EXISTING DESIGN THIS EXTENDS (lookup before writing, per the repo's gate):
# `docs/lane-contract.md` already requires hermetic, red-first fixtures with a
# mutation clause, and 709/711/714 already demonstrate the pinning pattern.
# The delta this adds is that the FIXTURE ENVIRONMENT is itself a subject: a
# fixture that inherits ambient git config is not hermetic, and a check blinded
# that way must be unable to report a verdict about its subject.
#
# ---------------------------------------------------------------------------
# THE DEFECT THIS GATES
# ---------------------------------------------------------------------------
# `705-pre-push-base-selection.sh` and `712-pre-push-pipe-safe.sh` build
# throwaway git repositories with a bare `git init`, which sets no
# `core.hooksPath`. Git then falls back to the operator's GLOBAL value, so the
# fixture is not hermetic: on this machine it inherited
# `/Users/rico/.config/git/hooks`.
#
# #711 later added an assertion to `_githooks/pre-push` that REFUSES any
# `core.hooksPath` other than `_githooks`, and that assertion runs BEFORE the
# `--explain` early exit. So every fixture invocation of the shipped hook died
# at the hooksPath check and printed the #711 refusal, and each clause parsed
# that refusal as if it were the hook's decision output. Measured on the
# untouched branch tip `afc5525`, clean tree:
#
#   705 -> 5 of 6 clauses FAIL (only (e) passes; it reads the hook's SOURCE
#          structurally and never invokes it)
#   712 -> 6 of 6 clauses FAIL
#
# The red is not the danger. THE FALSE TEXT IS. Both checks kept emitting their
# original, now-untrue, regression claims while blinded:
#
#   705 (b): "a real python/openbrain edit was NOT detected ... the packages
#            are no longer separately gated"
#   712 (f): "the runner's STDERR is still attached to a pipe -- redirecting
#            stdout alone does not fix #712"
#
# Neither fix is broken; the audit proved both intact by adding the one missing
# `git config core.hooksPath _githooks` line. A check that says "the subject
# regressed" when it means "I could not reach the subject" is how a genuine
# #705 regression later gets waved through as "that one's always red".
#
# ---------------------------------------------------------------------------
# WHY THE RE-BLIND CLAUSE IS THE LOAD-BEARING ONE
# ---------------------------------------------------------------------------
# Clause (a) alone -- "both checks are green" -- would be satisfied by a fix
# that pinned the fixture and changed nothing about the reporting. That leaves
# the whole defect that mattered live: the next unrelated invariant added to the
# hook re-blinds both checks, and they go back to lying about their subject.
#
# So clause (b) reconstructs the defect DELIBERATELY. Each check is copied with
# its pin line removed, and the copy is run. The copy must:
#   - fail (a blinded check must never be green), AND
#   - name the BLIND -- the refusal it actually hit -- in its output, AND
#   - NOT emit the original regression text for the subject it never reached.
#
# The third condition is the one the pre-fix code violates, and it is asserted
# on the EXACT strings the pre-fix code printed, so this clause is a genuine
# mutation test rather than a restatement of clause (a).
#
# The copies are made by deleting the line carrying a marker the fix OWNS
# (`DM722-PIN`), not by regex-mangling arbitrary source. If the marker is absent
# the edit would be a silent no-op and the whole mutation would prove nothing,
# so that case is HARNESS-ERROR, never a pass.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) BOTH CHECKS ARE GREEN on the current tree. The RED->GREEN half.
#
#   (b) DELIBERATE RE-BLIND -- THE MUTATION. With the pin removed, each check
#       must fail, must name the blind, and must NOT print its original
#       regression text. This is the clause a pin-only fix fails.
#
#   (c) THE GUARD CLASSIFIES IT AS A HARNESS ERROR, NOT A FAILURE. A blinded
#       fixture says nothing about the subject, so the correct exit is 3 (this
#       repo's harness-error convention), never 1. Exit 1 from a blinded check
#       is a verdict about #705/#712 that the run did not earn.
#
#   (d) INVENTORY. Every done-means check that builds a git fixture pins
#       `core.hooksPath` to an explicit value. Two correct answers exist and
#       both count: pin to `_githooks` when the hook IS the subject (705, 712),
#       or neutralise by pinning at a hooks-free directory when it is not (709,
#       714). 711 pins per-invocation with `git -c` because the value itself is
#       its subject. What is refused is INHERITANCE -- no pin at all. Carries a
#       positive control on its own scan (round 30): a query that matches almost
#       nothing is a broken query, not a clean repo.
#
# Exit 0 only when every clause passes. Exit 3 is a harness error, which is NOT
# a failure of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DM_DIR="$REPO_ROOT/scripts/done-means"
RUN_ID="722-$$-$(date +%s)"
SCRATCH="${OPENBRAIN_TEMP_WORKSPACE:-/Volumes/ThunderBolt/_tmp}/open-brain/_scratch/$RUN_ID"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v git >/dev/null 2>&1 || fail_hard "git not on PATH"
command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
mkdir -p "$SCRATCH" || fail_hard "cannot create scratch dir $SCRATCH"

CHECK_705="$DM_DIR/705-pre-push-base-selection.sh"
CHECK_712="$DM_DIR/712-pre-push-pipe-safe.sh"
PIN_MARKER="DM722-PIN"

[ -r "$CHECK_705" ] || fail_hard "705 check not readable at $CHECK_705"
[ -r "$CHECK_712" ] || fail_hard "712 check not readable at $CHECK_712"

CLAUSES=()
record() { CLAUSES+=("$1|$2|$3"); }

RC_OUT=""
RC_EXIT=0
run_check() {
  RC_OUT="$(cd "$REPO_ROOT" && bash "$1" 2>&1)"
  RC_EXIT=$?
}

clause_lines() { printf '%s\n' "$1" | rg '^CLAUSE ' || true; }

# ---------------------------------------------------------------------------
# (a) both checks are GREEN on the current tree
# ---------------------------------------------------------------------------
A_FAILS=()

run_check "$CHECK_705"
A705_OUT="$RC_OUT"; A705_EXIT="$RC_EXIT"
[ "$A705_EXIT" = "0" ] \
  || A_FAILS+=("705 is not green (exit=$A705_EXIT): $(clause_lines "$A705_OUT" | rg 'FAIL' | tr '\n' ' ' | cut -c1-300)")

run_check "$CHECK_712"
A712_OUT="$RC_OUT"; A712_EXIT="$RC_EXIT"
[ "$A712_EXIT" = "0" ] \
  || A_FAILS+=("712 is not green (exit=$A712_EXIT): $(clause_lines "$A712_OUT" | rg 'FAIL' | tr '\n' ' ' | cut -c1-300)")

if [ "${#A_FAILS[@]}" -eq 0 ]; then
  record a PASS "705 exit=0 ($(clause_lines "$A705_OUT" | wc -l | tr -d ' ') clauses) and 712 exit=0 ($(clause_lines "$A712_OUT" | wc -l | tr -d ' ') clauses) on this tree"
else
  record a FAIL "$(printf '%s; ' "${A_FAILS[@]}")"
fi

# ---------------------------------------------------------------------------
# (b) + (c) deliberate re-blind
# ---------------------------------------------------------------------------
# The copies MUST live in scripts/done-means/, because each check computes its
# REPO_ROOT as "<its own dir>/../..". A copy in scratch would resolve REPO_ROOT
# to a directory with no _githooks/ and fail_hard for the WRONG reason -- the
# false-RED family (lane-contract rounds 18/22/23). They are dot-prefixed with
# this run id and moved to scratch by an EXIT trap.
BLIND_705="$DM_DIR/.dm722-blind-705-$RUN_ID.sh"
BLIND_712="$DM_DIR/.dm722-blind-712-$RUN_ID.sh"

cleanup_blinds() {
  for f in "$BLIND_705" "$BLIND_712"; do
    [ -e "$f" ] && mv "$f" "$SCRATCH/$(basename "$f")" 2>/dev/null
  done
  return 0
}
trap cleanup_blinds EXIT

make_blind() {
  local src="$1" dst="$2" removed
  removed="$(rg -c -- "$PIN_MARKER" "$src" 2>/dev/null || printf '0')"
  [ "${removed:-0}" -ge 1 ] || return 1
  rg -v -- "$PIN_MARKER" "$src" > "$dst" || return 1
  chmod +x "$dst" || return 1
  printf '%s' "$removed"
  return 0
}

R705="$(make_blind "$CHECK_705" "$BLIND_705")" \
  || fail_hard "could not re-blind 705: no '$PIN_MARKER' line found. The fix must mark its pin with that marker so this clause can remove it; without it the mutation is a silent no-op and clause (b) would prove nothing."
R712="$(make_blind "$CHECK_712" "$BLIND_712")" \
  || fail_hard "could not re-blind 712: no '$PIN_MARKER' line found. The fix must mark its pin with that marker so this clause can remove it; without it the mutation is a silent no-op and clause (b) would prove nothing."

# The ambient value a blinded fixture inherits. If it already IS `_githooks`,
# or is unset, removing the pin cannot reproduce the blind -- say so rather
# than passing on an unreproduced mutation.
AMBIENT="$(git config --global --get core.hooksPath 2>/dev/null || true)"
[ -n "$AMBIENT" ] || AMBIENT="$(git config --system --get core.hooksPath 2>/dev/null || true)"

# The original regression text each check printed WHILE BLINDED. A blinded run
# must not print these: they are claims about a subject it never reached.
FALSE_705="the packages are no longer separately gated"
FALSE_712="redirecting stdout alone does not fix #712"

B_FAILS=()
C_FAILS=()

if [ -z "$AMBIENT" ] || [ "$AMBIENT" = "_githooks" ]; then
  B_FAILS+=("the ambient core.hooksPath is '${AMBIENT:-<unset>}', so removing the pin cannot reproduce the blind -- this clause would prove nothing and is reported as unproven rather than passed")
  C_FAILS+=("same: no reproducible blind available (ambient core.hooksPath='${AMBIENT:-<unset>}')")
else
  run_check "$BLIND_705"
  B705_OUT="$RC_OUT"; B705_EXIT="$RC_EXIT"
  run_check "$BLIND_712"
  B712_OUT="$RC_OUT"; B712_EXIT="$RC_EXIT"

  [ "$B705_EXIT" != "0" ] \
    || B_FAILS+=("a BLINDED 705 reported success (exit=0) -- a check that cannot reach its subject must never be green")
  [ "$B712_EXIT" != "0" ] \
    || B_FAILS+=("a BLINDED 712 reported success (exit=0) -- a check that cannot reach its subject must never be green")

  printf '%s' "$B705_OUT" | rg -qF -- "core.hooksPath" \
    || B_FAILS+=("a BLINDED 705 did not name core.hooksPath as the blind: $(printf '%s' "$B705_OUT" | tr '\n' ' ' | cut -c1-200)")
  printf '%s' "$B712_OUT" | rg -qF -- "core.hooksPath" \
    || B_FAILS+=("a BLINDED 712 did not name core.hooksPath as the blind: $(printf '%s' "$B712_OUT" | tr '\n' ' ' | cut -c1-200)")

  if printf '%s' "$B705_OUT" | rg -qF -- "$FALSE_705"; then
    B_FAILS+=("a BLINDED 705 still claims '$FALSE_705' -- a parse failure masquerading as a #705 regression")
  fi
  if printf '%s' "$B712_OUT" | rg -qF -- "$FALSE_712"; then
    B_FAILS+=("a BLINDED 712 still claims '$FALSE_712' -- a parse failure masquerading as a #712 regression")
  fi

  [ "$B705_EXIT" = "3" ] \
    || C_FAILS+=("a BLINDED 705 exited $B705_EXIT, not 3 -- exit 1 is a verdict about #705 that a blinded run did not earn")
  [ "$B712_EXIT" = "3" ] \
    || C_FAILS+=("a BLINDED 712 exited $B712_EXIT, not 3 -- exit 1 is a verdict about #712 that a blinded run did not earn")
fi

if [ "${#B_FAILS[@]}" -eq 0 ]; then
  record b PASS "with the pin removed (705: $R705 line(s), 712: $R712 line(s); ambient core.hooksPath='$AMBIENT') both checks fail, both name core.hooksPath, and neither emits its original regression text"
else
  record b FAIL "$(printf '%s; ' "${B_FAILS[@]}")"
fi

if [ "${#C_FAILS[@]}" -eq 0 ]; then
  record c PASS "a blinded run exits 3 (HARNESS-ERROR) in both checks -- the blind is classified as a harness problem, not as a failure of the subject"
else
  record c FAIL "$(printf '%s; ' "${C_FAILS[@]}")"
fi

# ---------------------------------------------------------------------------
# (d) inventory -- no git fixture inherits core.hooksPath
# ---------------------------------------------------------------------------
#
# "Builds a git fixture" means a git SUBCOMMAND invocation of `init` or
# `clone` -- `git`, optional `-C <dir>` / `-c k=v` flags, then the subcommand.
#
# The first spelling of this scan was `git .*\binit\b|git .*\bclone\b`, and it
# was wrong in exactly the round-30 way. It matched the ENGLISH word "clone"
# inside a message string --
#   "git does NOT track it -- a fresh clone gets no tracking scribe"
# -- and reported `tracking-scribe-root-only.sh` and `verifier-agent-grounded.sh`
# as unpinned git fixtures. Neither runs `git init` or `git clone` at all. The
# wrong answer named real files and a real-sounding defect, which is the whole
# hazard: a plausible wrong answer, never an error. Anchored on the invocation
# shape instead. The `D_CHECKED` floor below is the positive control that keeps
# the opposite failure (a pattern so tight it matches nothing) loud --
# `docs/sme/gotcha-agent.md` requires exactly that on a one-directional scan.
D_UNPINNED=()
D_CHECKED=0
GIT_FIXTURE_RE='(^|[;&|(]|[[:space:]])git[[:space:]]+(-[Cc][[:space:]]*[^[:space:]]+[[:space:]]+)*(init|clone)([[:space:]]|$)'
while IFS= read -r f; do
  [ -n "$f" ] || continue
  rg -q -- "$GIT_FIXTURE_RE" "$f" || continue
  D_CHECKED=$((D_CHECKED + 1))
  rg -q 'core\.hooksPath' "$f" || D_UNPINNED+=("$(basename "$f")")
done < <(fd -e sh . "$DM_DIR" 2>/dev/null | rg -v '\.dm722-blind-')

if [ "$D_CHECKED" -lt 5 ]; then
  # Positive control on the scan itself (round 30): a one-directional check
  # cannot tell "absent" from "my query was broken". 705, 709, 711, 712 and 714
  # all build git fixtures, so fewer than five matches means the scan broke.
  record d FAIL "the fixture inventory matched only $D_CHECKED check(s) -- the scan is broken, not the repo clean; at least 705, 709, 711, 712 and 714 build git fixtures"
elif [ "${#D_UNPINNED[@]}" -eq 0 ]; then
  record d PASS "all $D_CHECKED done-means checks that build a git fixture pin core.hooksPath explicitly (pinned to _githooks where the hook IS the subject; neutralised where it is not)"
else
  record d FAIL "these checks build a git fixture and inherit core.hooksPath: $(printf '%s ' "${D_UNPINNED[@]}")-- #711's assertion will blind every hook invocation inside them"
fi

# ---------------------------------------------------------------------------
# Teardown. Scratch is MOVED to the archive, never deleted (AGENTS.md: the
# agent's cleanup verb is mv). The blinded copies were moved out of
# scripts/done-means/ by the EXIT trap.
# ---------------------------------------------------------------------------
cleanup_blinds
ARCHIVE_DIR="${OPENBRAIN_TEMP_WORKSPACE:-/Volumes/ThunderBolt/_tmp}/open-brain/_archive"
if mkdir -p "$ARCHIVE_DIR" 2>/dev/null; then
  mv "$SCRATCH" "$ARCHIVE_DIR/$RUN_ID" 2>/dev/null \
    || printf 'TEARDOWN-WARNING: scratch left at %s\n' "$SCRATCH" >&2
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
label_for() {
  case "$1" in
    a) printf 'both pre-push done-means checks are GREEN on this tree' ;;
    b) printf 'MUTANT: a re-blinded check fails, names the BLIND, and drops the false regression text' ;;
    c) printf 'a blinded run exits 3 (HARNESS-ERROR), never 1' ;;
    d) printf 'no done-means git fixture inherits core.hooksPath' ;;
  esac
}

ALL_PASS=1
for entry in "${CLAUSES[@]}"; do
  id="${entry%%|*}"
  rest="${entry#*|}"
  status="${rest%%|*}"
  evidence="${rest#*|}"
  printf 'CLAUSE %s (%s): %s — %s\n' "$id" "$(label_for "$id")" "$status" "$evidence"
  [ "$status" = PASS ] || ALL_PASS=0
done

[ "$ALL_PASS" -eq 1 ] && exit 0
exit 1
