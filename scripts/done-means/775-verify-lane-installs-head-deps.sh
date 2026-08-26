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
# CLAUSE 1 — THE FIX IS PROVEN BY MUTATION, NOT BY BYTE OFFSETS.
#   The earlier version of this clause located strings in verify-lane.ts by
#   byte offset and asserted their order. That is structural, and a mutant that
#   kept the strings while ignoring `diff.status` passed all four clauses
#   (review round 1). So the status handling now lives INSIDE the exported
#   `decideDepsAtHead()`, and this clause proves the test can actually kill a
#   mutant: it copies the repo's verify-lane.ts to a scratch path, flips the
#   fail-closed comparison (`!== 0 && !== 1` -> a condition that never fires),
#   points the unit suite at the mutant, and REQUIRES the suite to fail. A
#   green suite against a mutant means the suite proves nothing.
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
# CLAUSE 5 — NEGATIVE CONTROL: THE FIXTURES CANNOT TOUCH ANOTHER REPOSITORY.
#   A check that can mutate the repository it verifies is a worse defect than
#   the one it gates, and this check's own fixtures corrupted the branch under
#   development while being authored. So it is proven, not asserted: a
#   throwaway VICTIM repository is created, its `.git/config` and HEAD are
#   hashed, the fixture work is then run with `GIT_DIR` deliberately POINTED AT
#   THE VICTIM, and the victim's config and HEAD must be byte-identical
#   afterwards. If the environment fence or the `--git-dir` pinning ever
#   regresses, this clause goes red instead of a branch getting eaten.
#
# Exit 0 only when all five clauses pass. Exit 3 is a harness error (missing
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
# Repo-relative, matching src/operator-doctor.test.ts and this check's own unit
# test: `_scratch/<name>/` under the repo root, already excluded by
# .gitignore:119. The previous fallback hardcoded the operator's Mac
# (`/Volumes/ThunderBolt/_tmp`), so CI died on `EACCES: permission denied,
# mkdir '/Volumes'` — a Linux runner cannot create that path, and a done-means
# check that only runs on one machine's volume layout gates nothing in CI.
#
# Keeping the fixture INSIDE the repo also bounds the escape guarded against
# below: the worst a stray git call can reach is a directory the repo already
# ignores.
SCRATCH_BASE="$REPO_ROOT/_scratch/verify-lane-deps"
mkdir -p "$SCRATCH_BASE" || fail_hard "cannot create scratch dir at $SCRATCH_BASE"

CLAUSE5=FAIL; CLAUSE5_EVIDENCE=""

# Pre-declared so the EXIT trap can reference them before they are assigned.
MUTANT_DIR=""
VICTIM=""
FIXTURE=""

# ---------------------------------------------------------------------------
# CLAUSE 1 — mutation: flip the fail-closed branch, the unit suite MUST fail.
# ---------------------------------------------------------------------------
# Structural checks (byte offsets of strings) cannot tell a real fix from a
# mutant that keeps the strings. This runs the suite against a deliberately
# broken copy of verify-lane.ts and requires it to go red.
MUTANT_DIR="$SCRATCH_BASE/mutation-$$-$(date +%s)"
mkdir -p "$MUTANT_DIR" || fail_hard "cannot create mutation dir at $MUTANT_DIR"
MUTANT_SCRIPT="$MUTANT_DIR/verify-lane.ts"
MUTANT_TEST="$MUTANT_DIR/verify-lane.test.ts"

# The mutation: make the fail-closed guard unreachable, so any status is
# treated as a normal answer. This is exactly the defect the guard exists to
# prevent, expressed as a one-token change.
sed 's/diffStatus !== 0 \&\& diffStatus !== 1/diffStatus === 999999/' \
  "$SCRIPT" > "$MUTANT_SCRIPT"
# The test imports "./verify-lane.ts", so a sibling copy points at the mutant.
sed 's#"\./verify-lane\.ts"#"./verify-lane.ts"#' \
  "$REPO_ROOT/$TEST_REL" > "$MUTANT_TEST"

if ! rg -q 'diffStatus === 999999' "$MUTANT_SCRIPT"; then
  CLAUSE1_EVIDENCE="the mutation did not apply — no 'diffStatus !== 0 && diffStatus !== 1' guard found in $SCRIPT_REL to flip. Either the guard moved or the fix is absent."
else
  MUT_OUT="$(cd "$REPO_ROOT" && bun test "$MUTANT_TEST" 2>&1)"
  MUT_STATUS=$?
  if [ "$MUT_STATUS" -ne 0 ]; then
    CLAUSE1=PASS
    CLAUSE1_EVIDENCE="mutant (fail-closed guard disabled) makes the unit suite exit $MUT_STATUS — the suite can kill it. Mutant kept at $MUTANT_SCRIPT"
  else
    CLAUSE1_EVIDENCE="THE SUITE PASSED AGAINST A MUTANT. Disabling the fail-closed guard changed no test outcome, so the tests prove nothing about status handling. Mutant at $MUTANT_SCRIPT"
  fi
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

# NOT mktemp -d (AGENTS.md hard rule: it resolves to a sandbox-local $TMPDIR
# that no other process can see). An explicit path, unique by pid + epoch so
# concurrent runs cannot collide.
FIXTURE="$SCRATCH_BASE/fixture-$$-$(date +%s)"
mkdir -p "$FIXTURE" || fail_hard "cannot create fixture dir at $FIXTURE"

# Archive on EVERY exit path, with mv — never rm (AGENTS.md: an agent runs no
# recursive delete). _scratch/ is repo-relative now, so fixtures would otherwise
# pile up inside the checkout on every run.
ARCHIVE_DIR="$REPO_ROOT/_scratch/_archive/verify-lane-deps"
RUN_ID="$$-$(date +%s)"
archive_scratch() {
  mkdir -p "$ARCHIVE_DIR/$RUN_ID" 2>/dev/null || return 0
  for d in "$FIXTURE" "$MUTANT_DIR" "$VICTIM"; do
    [ -n "${d:-}" ] && [ -d "$d" ] && mv "$d" "$ARCHIVE_DIR/$RUN_ID/" 2>/dev/null
  done
  printf '  scratch archived to: %s\n' "$ARCHIVE_DIR/$RUN_ID"
}
trap archive_scratch EXIT

# Pin BOTH the git dir and the work tree, never a bare -C. With only -C, git
# walks UP to the first enclosing repository when the fixture is not one, so a
# failed init would commit these fixture commits into the surrounding worktree
# — observed during authoring, and it deleted every tracked file there. With
# the git dir pinned, that walk cannot happen: git errors instead.
# Environment fence for EVERY git call below. The --git-dir/--work-tree flags
# pin the target, but they are only as good as the next person remembering
# them; these variables would override or redirect a call that lost its flags.
# GIT_CEILING_DIRECTORIES stops the upward discovery walk at the fixture's
# parent, so even a fully unflagged `git` cannot reach the enclosing checkout.
git_fenced() {
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY \
      -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_COMMON_DIR \
      GIT_CEILING_DIRECTORIES="$SCRATCH_BASE" \
      git "$@"
}
fixture_git() {
  git_fenced --git-dir "$FIXTURE/.git" --work-tree "$FIXTURE" "$@" >/dev/null 2>&1
}
fixture_git_out() {
  git_fenced --git-dir "$FIXTURE/.git" --work-tree "$FIXTURE" "$@" 2>/dev/null
}

# `init` predates the repo, and it was previously the ONE unpinned call here.
# Unpinned it would re-initialise whatever an inherited GIT_DIR pointed at,
# BEFORE the missing-.git assertion below could run — so it is pinned and
# fenced like every other call. Its success is then ASSERTED on both the exit
# code and the resulting .git; an unchecked init is what enables the escape.
git_fenced --git-dir "$FIXTURE/.git" --work-tree "$FIXTURE" init --quiet -b fixture >/dev/null 2>&1
INIT_STATUS=$?
if [ "$INIT_STATUS" -ne 0 ] || [ ! -d "$FIXTURE/.git" ]; then
  fail_hard "git init failed in $FIXTURE (exit $INIT_STATUS, .git present: $([ -d "$FIXTURE/.git" ] && echo yes || echo no)). Refusing to run git here — every later call would walk up to the enclosing repository and commit into it."
fi

if fixture_git config user.email "test@example.invalid" \
  && fixture_git config user.name "775 done-means" \
  && fixture_git config core.hooksPath "$FIXTURE/.git/no-hooks" \
  && fixture_git config commit.gpgsign false; then

  printf '{"name":"t"}\n'  > "$FIXTURE/package.json"
  printf 'lock-v1\n'       > "$FIXTURE/bun.lock"
  printf 'base\n'          > "$FIXTURE/README.md"
  fixture_git add .
  fixture_git commit --quiet -m base
  BASE_SHA="$(fixture_git_out rev-parse HEAD)"

  # A head that adds a devDependency — #771's shape.
  printf '{"name":"t","devDependencies":{"oxlint":"1.0.0"}}\n' > "$FIXTURE/package.json"
  printf 'lock-v1\noxlint\n'                                   > "$FIXTURE/bun.lock"
  fixture_git add .
  fixture_git commit --quiet -m "add oxlint"
  DEP_SHA="$(fixture_git_out rev-parse HEAD)"

  # A head that touches neither manifest.
  fixture_git reset --hard --quiet "$BASE_SHA"
  printf 'changed\n' > "$FIXTURE/README.md"
  fixture_git add .
  fixture_git commit --quiet -m "docs only"
  DOC_SHA="$(fixture_git_out rev-parse HEAD)"

  fixture_git diff --quiet "$BASE_SHA" "$DEP_SHA" -- package.json bun.lock
  DEP_STATUS=$?
  fixture_git diff --quiet "$BASE_SHA" "$DOC_SHA" -- package.json bun.lock
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
# The guard now lives inside the exported decideDepsAtHead(), which is where
# the unit suite can reach it (review round 1, P2). Assert the function owns it
# AND that it takes the RAW status — a boolean parameter would put the branch
# back at the call site where clause 1's mutant survived.
if rg -q 'diffStatus !== 0 && diffStatus !== 1' "$SCRIPT" \
  && rg -q 'diffStatus: number \| null' "$SCRIPT" \
  && rg -q 'Refusing to guess whether' "$SCRIPT"; then
  CLAUSE4=PASS
  CLAUSE4_EVIDENCE="decideDepsAtHead() takes the raw git exit code (diffStatus: number | null) and throws on anything outside {0,1} rather than reading it as 'unchanged'"
else
  CLAUSE4_EVIDENCE="no fail-closed guard inside decideDepsAtHead(), or it no longer takes the raw status — a bad ref or missing object would be read as 'manifests match' and skip the install, which is the original defect"
fi

# ---------------------------------------------------------------------------
# CLAUSE 5 — negative control: a hostile GIT_DIR must not reach another repo.
# ---------------------------------------------------------------------------
# Create a VICTIM repository, hash its config and HEAD, then re-run the fixture
# work with GIT_DIR deliberately pointed at the victim. Byte-identical after is
# the assertion. This is what proves the fence, rather than asserting it.
VICTIM="$SCRATCH_BASE/victim-$$-$(date +%s)"
mkdir -p "$VICTIM" || fail_hard "cannot create victim dir at $VICTIM"

env -u GIT_DIR -u GIT_WORK_TREE GIT_CEILING_DIRECTORIES="$SCRATCH_BASE" \
  git --git-dir "$VICTIM/.git" --work-tree "$VICTIM" init --quiet -b victim >/dev/null 2>&1
if [ ! -d "$VICTIM/.git" ]; then
  CLAUSE5_EVIDENCE="could not create the victim repository at $VICTIM"
else
  env -u GIT_DIR -u GIT_WORK_TREE GIT_CEILING_DIRECTORIES="$SCRATCH_BASE" \
    git --git-dir "$VICTIM/.git" --work-tree "$VICTIM" config user.email "victim@example.invalid" >/dev/null 2>&1
  env -u GIT_DIR -u GIT_WORK_TREE GIT_CEILING_DIRECTORIES="$SCRATCH_BASE" \
    git --git-dir "$VICTIM/.git" --work-tree "$VICTIM" config user.name "victim" >/dev/null 2>&1
  printf 'victim\n' > "$VICTIM/keepme.txt"
  env -u GIT_DIR -u GIT_WORK_TREE GIT_CEILING_DIRECTORIES="$SCRATCH_BASE" \
    git --git-dir "$VICTIM/.git" --work-tree "$VICTIM" add . >/dev/null 2>&1
  env -u GIT_DIR -u GIT_WORK_TREE GIT_CEILING_DIRECTORIES="$SCRATCH_BASE" \
    git --git-dir "$VICTIM/.git" --work-tree "$VICTIM" commit --quiet -m victim >/dev/null 2>&1

  V_CONFIG_BEFORE="$(shasum "$VICTIM/.git/config" | cut -d" " -f1)"
  V_HEAD_BEFORE="$(env -u GIT_DIR -u GIT_WORK_TREE git --git-dir "$VICTIM/.git" rev-parse HEAD 2>/dev/null)"

  # The hostile part: GIT_DIR points at the victim while the fixture helpers run.
  HOSTILE="$SCRATCH_BASE/hostile-$$-$(date +%s)"
  mkdir -p "$HOSTILE"
  SAVED_FIXTURE="$FIXTURE"
  FIXTURE="$HOSTILE"
  GIT_DIR="$VICTIM/.git" GIT_WORK_TREE="$VICTIM" \
    git_fenced --git-dir "$FIXTURE/.git" --work-tree "$FIXTURE" init --quiet -b fixture >/dev/null 2>&1
  GIT_DIR="$VICTIM/.git" GIT_WORK_TREE="$VICTIM" fixture_git config user.email "test@example.invalid"
  GIT_DIR="$VICTIM/.git" GIT_WORK_TREE="$VICTIM" fixture_git config commit.gpgsign false
  printf 'x\n' > "$FIXTURE/package.json"
  GIT_DIR="$VICTIM/.git" GIT_WORK_TREE="$VICTIM" fixture_git add .
  FIXTURE="$SAVED_FIXTURE"

  V_CONFIG_AFTER="$(shasum "$VICTIM/.git/config" | cut -d" " -f1)"
  V_HEAD_AFTER="$(env -u GIT_DIR -u GIT_WORK_TREE git --git-dir "$VICTIM/.git" rev-parse HEAD 2>/dev/null)"

  if [ "$V_CONFIG_BEFORE" = "$V_CONFIG_AFTER" ] && [ "$V_HEAD_BEFORE" = "$V_HEAD_AFTER" ] && [ -n "$V_HEAD_BEFORE" ]; then
    CLAUSE5=PASS
    CLAUSE5_EVIDENCE="victim untouched with GIT_DIR aimed at it — config sha $V_CONFIG_BEFORE and HEAD $V_HEAD_BEFORE identical before/after; victim at $VICTIM"
  else
    CLAUSE5_EVIDENCE="VICTIM MUTATED. config $V_CONFIG_BEFORE -> $V_CONFIG_AFTER, HEAD $V_HEAD_BEFORE -> $V_HEAD_AFTER. The fence does not hold; a fixture can reach another repository."
  fi
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
printf '\n#775 — verify-lane installs the PR head'"'"'s dependencies\n\n'
printf '  CLAUSE 1 (mutant killed: suite fails on flipped guard): %s\n    %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
printf '  CLAUSE 2 (both paths announce themselves):       %s\n    %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"
printf '  CLAUSE 3 (comparison fires on a real head):      %s\n    %s\n' "$CLAUSE3" "$CLAUSE3_EVIDENCE"
printf '  CLAUSE 4 (fail-closed on an unusable compare):   %s\n    %s\n' "$CLAUSE4" "$CLAUSE4_EVIDENCE"
printf '  CLAUSE 5 (negative control: victim untouched):   %s\n    %s\n' "$CLAUSE5" "$CLAUSE5_EVIDENCE"
printf '\n'

if [ "$CLAUSE1" = PASS ] && [ "$CLAUSE2" = PASS ] && [ "$CLAUSE3" = PASS ] && [ "$CLAUSE4" = PASS ] && [ "$CLAUSE5" = PASS ]; then
  printf 'PASS — verify-lane reinstalls at the PR head and says which path it took.\n\n'
  exit 0
fi
printf 'FAIL — see the clause evidence above.\n\n'
exit 1
