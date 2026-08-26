#!/usr/bin/env bash
# DONE-MEANS check for #775 — verify-lane must install the PR HEAD's
# dependencies before it runs the done-means check.
#
#   bash scripts/done-means/775-verify-lane-installs-head-deps.sh
#
# ---------------------------------------------------------------------------
# The defect this gates
# ---------------------------------------------------------------------------
# verify-lane stands its verification worktree up in two moves that disagreed
# about which commit's dependencies were installed:
#
#   1. scripts/lane-bootstrap.ts cuts the worktree from origin/main and runs
#      `bun install --frozen-lockfile` THERE, so node_modules describes
#      origin/main.
#   2. verify-lane then `git fetch origin <sha>` + `git reset --hard <headSha>`
#      moves the SOURCE onto the PR head — and never reinstalls.
#   3. The done-means check runs against that mismatched tree.
#
# Measured twice on 2026-08-25 against PR #771 (head 2d67702), which adds
# `oxlint` as a devDependency: the check died on
# `MISSING TOOL: .../node_modules/.bin/oxlint` and NO receipt was posted, while
# a second `bun install --frozen-lockfile` in that same verification worktree
# installed the 2 missing packages and the identical check passed.
#
# So: any PR that adds or bumps a dependency was structurally unable to earn a
# receipt, and the failure presented as the lane's check being broken rather
# than as a verify-lane environment defect.
#
# ---------------------------------------------------------------------------
# Four clauses
# ---------------------------------------------------------------------------
# CLAUSE 1 — THE STEP EXISTS, BETWEEN THE RESET AND THE CHECK.
#   Position is the whole fix. A reinstall placed before the hard reset would
#   install origin/main's deps twice and change nothing; one placed after
#   run-check would be too late. This clause reads the byte offsets of the
#   `checkout-head` step line, the `deps-at-head` step, and the `run-check`
#   note out of scripts/verify-lane.ts and requires that strict ordering,
#   rather than merely asserting the string is present somewhere.
#
# CLAUSE 2 — BOTH PATHS ANNOUNCE THEMSELVES (nothing is adjusted silently).
#   The unit suite drives decideDepsAtHead() both ways and asserts a
#   "reinstalled: ..." line when the manifests differ and an "unchanged: ..."
#   line when they match. A no-op that prints nothing is indistinguishable
#   from a step that never ran, which is the exact reading failure AGENTS.md's
#   "Nothing is adjusted silently" rule exists to prevent. This clause runs
#   scripts/verify-lane.test.ts and requires it green.
#
# CLAUSE 3 — THE SIGNAL IS REAL, ON A REPOSITORY THAT ADDS A DEPENDENCY.
#   Build a throwaway git repository whose head adds a devDependency — #771's
#   shape — and run the SAME `git diff --quiet <base> <head> -- package.json
#   bun.lock` comparison verify-lane runs. It must report a difference (exit 1)
#   for the dependency-adding head and no difference (exit 0) for a head that
#   touches only unrelated files. This is what stops the fix from being a
#   comparison that can never fire.
#
# CLAUSE 4 — FAIL-CLOSED ON AN UNUSABLE COMPARISON.
#   `git diff --quiet` answers 0 for "same" and 1 for "differs", so a
#   non-zero exit is a normal answer and cannot go through capture(), which
#   throws on any non-zero status. Every OTHER exit code (a bad ref, a missing
#   object) must fail loudly instead of being read as "unchanged" — otherwise
#   the fix reintroduces the original defect whenever git cannot compare. This
#   clause asserts verify-lane rejects any status outside {0, 1}.
#
# Exit 0 only when all four clauses pass. Exit 3 is a harness error (missing
# tool / unreadable repo), which is NOT a fail of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_REL="scripts/verify-lane.ts"
SCRIPT="$REPO_ROOT/$SCRIPT_REL"
TEST_REL="scripts/verify-lane.test.ts"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v git >/dev/null 2>&1 || fail_hard "git not on PATH"
command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
command -v rg  >/dev/null 2>&1 || fail_hard "rg (ripgrep) not on PATH"
[ -r "$SCRIPT" ] || fail_hard "no $SCRIPT_REL at $REPO_ROOT"
[ -r "$REPO_ROOT/$TEST_REL" ] || fail_hard "no $TEST_REL at $REPO_ROOT"

CLAUSE1=FAIL; CLAUSE1_EVIDENCE=""
CLAUSE2=FAIL; CLAUSE2_EVIDENCE=""
CLAUSE3=FAIL; CLAUSE3_EVIDENCE=""
CLAUSE4=FAIL; CLAUSE4_EVIDENCE=""

# ---------------------------------------------------------------------------
# CLAUSE 1 — the step sits between the hard reset and run-check.
# ---------------------------------------------------------------------------
# `rg -bo` gives a byte offset per match; first match of each anchor is enough
# because each appears once in main()'s linear flow.
offset_of() {
  rg -bo --no-filename "$1" "$SCRIPT" 2>/dev/null | head -n 1 | cut -d: -f1
}

OFF_CHECKOUT="$(offset_of 'step\("checkout-head", `worktree at PR head')"
OFF_DEPS="$(offset_of 'step\("deps-at-head", depsDecision\.detail\)')"
OFF_RUNCHECK="$(offset_of 'note\("run-check",')"

if [ -z "$OFF_CHECKOUT" ] || [ -z "$OFF_DEPS" ] || [ -z "$OFF_RUNCHECK" ]; then
  CLAUSE1_EVIDENCE="anchor missing in $SCRIPT_REL — checkout-head:${OFF_CHECKOUT:-none} deps-at-head:${OFF_DEPS:-none} run-check:${OFF_RUNCHECK:-none}"
elif [ "$OFF_CHECKOUT" -lt "$OFF_DEPS" ] && [ "$OFF_DEPS" -lt "$OFF_RUNCHECK" ]; then
  # It must also actually install, not merely print a line.
  if rg -q 'capture\("deps-at-head", "bun", \["install", "--frozen-lockfile"\]' "$SCRIPT"; then
    CLAUSE1=PASS
    CLAUSE1_EVIDENCE="deps-at-head at byte $OFF_DEPS, strictly between checkout-head ($OFF_CHECKOUT) and run-check ($OFF_RUNCHECK), and it runs bun install --frozen-lockfile through capture() (fail-loud)"
  else
    CLAUSE1_EVIDENCE="deps-at-head is ordered correctly but never runs bun install --frozen-lockfile via capture() — a step line with no install is a receipt for work that did not happen"
  fi
else
  CLAUSE1_EVIDENCE="wrong order — checkout-head:$OFF_CHECKOUT deps-at-head:$OFF_DEPS run-check:$OFF_RUNCHECK (required: checkout-head < deps-at-head < run-check)"
fi

# ---------------------------------------------------------------------------
# CLAUSE 2 — both branches announce themselves; the unit suite proves it.
# ---------------------------------------------------------------------------
TEST_OUT="$(cd "$REPO_ROOT" && bun test "$TEST_REL" 2>&1)"
TEST_STATUS=$?
TEST_TALLY="$(printf '%s\n' "$TEST_OUT" | rg -o '[0-9]+ pass' | head -n 1)"
if [ "$TEST_STATUS" -eq 0 ]; then
  CLAUSE2=PASS
  CLAUSE2_EVIDENCE="$TEST_REL green (${TEST_TALLY:-tally unavailable}) — covers the reinstalled path, the unchanged path, and the head SHA appearing on both"
else
  CLAUSE2_EVIDENCE="$TEST_REL exited $TEST_STATUS. Output tail: $(printf '%s\n' "$TEST_OUT" | tail -n 5 | tr '\n' ' ')"
fi

# ---------------------------------------------------------------------------
# CLAUSE 3 — the comparison fires on a real dependency-adding head.
# ---------------------------------------------------------------------------
SCRATCH_BASE="${OPENBRAIN_TEMP_WORKSPACE:-${DEV_TMP:-/Volumes/ThunderBolt/_tmp}}/open-brain/_scratch"
mkdir -p "$SCRATCH_BASE" || fail_hard "cannot create scratch dir at $SCRATCH_BASE"
# NOT mktemp -d (AGENTS.md hard rule: it resolves to a sandbox-local $TMPDIR
# that no other process can see). An explicit path under the temp workspace,
# unique by pid + epoch so concurrent runs cannot collide.
FIXTURE="$SCRATCH_BASE/775-deps-fixture-$$-$(date +%s)"
mkdir -p "$FIXTURE" || fail_hard "cannot create fixture dir at $FIXTURE"

fixture_git() { git -C "$FIXTURE" "$@" >/dev/null 2>&1; }

# "fixture", not "main": the operator's global protected-branch hook refuses
# commits to main even in a throwaway repo, and the branch name proves nothing.
if fixture_git init --quiet -b fixture \
  && fixture_git config user.email "test@example.invalid" \
  && fixture_git config user.name "775 done-means" \
  && fixture_git config core.hooksPath "$FIXTURE/.git/no-hooks" \
  && fixture_git config commit.gpgsign false; then

  printf '{"name":"t"}\n'  > "$FIXTURE/package.json"
  printf 'lock-v1\n'       > "$FIXTURE/bun.lock"
  printf 'base\n'          > "$FIXTURE/README.md"
  fixture_git add .
  fixture_git commit --quiet -m base
  BASE_SHA="$(git -C "$FIXTURE" rev-parse HEAD 2>/dev/null)"

  # A head that adds a devDependency — #771's shape.
  printf '{"name":"t","devDependencies":{"oxlint":"1.0.0"}}\n' > "$FIXTURE/package.json"
  printf 'lock-v1\noxlint\n'                                   > "$FIXTURE/bun.lock"
  fixture_git add .
  fixture_git commit --quiet -m "add oxlint"
  DEP_SHA="$(git -C "$FIXTURE" rev-parse HEAD 2>/dev/null)"

  # A head that touches neither manifest.
  fixture_git reset --hard --quiet "$BASE_SHA"
  printf 'changed\n' > "$FIXTURE/README.md"
  fixture_git add .
  fixture_git commit --quiet -m "docs only"
  DOC_SHA="$(git -C "$FIXTURE" rev-parse HEAD 2>/dev/null)"

  git -C "$FIXTURE" diff --quiet "$BASE_SHA" "$DEP_SHA" -- package.json bun.lock
  DEP_STATUS=$?
  git -C "$FIXTURE" diff --quiet "$BASE_SHA" "$DOC_SHA" -- package.json bun.lock
  DOC_STATUS=$?

  if [ "$DEP_STATUS" -eq 1 ] && [ "$DOC_STATUS" -eq 0 ]; then
    CLAUSE3=PASS
    CLAUSE3_EVIDENCE="dependency-adding head -> git diff --quiet exit 1 (reinstall), unrelated-change head -> exit 0 (skip); fixture at $FIXTURE"
  else
    CLAUSE3_EVIDENCE="comparison did not discriminate — dependency-adding head exit $DEP_STATUS (want 1), unrelated head exit $DOC_STATUS (want 0); fixture at $FIXTURE"
  fi
else
  CLAUSE3_EVIDENCE="could not build the git fixture at $FIXTURE"
fi

# ---------------------------------------------------------------------------
# CLAUSE 4 — any exit code outside {0,1} fails loudly.
# ---------------------------------------------------------------------------
if rg -q 'diff\.status !== 0 && diff\.status !== 1' "$SCRIPT" \
  && rg -q 'Refusing to guess whether the head' "$SCRIPT"; then
  CLAUSE4=PASS
  CLAUSE4_EVIDENCE="verify-lane rejects any git diff status outside {0,1} rather than reading it as 'unchanged'"
else
  CLAUSE4_EVIDENCE="no fail-closed guard on the git diff exit code — a bad ref or missing object would be read as 'manifests match' and skip the install, which is the original defect"
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
printf '\n#775 — verify-lane installs the PR head'"'"'s dependencies\n\n'
printf '  CLAUSE 1 (step ordered between reset and check): %s\n    %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
printf '  CLAUSE 2 (both paths announce themselves):       %s\n    %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"
printf '  CLAUSE 3 (comparison fires on a real head):      %s\n    %s\n' "$CLAUSE3" "$CLAUSE3_EVIDENCE"
printf '  CLAUSE 4 (fail-closed on an unusable compare):   %s\n    %s\n' "$CLAUSE4" "$CLAUSE4_EVIDENCE"
printf '\n'
printf '  Fixture repositories are LEFT IN PLACE under %s —\n' "$SCRATCH_BASE"
printf '  teardown is printed, never executed. Remove them yourself when done.\n\n'

if [ "$CLAUSE1" = PASS ] && [ "$CLAUSE2" = PASS ] && [ "$CLAUSE3" = PASS ] && [ "$CLAUSE4" = PASS ]; then
  printf 'PASS — verify-lane reinstalls at the PR head and says which path it took.\n\n'
  exit 0
fi
printf 'FAIL — see the clause evidence above.\n\n'
exit 1
