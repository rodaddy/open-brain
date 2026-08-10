#!/usr/bin/env bash
# DONE-MEANS check for issue #711 — core.hooksPath must be the RELATIVE value
# the installer writes, so each worktree runs its OWN hooks, and the divergence
# must be DETECTED rather than left to be discovered by a confused lane.
#
#   bash scripts/done-means/711-hookspath-relative.sh
#
# ---------------------------------------------------------------------------
# THE DEFECT THIS GATES
# ---------------------------------------------------------------------------
# This clone's `.git/config` held the ABSOLUTE value
# `/Volumes/ThunderBolt/Development/open-brain/_githooks`, while
# `_githooks/install.sh:24-40` writes the RELATIVE `_githooks`. `.git/config` is
# SHARED by every linked worktree, so an absolute value points every lane
# worktree at the PRIMARY CHECKOUT's hooks — the copy sitting on the base
# branch, not the copy the lane is changing.
#
# Measured live on this repo before the fix (throwaway worktree, distinct marker
# line planted in each tree's `_githooks/pre-push`, `git hook run pre-push`):
#
#   absolute config, run from the worktree  -> MARKER: PRIMARY-COPY   <-- defect
#   relative config, run from the worktree  -> MARKER: WORKTREE-COPY  <-- fixed
#   relative config, run from the primary   -> MARKER: PRIMARY-COPY   <-- control
#
# That is the red/green, and clause (a) below reproduces it hermetically rather
# than citing the measurement.
#
# ---------------------------------------------------------------------------
# WHY THIS IS THE ROOT OF THE #705-#714 FAMILY
# ---------------------------------------------------------------------------
# docs/lane-contract.md round 28 named three instances of ONE family: a gate
# resolving its base or its tree from something other than the change under
# review. This is the structural one — a lane fixing a git hook CANNOT EXERCISE
# ITS OWN FIX on push, because git runs the base branch's copy. The observable
# symptoms both point the wrong way:
#
#   - a lane that FIXES a broken pre-push still fails, and reads it as its fix
#     not working;
#   - a lane that BREAKS pre-push pushes green, and the breakage lands.
#
# PR #708 worked around it by hand with `-c core.hooksPath=<worktree>/_githooks`,
# which is a workaround a lane has to already know to reach for.
#
# ---------------------------------------------------------------------------
# WHAT IS AND IS NOT THE PR PAYLOAD
# ---------------------------------------------------------------------------
# `core.hooksPath` lives in `.git/config`, which is PER-CLONE STATE and is not a
# committed file. So the config flip itself cannot be shipped and cannot be
# asserted on in CI against a fresh clone. The shipped payload is the DETECTION
# MECHANISM: `_githooks/pre-push` asserts, in its first lines, that the
# effective `core.hooksPath` equals what the installer writes, and refuses with
# the exact `./_githooks/install.sh` command when it does not.
#
# Clause (e) is therefore the only clause that inspects THIS machine's live
# config; it is reported separately and is an ENVIRONMENT verdict. Every other
# clause runs against a hermetic throwaway repo and holds on any machine,
# including CI.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) THE DEFECT, REPRODUCED. In a throwaway repo with a linked worktree and
#       a DIFFERENT marker hook in each tree, an ABSOLUTE `core.hooksPath` makes
#       the worktree run the PRIMARY's hook, and the installer's RELATIVE value
#       makes it run its OWN. This is the behavioural claim the whole fix rests
#       on; if git ever stopped resolving a relative hooksPath per-worktree, the
#       fix would be wrong and this clause would say so.
#
#   (b) THE DETECTOR FIRES. `_githooks/pre-push` run under an ABSOLUTE
#       `core.hooksPath` REFUSES, non-zero, before doing any validation work.
#       RED pre-fix: the hook had no such assertion and proceeded to typecheck.
#
#   (c) THE REFUSAL IS ACTIONABLE. That refusal names `core.hooksPath`, prints
#       the offending value AND the expected one, and gives the literal
#       `_githooks/install.sh` command. A gate that refuses without saying how
#       to clear it is the condition that makes `--no-verify` habitual.
#
#   (d) CONTROL — THE DETECTOR DOES NOT FIRE ON THE GOOD VALUE. Under the
#       installer's relative value the assertion passes and the hook proceeds
#       past it. Without this, "fixing" #711 with an assertion that always
#       refuses would pass (b) and (c) and destroy the gate. This is the
#       mutation-relevant half.
#
#   (e) ENVIRONMENT — this machine's live `core.hooksPath` is the installer's
#       value. Reported as a separate ENV verdict, because it is per-clone state
#       and a fresh clone legitimately has none set at all.
#
# Exit 0 only when clauses (a)-(d) pass. Clause (e) is reported and, when this
# is a clone that HAS a hooksPath set at all, is also enforced. Exit 3 is a
# harness error (missing tool, unusable scratch), which is NOT a failure of the
# thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$REPO_ROOT/_githooks/pre-push"
INSTALLER="$REPO_ROOT/_githooks/install.sh"
RUN_ID="711-$$-$(date +%s)"
SCRATCH="${OPENBRAIN_TEMP_WORKSPACE:-/Volumes/ThunderBolt/_tmp}/open-brain/_scratch/$RUN_ID"

# The value the installer writes. Read FROM the installer rather than repeated
# here: a check that hardcodes its own copy of the expected value cannot catch
# the installer changing, which is half of what "config diverged from its own
# installer" means.
EXPECTED="$(sed -n 's/^target="\(.*\)"$/\1/p' "$INSTALLER" 2>/dev/null | head -1)"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v git >/dev/null 2>&1 || fail_hard "git not on PATH"
[ -r "$HOOK" ] || fail_hard "pre-push not readable at $HOOK"
[ -r "$INSTALLER" ] || fail_hard "installer not readable at $INSTALLER"
[ -n "$EXPECTED" ] || fail_hard "could not read the target value out of $INSTALLER (expected a target=\"...\" line)"
mkdir -p "$SCRATCH" || fail_hard "cannot create scratch dir $SCRATCH"

CLAUSES=()
record() { CLAUSES+=("$1|$2|$3"); }

# ---------------------------------------------------------------------------
# Fixture for clause (a): a throwaway repo with a linked worktree, and a hook
# in each tree that prints WHICH TREE IT IS. Hermetic — it does not touch this
# repo, so it cannot be perturbed by, and cannot perturb, the live checkout.
# ---------------------------------------------------------------------------
FIX="$SCRATCH/fixture"
mkdir -p "$FIX/primary" || fail_hard "cannot create fixture dir"
git -C "$FIX/primary" init -q -b main 2>/dev/null || fail_hard "git init failed"
git -C "$FIX/primary" config user.name "done-means-711" || fail_hard "git config failed"
git -C "$FIX/primary" config user.email "done-means-711@invalid" || fail_hard "git config failed"
mkdir -p "$FIX/primary/_githooks"
printf '#!/bin/sh\necho "MARKER: PRIMARY-COPY"\nexit 0\n' > "$FIX/primary/_githooks/pre-push"
chmod +x "$FIX/primary/_githooks/pre-push"
git -C "$FIX/primary" add -A >/dev/null 2>&1
git -C "$FIX/primary" commit -q -m "fixture base" >/dev/null 2>&1 || fail_hard "fixture commit failed"

FIX_WT="$FIX/worktree"
git -C "$FIX/primary" worktree add --detach --quiet "$FIX_WT" HEAD 2>"$SCRATCH/wt.err" \
  || fail_hard "fixture worktree failed: $(cat "$SCRATCH/wt.err")"
printf '#!/bin/sh\necho "MARKER: WORKTREE-COPY"\nexit 0\n' > "$FIX_WT/_githooks/pre-push"
chmod +x "$FIX_WT/_githooks/pre-push"

# `git hook run` executes the hook git itself would execute, resolving
# core.hooksPath exactly as a real push does. It is the shipped resolution, not
# a reimplementation of it.
ABS_OUT="$(git -C "$FIX_WT" -c core.hooksPath="$FIX/primary/_githooks" hook run pre-push 2>&1)"
REL_OUT="$(git -C "$FIX_WT" -c core.hooksPath="$EXPECTED" hook run pre-push 2>&1)"
CTL_OUT="$(git -C "$FIX/primary" -c core.hooksPath="$EXPECTED" hook run pre-push 2>&1)"

if printf '%s' "$ABS_OUT" | grep -q "PRIMARY-COPY" \
  && printf '%s' "$REL_OUT" | grep -q "WORKTREE-COPY" \
  && printf '%s' "$CTL_OUT" | grep -q "PRIMARY-COPY"; then
  record a PASS "absolute -> worktree ran the PRIMARY's hook; relative ($EXPECTED) -> worktree ran its OWN; primary unchanged"
else
  record a FAIL "hooksPath resolution did not behave as the fix assumes — absolute=[$(printf '%s' "$ABS_OUT" | tr '\n' ' ')] relative=[$(printf '%s' "$REL_OUT" | tr '\n' ' ')] control=[$(printf '%s' "$CTL_OUT" | tr '\n' ' ')]"
fi

git -C "$FIX/primary" worktree remove --force "$FIX_WT" >/dev/null 2>&1

# ---------------------------------------------------------------------------
# Clauses (b), (c), (d): drive the SHIPPED `_githooks/pre-push` with a
# core.hooksPath that is wrong, and with one that is right.
#
# The hook is invoked with `--explain`, which is its own existing seam for
# exercising decision logic without the multi-minute typecheck/test phases. The
# drift assertion runs BEFORE that early exit, so `--explain` reaches it — which
# is asserted by clause (d) observing the hook proceed past it.
#
# The value is delivered through the environment rather than `git -c` because a
# `-c` override is not written into `.git/config` and the hook reads its
# effective value with `git config`; either delivery reaches the same
# `git config --get core.hooksPath` the assertion calls. `git -c` is used here
# so nothing writes to any real config.
# ---------------------------------------------------------------------------

# run_hook <hooksPath-value> — run the shipped hook in THIS repo with the given
# effective core.hooksPath, capturing output and exit code.
run_hook() {
  HOOK_OUTPUT="$(cd "$REPO_ROOT" && git -c core.hooksPath="$1" \
    hook run pre-push -- --explain 2>&1)"
  HOOK_EXIT=$?
}

# --- (b) the detector fires on an absolute value ---------------------------
ABSOLUTE_VALUE="$REPO_ROOT/_githooks"
run_hook "$ABSOLUTE_VALUE"
B_OUTPUT="$HOOK_OUTPUT"
B_EXIT=$HOOK_EXIT
if [ "$B_EXIT" -ne 0 ]; then
  record b PASS "absolute core.hooksPath refused by the hook (exit=$B_EXIT)"
else
  record b FAIL "absolute core.hooksPath was ACCEPTED (exit=0) — nothing detects the drift: $(printf '%s' "$B_OUTPUT" | tr '\n' ' ' | cut -c1-400)"
fi

# --- (c) the refusal is actionable -----------------------------------------
# Anchored on three separate things the refusal must carry: the setting's name,
# the expected value, and the literal command that clears it. A refusal that
# names only the problem leaves the reader to guess the remedy.
C_MISSING=""
printf '%s' "$B_OUTPUT" | grep -q "core.hooksPath" || C_MISSING="$C_MISSING setting-name"
printf '%s' "$B_OUTPUT" | grep -qF "$ABSOLUTE_VALUE" || C_MISSING="$C_MISSING offending-value"
printf '%s' "$B_OUTPUT" | grep -qF "$EXPECTED" || C_MISSING="$C_MISSING expected-value"
printf '%s' "$B_OUTPUT" | grep -qF "_githooks/install.sh" || C_MISSING="$C_MISSING install-command"
if [ -z "$C_MISSING" ]; then
  record c PASS "refusal names core.hooksPath, the offending value, the expected value, and the install.sh command"
else
  record c FAIL "refusal is missing:$C_MISSING — output: $(printf '%s' "$B_OUTPUT" | tr '\n' ' ' | cut -c1-400)"
fi

# --- (d) control: the good value is not refused ----------------------------
run_hook "$EXPECTED"
D_OUTPUT="$HOOK_OUTPUT"
D_EXIT=$HOOK_EXIT
# The hook must both exit 0 AND be observed to have gone PAST the assertion —
# an early exit 0 before reaching it would pass a bare exit-code check while
# proving nothing about the assertion's placement. `base_ref=` is emitted by
# the `--explain` path, which is downstream of where the assertion sits.
if [ "$D_EXIT" -eq 0 ] && printf '%s' "$D_OUTPUT" | grep -q "base_ref="; then
  record d PASS "installer's value ($EXPECTED) passed the assertion and the hook proceeded to its --explain output (exit=0)"
elif [ "$D_EXIT" -ne 0 ]; then
  record d FAIL "the installer's own value was REFUSED (exit=$D_EXIT) — the assertion refuses everything: $(printf '%s' "$D_OUTPUT" | tr '\n' ' ' | cut -c1-400)"
else
  record d FAIL "hook exited 0 but never reached its --explain output; the assertion's position cannot be confirmed: $(printf '%s' "$D_OUTPUT" | tr '\n' ' ' | cut -c1-400)"
fi

# ---------------------------------------------------------------------------
# (e) ENVIRONMENT — this machine's live config.
#
# Separate from the pass/fail clauses above because `.git/config` is per-clone
# state: a fresh clone that has never run the installer has NO value set, which
# is not the #711 defect (git falls back to .git/hooks and the tracked hooks
# simply do not run — the #311 problem, not this one). What #711 forbids is a
# value that is set AND diverges from the installer's.
# ---------------------------------------------------------------------------
LIVE="$(git -C "$REPO_ROOT" config --local --get core.hooksPath 2>/dev/null || true)"
ENV_FAIL=0
if [ -z "$LIVE" ]; then
  printf 'CLAUSE e (live core.hooksPath matches the installer): ENV-SKIP — no local core.hooksPath is set in this clone; run ./_githooks/install.sh to install the tracked hooks.\n'
elif [ "$LIVE" = "$EXPECTED" ]; then
  printf 'CLAUSE e (live core.hooksPath matches the installer): PASS — local core.hooksPath is %s, matching the installer.\n' "$LIVE"
else
  printf 'CLAUSE e (live core.hooksPath matches the installer): FAIL — local core.hooksPath is %s, but the installer writes %s. Every linked worktree is running the primary checkout'"'"'s hooks. Fix: ./_githooks/install.sh\n' "$LIVE" "$EXPECTED"
  ENV_FAIL=1
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
label_for() {
  case "$1" in
    a) printf 'relative hooksPath resolves per-worktree; absolute does not' ;;
    b) printf 'the hook REFUSES an absolute/divergent core.hooksPath' ;;
    c) printf 'the refusal names the value, the expectation, and the fix command' ;;
    d) printf 'the installer'"'"'s own value is NOT refused (mutation control)' ;;
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

if [ "$ALL_PASS" -eq 1 ] && [ "$ENV_FAIL" -eq 0 ]; then
  exit 0
fi
exit 1
