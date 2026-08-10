#!/usr/bin/env bash
# DONE-MEANS check for issue #706 — "pr-body-gate validates Done-means against
# the primary checkout, so a lane's own new check never exists yet".
#
#   bash scripts/done-means/706-done-means-resolves-pr-head.sh
#
# ---------------------------------------------------------------------------
# THE DEFECT THIS GATES
# ---------------------------------------------------------------------------
# `scripts/validate-pr-body.ts` required the `Done-means:` value to exist in the
# tree the VALIDATOR FILE ships in (`resolve(import.meta.dir, "..")`), and
# `.claude/hooks/pr-body-gate.ts` spawns that validator out of
# `$CLAUDE_PROJECT_DIR` — the primary checkout, which is still on the base
# branch. A lane works in a worktree and its done-means check is a NEW file on
# the lane branch. So the file the PR ships was structurally invisible to the
# gate judging that PR, and the cheapest escapes were all false receipts:
# naming a different pre-existing check, or claiming `not applicable`.
#
# The fix is a RESOLUTION ORDER, not a relaxation: the validator looks in the
# tree under review first (an explicit review root, else the invoking cwd, else
# its own tree) and, when the path is on disk nowhere, asks git for it in the
# branch being merged. A path that exists in NONE of those is still refused.
#
# ---------------------------------------------------------------------------
# WHICH TREE RUNS (lane-contract round 12/23)
# ---------------------------------------------------------------------------
# The subject IS a script, so "which copy executes" is the whole question. Every
# invocation below runs `bun "$REPO_ROOT/scripts/validate-pr-body.ts"` with
# REPO_ROOT resolved from THIS FILE's own location, so the check always drives
# the copy shipping beside it and structurally cannot reach across trees.
#
# The "other tree" the clauses need is built here, as a throwaway checkout of
# THIS repo's HEAD carrying a planted file, so the check does not depend on a
# lane worktree existing on the machine that runs it. That makes clause (a) a
# real cross-tree proof in CI as well as locally.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) THE DEFECT. A Done-means path that exists ONLY in the tree under review
#       — not in the validator's own tree — is ACCEPTED when the validator is
#       pointed at that tree the way the hook points it (cwd), while the
#       validator itself is executed from the other tree.
#       RED pre-fix: refused, "must name an existing repo-relative path".
#
#   (b) THE PURPOSE IS PRESERVED. A path that exists in NEITHER tree is still
#       REFUSED, and the refusal still names Done-means. Without this, "fixing"
#       #706 by deleting the existence rule would pass clause (a) and destroy
#       the gate. This is the mutation-relevant half.
#
#   (c) NOTHING SILENT (AGENTS.md, 2026-08-08). The acceptance must SAY which
#       tree answered. A verdict whose basis is invisible is the adjusted-
#       silently defect the issue explicitly asks not to reintroduce: the reader
#       must be able to tell "resolved in the review tree" from "resolved in the
#       validator's own tree" without inferring it.
#
#   (d) CONTROL — the ordinary same-tree path is unchanged. A path present in
#       the validator's own tree, with no review root given at all, still
#       passes. Passes PRE-fix by design; it is what stops a fix that swaps one
#       hardcoded tree for another hardcoded tree from reading as success.
#
#   (e) BRANCH FALLBACK. A path that is on disk in NO tree but IS committed in a
#       git ref is accepted when that ref is named as the branch under review —
#       the `gh pr create` case where the lane's commit exists but the file is
#       not in any checkout the validator can see. Paired negative: a ref that
#       does NOT contain the path is still refused, so the fallback cannot be a
#       blanket pass.
#
# Exit 0 only when every clause passes. Exit 3 is a harness error (missing tool,
# unreadable repo), which is NOT a failure of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALIDATOR="$REPO_ROOT/scripts/validate-pr-body.ts"
TEMPLATE="$REPO_ROOT/.github/pull_request_template.md"
RUN_ID="706-$$-$(date +%s)"
SCRATCH="${OPENBRAIN_TEMP_WORKSPACE:-/Volumes/ThunderBolt/_tmp}/open-brain/_scratch/$RUN_ID"

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
# The "tree under review": a throwaway checkout of this repo's HEAD, plus one
# planted file that exists NOWHERE else. Built with `git worktree add --detach`
# so it is a real second tree with a real git dir, which is what clause (a) is
# about; `--detach` keeps it off any branch so it can never be mistaken for a
# lane. Torn down at the end with `git worktree remove` (a git operation, not a
# delete — AGENTS.md permits exactly this one).
# ---------------------------------------------------------------------------
REVIEW_TREE="$SCRATCH/review-tree"
if ! git -C "$REPO_ROOT" worktree add --detach --quiet "$REVIEW_TREE" HEAD 2>"$SCRATCH/worktree.err"; then
  fail_hard "could not create the review tree: $(cat "$SCRATCH/worktree.err")"
fi

# The lane-shaped file: a new done-means check on the branch under review.
PLANTED_REL="scripts/done-means/planted-$RUN_ID.sh"
printf '#!/usr/bin/env bash\n# planted by %s\nexit 0\n' "$(basename "${BASH_SOURCE[0]}")" \
  > "$REVIEW_TREE/$PLANTED_REL" || fail_hard "could not plant $PLANTED_REL"

# The planted path must be absent from the validator's own tree, or clause (a)
# proves nothing. Assert it rather than assuming it.
if [ -e "$REPO_ROOT/$PLANTED_REL" ]; then
  fail_hard "planted path $PLANTED_REL unexpectedly exists in $REPO_ROOT; clause (a) would be vacuous"
fi

# A ref that CONTAINS the planted file, for clause (e). Committed in the review
# tree on its own throwaway branch so nothing on a real branch is touched.
BRANCH_UNDER_REVIEW="planted-branch-$RUN_ID"
BRANCH_OK=yes
git -C "$REVIEW_TREE" checkout -q -b "$BRANCH_UNDER_REVIEW" 2>>"$SCRATCH/git.err" || BRANCH_OK=no
git -C "$REVIEW_TREE" add "$PLANTED_REL" 2>>"$SCRATCH/git.err" || BRANCH_OK=no
git -C "$REVIEW_TREE" \
  -c user.name="done-means-706" -c user.email="done-means-706@invalid" \
  commit -q -m "plant done-means check for $RUN_ID" 2>>"$SCRATCH/git.err" || BRANCH_OK=no

# ---------------------------------------------------------------------------
# Bodies. Built from the COMMITTED template, mechanically filled the same way
# scripts/done-means/done-means-field-required.sh fills it, so these clauses can
# only fail on the Done-means rule and never on unrelated template drift.
# ---------------------------------------------------------------------------
DUMMY="dummy specific content for the acceptance gate"
BASE_BODY="$(
  sed \
    -e 's/\[ \]\(.*\)or \[ \] not applicable because:.*$/[x]\1or [ ] not applicable because:/' \
    -e 's/^- \[ \]/- [x]/' \
    -e "s/^\(- [^][]*:\)[[:space:]]*$/\1 $DUMMY/" \
    -e '/^- Done-means:/d' \
    "$TEMPLATE"
)" || fail_hard "could not build base PR body"

with_done_means() {
  printf '%s\n' "$BASE_BODY" | sed "/^## Verification\$/a\\
- Done-means: $1"
}

# run_validator <cwd> <body> [extra env assignments...]
# The validator is always the REPO_ROOT copy; only its cwd and environment move.
run_validator() {
  local cwd="$1" body="$2"
  shift 2
  VALIDATOR_OUTPUT="$(
    cd "$cwd" && env "$@" PR_BODY="$body" PR_TITLE="706 done-means tree resolution" \
      bun "$VALIDATOR" 2>&1
  )"
  VALIDATOR_EXIT=$?
}

CLAUSES=()
record() { CLAUSES+=("$1|$2|$3"); }

# --- (a) the defect --------------------------------------------------------
# Executed FROM the review tree's cwd, which is exactly the seam the hook has:
# the hook knows the lane's cwd (it reads it from the payload) while the
# validator file lives in the primary checkout.
run_validator "$REVIEW_TREE" "$(with_done_means "$PLANTED_REL")"
A_OUTPUT="$VALIDATOR_OUTPUT"
if [ "$VALIDATOR_EXIT" -eq 0 ]; then
  record a PASS "path present only in the tree under review was accepted (exit=0)"
else
  record a FAIL "path present only in the tree under review was REFUSED (exit=$VALIDATOR_EXIT): $(printf '%s' "$VALIDATOR_OUTPUT" | tr '\n' ' ')"
fi

# --- (b) the purpose survives ----------------------------------------------
MISSING_REL="scripts/done-means/absent-everywhere-$RUN_ID.sh"
[ -e "$REPO_ROOT/$MISSING_REL" ] && fail_hard "control path $MISSING_REL exists; clause (b) would be vacuous"
[ -e "$REVIEW_TREE/$MISSING_REL" ] && fail_hard "control path $MISSING_REL exists in the review tree; clause (b) would be vacuous"
run_validator "$REVIEW_TREE" "$(with_done_means "$MISSING_REL")"
if [ "$VALIDATOR_EXIT" -ne 0 ] && printf '%s' "$VALIDATOR_OUTPUT" | rg -qF "Done-means"; then
  record b PASS "path absent from every tree still refused, error names Done-means (exit=$VALIDATOR_EXIT)"
else
  record b FAIL "path absent from every tree was NOT refused by the Done-means rule (exit=$VALIDATOR_EXIT): $(printf '%s' "$VALIDATOR_OUTPUT" | tr '\n' ' ')"
fi

# --- (c) nothing silent ----------------------------------------------------
# Anchored on a marker the VALIDATOR owns, not on prose a failure could also
# emit (lane-contract round 23: a negative-match clause can go green off the
# subject's own error text). The announcement must name the resolution AND the
# tree that answered.
if printf '%s' "$A_OUTPUT" | rg -qF "Done-means resolved" \
  && printf '%s' "$A_OUTPUT" | rg -qF "$REVIEW_TREE"; then
  record c PASS "acceptance announced the resolution and named the answering tree"
else
  record c FAIL "acceptance did not announce which tree answered: $(printf '%s' "$A_OUTPUT" | tr '\n' ' ')"
fi

# --- (d) control: same-tree path, no review root ---------------------------
# Run from a neutral cwd so the ONLY tree that can answer is the validator's
# own. A fix that merely swapped "my tree" for "the cwd" fails here.
run_validator "$SCRATCH" "$(with_done_means "scripts/validate-pr-body.ts")"
if [ "$VALIDATOR_EXIT" -eq 0 ]; then
  record d PASS "path in the validator's own tree still accepted with no review root (exit=0)"
else
  record d FAIL "ordinary same-tree path was refused (exit=$VALIDATOR_EXIT): $(printf '%s' "$VALIDATOR_OUTPUT" | tr '\n' ' ')"
fi

# --- (e) branch fallback, with its paired negative -------------------------
if [ "$BRANCH_OK" != yes ]; then
  record e FAIL "harness could not build the branch under review: $(cat "$SCRATCH/git.err" 2>/dev/null | tr '\n' ' ')"
else
  # Positive: on disk nowhere the validator can see (cwd is the neutral scratch
  # dir, and the planted file is absent from REPO_ROOT), but committed on the
  # named ref.
  run_validator "$SCRATCH" "$(with_done_means "$PLANTED_REL")" \
    "PR_HEAD_REF=$BRANCH_UNDER_REVIEW" "PR_REPO_DIR=$REVIEW_TREE"
  E_POS_EXIT=$VALIDATOR_EXIT
  E_POS_OUTPUT="$VALIDATOR_OUTPUT"

  # Negative: the same machinery pointed at a ref that does NOT contain it.
  run_validator "$SCRATCH" "$(with_done_means "$PLANTED_REL")" \
    "PR_HEAD_REF=HEAD" "PR_REPO_DIR=$REPO_ROOT"
  E_NEG_EXIT=$VALIDATOR_EXIT
  E_NEG_OUTPUT="$VALIDATOR_OUTPUT"

  if [ "$E_POS_EXIT" -eq 0 ] && [ "$E_NEG_EXIT" -ne 0 ]; then
    record e PASS "committed-on-the-branch accepted (exit=0) while a ref without it is still refused (exit=$E_NEG_EXIT)"
  elif [ "$E_POS_EXIT" -ne 0 ]; then
    record e FAIL "path committed on the branch under review was refused (exit=$E_POS_EXIT): $(printf '%s' "$E_POS_OUTPUT" | tr '\n' ' ')"
  else
    record e FAIL "a ref NOT containing the path was accepted (exit=$E_NEG_EXIT) — the fallback is a blanket pass: $(printf '%s' "$E_NEG_OUTPUT" | tr '\n' ' ')"
  fi
fi

# ---------------------------------------------------------------------------
# Teardown. `git worktree remove` unregisters and removes together, which is
# why AGENTS.md carves it out from the no-delete rule; a plain delete would
# strand the .git/worktrees entry. Failure to remove is REPORTED, never hidden.
# ---------------------------------------------------------------------------
if ! git -C "$REPO_ROOT" worktree remove --force "$REVIEW_TREE" 2>"$SCRATCH/teardown.err"; then
  printf 'TEARDOWN-WARNING: review tree left at %s — %s\n' \
    "$REVIEW_TREE" "$(cat "$SCRATCH/teardown.err" | tr '\n' ' ')" >&2
fi
git -C "$REPO_ROOT" branch -q -D "$BRANCH_UNDER_REVIEW" 2>/dev/null

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
label_for() {
  case "$1" in
    a) printf 'path present only in the tree under review is ACCEPTED' ;;
    b) printf 'path present in NO tree is still REFUSED naming the rule' ;;
    c) printf 'the acceptance announces which tree answered' ;;
    d) printf 'ordinary same-tree path still passes with no review root' ;;
    e) printf 'committed-on-branch resolves; a ref without it still refuses' ;;
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
