#!/usr/bin/env bash
# DONE-MEANS check for issue #709 — the pr-body-gate hook must FEED the
# validator the PR's actual head, not just its own session cwd.
#
#   bash scripts/done-means/709-hook-feeds-head-ref.sh
#
# ---------------------------------------------------------------------------
# The defect this gates
# ---------------------------------------------------------------------------
# #706 landed in two halves and only one of them was reachable in production.
#
# `scripts/validate-pr-body.ts` resolves a `Done-means` path in three tiers:
# the tree under review (`PR_REPO_DIR`), the validator's own tree, and
# `git cat-file -e <PR_HEAD_REF>:<path>` against the head branch. The third
# tier is the one #706 asked for by name — it is what lets a lane cite a check
# that exists only on its own branch.
#
# `.claude/hooks/pr-body-gate.ts` is the ONLY caller that runs at the boundary,
# and it set `PR_REPO_DIR` from `input.cwd` and NEVER set `PR_HEAD_REF`. It also
# parsed no `--head` from the intercepted `gh pr create`. So:
#
#   - the branch tier was dead code from the only live caller, and
#   - `input.cwd` is the HARNESS PAYLOAD's cwd — the session's directory. A
#     `cd /path/to/worktree && gh pr create ...` inside one Bash call does not
#     move it, so the "tree under review" was the PRIMARY CHECKOUT, sitting on
#     the base branch, which is the exact tree #706 existed to stop consulting.
#
# Measured 2026-08-10 on lane/issue-artifacts-outcomes: the PR was refused, and
# the refusal named the primary checkout as the only tree it looked in.
#
# ---------------------------------------------------------------------------
# Why this check drives the HOOK and not the validator
# ---------------------------------------------------------------------------
# docs/lane-contract.md round 28, first bullet: A SEAM ADDED TO MAKE A GATE
# TESTABLE IS NOT THE PATH THAT RUNS. #709 IS that bullet recurring in the lane
# that wrote it. `scripts/done-means/706-done-means-resolves-pr-head.sh` is
# 5/5 GREEN and always was: it calls the VALIDATOR directly and sets
# `PR_HEAD_REF` itself, so it proves the tier works WHEN FED and never that
# anything feeds it. `pr-body-gate-fires.sh` drives the real hook but asserts on
# neither `cwd` nor `PR_HEAD_REF`.
#
# So every clause here drives `.claude/hooks/pr-body-gate.ts` with a synthetic
# PreToolUse payload of exactly the shape Claude Code sends, whose `cwd` is NOT
# the branch's tree and whose command is the real `cd <worktree> && gh pr create`
# shape. No validator-direct seams are used as proof anywhere in this file.
#
# ---------------------------------------------------------------------------
# The fixture
# ---------------------------------------------------------------------------
# A throwaway git repo under {temp_workspace}/open-brain/_scratch with:
#
#   - a base branch carrying NO check file,
#   - a lane branch carrying `scripts/done-means/lane-only-check.sh`,
#   - a worktree checked out on the lane branch.
#
# The payload's `cwd` is the BASE checkout (standing in for the session dir /
# primary checkout). The command `cd`s into the lane worktree. A body citing
# `scripts/done-means/lane-only-check.sh` is therefore resolvable ONLY if the
# hook looks at something other than the payload cwd — the `cd` target, or the
# head ref. That is the whole defect, expressed as a fixture.
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
#   1  cd <lane worktree> && gh pr create citing a branch-only check
#        -> ALLOWED. RED before the fix (the hook only knew the payload cwd).
#   2  the same call, with the branch-only file DELETED from the lane worktree's
#      working tree but still committed on the branch
#        -> ALLOWED via the BRANCH tier specifically. This is the clause that
#           forces PR_HEAD_REF to actually be supplied rather than the fix
#           reducing to "read the cd target". Without it, a cwd-only fix passes
#           clause 1 and the branch tier stays dead — the #709 defect exactly.
#   3  explicit `--head <branch>` on the gh command is honoured
#        -> ALLOWED even when the command never `cd`s anywhere and the payload
#           cwd is the base checkout, i.e. no tree on disk carries the file.
#   4  MUTANT CONTROL: same shape, citing a path that exists in NO tree and on
#      NO branch -> still REFUSED. A fix that widens resolution must not become
#      a blanket pass; this is the clause that fails if anyone "fixes" #709 by
#      making the Done-means check advisory.
#   5  the hook ANNOUNCES which source fed the head ref (AGENTS.md, nothing is
#      adjusted silently, 2026-08-08). Round 28: "Assert on announcements, or
#      they rot silently."
#
# Exit 0 only when every clause passes. Exit 3 is a harness error (missing tool,
# unbuildable fixture), which is NOT a fail of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$REPO_ROOT/.claude/hooks/pr-body-gate.ts"
TEMPLATE="$REPO_ROOT/.github/pull_request_template.md"
VALIDATOR="$REPO_ROOT/scripts/validate-pr-body.ts"

SCRATCH_BASE="${OPENBRAIN_TEMP_WORKSPACE:-${DEV_TMP:-/Volumes/ThunderBolt/_tmp}}/open-brain/_scratch"
SCRATCH="$SCRATCH_BASE/709-hook-feeds-head-ref.$$"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
command -v git >/dev/null 2>&1 || fail_hard "git not on PATH"
[ -r "$VALIDATOR" ] || fail_hard "validator not readable at $VALIDATOR"
[ -r "$TEMPLATE" ] || fail_hard "template not readable at $TEMPLATE"
mkdir -p "$SCRATCH" || fail_hard "cannot create scratch dir $SCRATCH"

# ---------------------------------------------------------------------------
# Fixture repo: base checkout + lane branch + lane worktree.
# ---------------------------------------------------------------------------
FIXTURE="$SCRATCH/repo"
LANE_TREE="$SCRATCH/lane-worktree"
LANE_BRANCH="lane/709-fixture"
BRANCH_ONLY_CHECK="scripts/done-means/lane-only-check.sh"

build_fixture() {
  git init -q -b base "$FIXTURE" || return 1
  git -C "$FIXTURE" config user.email "done-means@open-brain.invalid" || return 1
  git -C "$FIXTURE" config user.name "709 done-means fixture" || return 1
  # The fixture must not inherit this repo's hooks: it is a scratch repo, and a
  # pre-push/pre-commit running against it would be measuring the wrong thing.
  git -C "$FIXTURE" config core.hooksPath "$FIXTURE/.git/no-hooks" || return 1

  mkdir -p "$FIXTURE/scripts/done-means" || return 1
  printf 'base tree\n' > "$FIXTURE/README.md" || return 1
  git -C "$FIXTURE" add README.md || return 1
  git -C "$FIXTURE" commit -q -m "base commit" || return 1

  git -C "$FIXTURE" checkout -q -b "$LANE_BRANCH" || return 1
  printf '#!/usr/bin/env bash\nexit 0\n' > "$FIXTURE/$BRANCH_ONLY_CHECK" || return 1
  git -C "$FIXTURE" add "$BRANCH_ONLY_CHECK" || return 1
  git -C "$FIXTURE" commit -q -m "lane: add the branch-only check" || return 1
  git -C "$FIXTURE" checkout -q base || return 1

  git -C "$FIXTURE" worktree add -q "$LANE_TREE" "$LANE_BRANCH" || return 1
}

build_fixture || fail_hard "could not build the fixture repo under $SCRATCH"

# Sanity: the fixture must actually express the asymmetry, or every clause below
# measures nothing. The file is on the lane branch and NOT in the base checkout.
[ -e "$FIXTURE/$BRANCH_ONLY_CHECK" ] \
  && fail_hard "fixture wrong: the branch-only check is visible in the base checkout"
git -C "$FIXTURE" cat-file -e "$LANE_BRANCH:$BRANCH_ONLY_CHECK" 2>/dev/null \
  || fail_hard "fixture wrong: the branch-only check is not committed on $LANE_BRANCH"

# ---------------------------------------------------------------------------
# Bodies. Built from the committed template exactly the way
# scripts/done-means/pr-body-gate-fires.sh builds its valid body, so this check
# inherits that gate's guarantee instead of maintaining a second field list.
# Only the Done-means line differs between them.
# ---------------------------------------------------------------------------
DUMMY="dummy specific content for the 709 acceptance gate"

fill_template() {
  local done_means_value="$1" out="$2"
  sed \
    -e 's/\[ \]\(.*\)or \[ \] not applicable because:.*$/[x]\1or [ ] not applicable because:/' \
    -e 's/^- \[ \]/- [x]/' \
    -e "s|^- Done-means:.*$|- Done-means: $done_means_value|" \
    -e "s/^\(- [^][]*:\)[[:space:]]*$/\1 $DUMMY/" \
    "$TEMPLATE" > "$out"
}

BRANCH_BODY_FILE="$SCRATCH/branch-only-body.md"
NOWHERE_BODY_FILE="$SCRATCH/nowhere-body.md"
NOWHERE_PATH="scripts/done-means/this-path-exists-nowhere-at-all.sh"

fill_template "$BRANCH_ONLY_CHECK" "$BRANCH_BODY_FILE" \
  || fail_hard "could not build the branch-only body"
fill_template "$NOWHERE_PATH" "$NOWHERE_BODY_FILE" \
  || fail_hard "could not build the nowhere body"

# Sanity on the MUTANT CONTROL fixture: the nonexistent path must genuinely be
# absent from both trees and both refs, or clause 4 proves nothing.
[ -e "$FIXTURE/$NOWHERE_PATH" ] && fail_hard "fixture wrong: the 'nowhere' path exists in the base checkout"
[ -e "$LANE_TREE/$NOWHERE_PATH" ] && fail_hard "fixture wrong: the 'nowhere' path exists in the lane worktree"
[ -e "$REPO_ROOT/$NOWHERE_PATH" ] && fail_hard "fixture wrong: the 'nowhere' path exists in this repo"
if git -C "$FIXTURE" cat-file -e "$LANE_BRANCH:$NOWHERE_PATH" 2>/dev/null; then
  fail_hard "fixture wrong: the 'nowhere' path is committed on $LANE_BRANCH"
fi

# ---------------------------------------------------------------------------
# Drive the REAL hook the way Claude Code does: a PreToolUse JSON payload on
# stdin, carrying the SESSION's cwd — never the lane worktree.
# Sets HOOK_EXIT and HOOK_STDERR.
# ---------------------------------------------------------------------------
HOOK_EXIT=0
HOOK_STDERR=""
run_hook() {
  local command_text="$1" payload_cwd="$2" payload
  payload="$(
    COMMAND_TEXT="$command_text" PAYLOAD_CWD="$payload_cwd" bun -e '
      process.stdout.write(JSON.stringify({
        session_id: "709-hook-feeds-head-ref",
        cwd: process.env.PAYLOAD_CWD ?? "",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: process.env.COMMAND_TEXT ?? "" },
      }));
    '
  )" || fail_hard "could not build hook payload"

  HOOK_STDERR="$(printf '%s' "$payload" | bun "$HOOK" --event pre-tool-use 2>&1 >/dev/null)"
  HOOK_EXIT=$?
}

q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

CLAUSES=()
record() { CLAUSES+=("$1|$2|$3"); }

if [ ! -r "$HOOK" ]; then
  for c in 1 2 3 4 5; do
    record "$c" FAIL "no hook at $HOOK — nothing feeds the validator anything"
  done
else
  # -- CLAUSE 1: the real `cd <worktree> && gh pr create` shape is ALLOWED -----
  # The payload cwd is the BASE checkout. Pre-fix the hook resolved there, found
  # nothing, and refused. This is the exact call the #709 report measured.
  run_hook "cd $(q "$LANE_TREE") && gh pr create --title 'feat: lane thing' --body-file $(q "$BRANCH_BODY_FILE")" "$FIXTURE"
  if [ "$HOOK_EXIT" -eq 0 ]; then
    record 1 PASS "cd-into-worktree gh pr create citing a branch-only check ALLOWED (exit=0)"
  else
    record 1 FAIL "REFUSED (exit=$HOOK_EXIT) — the hook still resolves against the payload cwd: $(printf '%s' "$HOOK_STDERR" | tr '\n' ' ' | cut -c1-260)"
  fi

  # -- CLAUSE 2: the BRANCH tier specifically, with no tree on disk carrying it -
  # Move the file out of the lane worktree's working tree (it stays committed on
  # the branch). Now NO checkout the hook can reach has it, so only a supplied
  # PR_HEAD_REF can resolve it. A fix that merely reads the `cd` target fails
  # here, which is the point: #709 is about the branch tier being fed.
  STASHED="$SCRATCH/stashed-lane-only-check.sh"
  mv "$LANE_TREE/$BRANCH_ONLY_CHECK" "$STASHED" \
    || fail_hard "could not move the branch-only check out of the lane worktree"
  [ -e "$LANE_TREE/$BRANCH_ONLY_CHECK" ] \
    && fail_hard "fixture wrong: the branch-only check is still on disk in the lane worktree"

  run_hook "cd $(q "$LANE_TREE") && gh pr create --title 'feat: lane thing' --body-file $(q "$BRANCH_BODY_FILE")" "$FIXTURE"
  CLAUSE2_EXIT="$HOOK_EXIT"
  CLAUSE2_STDERR="$HOOK_STDERR"
  if [ "$CLAUSE2_EXIT" -ne 0 ]; then
    record 2 FAIL "REFUSED (exit=$CLAUSE2_EXIT) — the branch tier is still unfed: $(printf '%s' "$CLAUSE2_STDERR" | tr '\n' ' ' | cut -c1-260)"
  elif ! printf '%s' "$CLAUSE2_STDERR" | rg -qF "resolved in branch $LANE_BRANCH"; then
    record 2 FAIL "allowed, but never announced the BRANCH tier — resolution came from somewhere else, so PR_HEAD_REF is still unproven"
  else
    record 2 PASS "on-disk-nowhere check resolved via the BRANCH tier and announced it (exit=0)"
  fi

  mv "$STASHED" "$LANE_TREE/$BRANCH_ONLY_CHECK" \
    || fail_hard "could not restore the branch-only check into the lane worktree"

  # -- CLAUSE 3: an explicit --head is honoured, with no cd at all -------------
  # Payload cwd is the base checkout, the command never changes directory, and
  # the file is in no reachable tree. Only `--head` can answer.
  mv "$LANE_TREE/$BRANCH_ONLY_CHECK" "$STASHED" \
    || fail_hard "could not move the branch-only check out for clause 3"
  run_hook "git -C $(q "$FIXTURE") status && gh pr create --head $(q "$LANE_BRANCH") --title 'feat: lane thing' --body-file $(q "$BRANCH_BODY_FILE")" "$FIXTURE"
  if [ "$HOOK_EXIT" -eq 0 ] && printf '%s' "$HOOK_STDERR" | rg -qF "resolved in branch $LANE_BRANCH"; then
    record 3 PASS "explicit --head honoured with no cd and no tree on disk (exit=0, branch tier announced)"
  else
    record 3 FAIL "explicit --head not honoured (exit=$HOOK_EXIT): $(printf '%s' "$HOOK_STDERR" | tr '\n' ' ' | cut -c1-260)"
  fi
  mv "$STASHED" "$LANE_TREE/$BRANCH_ONLY_CHECK" \
    || fail_hard "could not restore the branch-only check after clause 3"

  # -- CLAUSE 4: MUTANT CONTROL. A path in no tree and on no ref is REFUSED ----
  run_hook "cd $(q "$LANE_TREE") && gh pr create --title 'feat: lane thing' --body-file $(q "$NOWHERE_BODY_FILE")" "$FIXTURE"
  if [ "$HOOK_EXIT" -ne 2 ]; then
    record 4 FAIL "a nonexistent Done-means path was ALLOWED (exit=$HOOK_EXIT) — widening resolution turned the gate into a blanket pass"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qF "$NOWHERE_PATH"; then
    record 4 FAIL "refused but never names the offending path"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qF 'looked in:'; then
    record 4 FAIL "refused but never says where it looked — a dead-end refusal"
  else
    record 4 PASS "nonexistent Done-means path still REFUSED, naming the path and where it looked (exit=2)"
  fi

  # -- CLAUSE 5: the head-ref SOURCE is announced -----------------------------
  # AGENTS.md 2026-08-08: nothing is adjusted silently. The hook decides for
  # itself where the head ref came from (--head, or the cd target's checkout);
  # a self-made decision that is invisible cannot be checked by the reader.
  # Round 28: assert on announcements or they rot.
  run_hook "cd $(q "$LANE_TREE") && gh pr create --title 'feat: lane thing' --body-file $(q "$BRANCH_BODY_FILE")" "$FIXTURE"
  DERIVED_OK=0
  printf '%s' "$HOOK_STDERR" | rg -qF 'pr-body-gate' \
    && printf '%s' "$HOOK_STDERR" | rg -qF "$LANE_BRANCH" \
    && printf '%s' "$HOOK_STDERR" | rg -qi -e 'head ref' \
    && DERIVED_OK=1
  if [ "$DERIVED_OK" -ne 1 ]; then
    record 5 FAIL "the derived head ref is not announced by name — the hook made a silent decision: $(printf '%s' "$HOOK_STDERR" | tr '\n' ' ' | cut -c1-260)"
  else
    run_hook "gh pr create --head $(q "$LANE_BRANCH") --title 'feat: lane thing' --body-file $(q "$BRANCH_BODY_FILE")" "$FIXTURE"
    if printf '%s' "$HOOK_STDERR" | rg -qi -e '--head|explicit' && printf '%s' "$HOOK_STDERR" | rg -qF "$LANE_BRANCH"; then
      record 5 PASS "head ref source announced on both paths (derived from the command's target checkout, and explicit --head)"
    else
      record 5 FAIL "explicit --head path does not announce its source: $(printf '%s' "$HOOK_STDERR" | tr '\n' ' ' | cut -c1-260)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
label_for() {
  case "$1" in
    1) printf 'cd-into-worktree gh pr create citing a branch-only check is ALLOWED' ;;
    2) printf 'the BRANCH tier resolves a check on disk in no reachable tree' ;;
    3) printf 'an explicit --head is parsed and honoured' ;;
    4) printf 'MUTANT CONTROL: a path in no tree and on no ref is still REFUSED' ;;
    5) printf 'the head-ref SOURCE is announced, never silent' ;;
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

# Fixture teardown. The worktree registration is removed with git (a plain move
# would strand it); the directory itself is ARCHIVED, never deleted — AGENTS.md,
# the agent's cleanup verb is mv.
git -C "$FIXTURE" worktree remove --force "$LANE_TREE" >/dev/null 2>&1
ARCHIVE_DIR="${OPENBRAIN_TEMP_WORKSPACE:-${DEV_TMP:-/Volumes/ThunderBolt/_tmp}}/open-brain/_archive"
if mkdir -p "$ARCHIVE_DIR" 2>/dev/null; then
  mv "$SCRATCH" "$ARCHIVE_DIR/$(basename "$SCRATCH").$(date +%s)" 2>/dev/null
fi

[ "$ALL_PASS" -eq 1 ] && exit 0
exit 1
