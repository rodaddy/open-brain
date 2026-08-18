#!/usr/bin/env bash
# DONE-MEANS check for issue #720 — "validate-pr-body falls back to the
# validator's OWN tree, so a Done-means check absent from the branch under
# review passes on the primary checkout's copy".
#
#   bash scripts/done-means/720-validator-rejects-foreign-tree.sh
#
# ---------------------------------------------------------------------------
# THE DEFECT THIS GATES
# ---------------------------------------------------------------------------
# `scripts/validate-pr-body.ts` builds `OWN_TREE` from `import.meta.dir` and
# `requireDoneMeans` consults it as a FALLBACK when the tree under review does
# not carry the path. `.claude/hooks/pr-body-gate.ts` runs the PRIMARY
# checkout's copy of the validator, so `OWN_TREE` is always the primary
# checkout — a tree sitting on the integration branch that has accumulated
# EVERY done-means check ever merged.
#
# So a `Done-means:` path that exists in neither the tree under review nor on
# the branch under review PASSED, on the strength of a same-named file in a
# tree that is not being merged. That is #706's own defect — a gate judging
# from the wrong tree — surviving one layer deeper, in the fallback rather than
# the primary lookup. The gate printed "Done-means resolved" and the reader had
# no reason to doubt it.
#
# THE RULE THE FIX INSTALLS: when a head ref is known, the BRANCH answer is
# authoritative. A check absent from the branch under review is REFUSED with
# the truthful reason, even when a file of that path exists in the validator's
# own tree. The own-tree fallback may answer ONLY when no head ref exists at
# all — the ordinary "somebody ran the validator by hand" case — and its use is
# announced as such.
#
# ---------------------------------------------------------------------------
# WHICH TREE RUNS (lane-contract round 12/23)
# ---------------------------------------------------------------------------
# The subject IS a script, so "which copy executes" is the whole question.
# REPO_ROOT is resolved from THIS FILE's own location, so every invocation
# drives the validator shipping beside it and structurally cannot reach across
# trees. `OWN_TREE` inside those runs is therefore this checkout — which is
# what makes the foreign-tree clauses expressible at all.
#
# ---------------------------------------------------------------------------
# WHY THE FIXTURE IS SHAPED THIS WAY (round 30)
# ---------------------------------------------------------------------------
# A done-means check must drive the REAL invocation path AND stand in a fixture
# environment that can EXPRESS the defect. Both halves are load-bearing here:
#
#   * The real path is `.claude/hooks/pr-body-gate.ts` -> `bun validate-pr-body`
#     with `PR_REPO_DIR`/`PR_HEAD_REF` derived from a genuine `gh pr create`
#     command (clause 5). #706's own check called the validator directly and
#     stayed 5/5 GREEN through the #709 defect for exactly that reason.
#   * The environment must contain a path that lives in OWN_TREE and in NEITHER
#     the review tree NOR the branch under review. That is why the cited path
#     is an EXISTING check of this repo (`FOREIGN_REL` below) and the review
#     fixture is a standalone git repo that has never carried it. Planting a
#     file into this checkout instead would need a delete to clean up, which
#     AGENTS.md forbids outright.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   1  THE DEFECT (RED before the fix). A path present in the validator's OWN
#      tree, absent from the review tree AND absent from the resolvable head
#      ref, is REFUSED. Pre-fix this PASSED, announcing "resolved in the
#      validator's own tree".
#
#   2  ANNOUNCEMENT ON THE REFUSAL (round 28: assert on announcements or they
#      rot; round 29: print the gate's inputs on the REFUSAL path). The refusal
#      must say the branch was consulted and must NOT claim the own tree
#      answered. Anchored on markers the validator owns.
#
#   3  POSITIVE CONTROL — the review tree still answers. The same path present
#      in the REVIEW tree resolves, and the announcement NAMES the review tree.
#      A "fix" that simply refuses everything fails here.
#
#   4  BRANCH TIER UNBROKEN (#706 clause e / #714). A path on disk in NO tree
#      but committed on the head ref still resolves via `git cat-file -e`, and
#      the announcement names the branch. This is the tier the whole three-tier
#      design exists for; regressing it re-opens #706.
#
#   5  THE REAL PATH. The same foreign-tree citation driven through
#      `.claude/hooks/pr-body-gate.ts` with a genuine PreToolUse payload and a
#      real `gh pr create --head <branch>` command -> the hook BLOCKS. Without
#      this the fix could be correct in the validator and unreachable from the
#      only caller that runs.
#
#   6  ORDINARY SAME-TREE USE PRESERVED (#706 clause d). With NO head ref given
#      at all, a path in the validator's own tree still resolves — that is a
#      human running the validator by hand, where there is no branch answer to
#      be authoritative. The announcement must SAY the own tree answered and
#      that no head ref was available, so the weaker basis is visible
#      (AGENTS.md: nothing is adjusted silently). Passes pre-fix by design; it
#      is what stops a fix that deletes the fallback outright from reading as
#      success.
#
#   7  MUTANT CONTROL. A path present in NO tree and on NO ref is still refused
#      and the refusal still names Done-means. A fix that made the field
#      advisory would pass clauses 1-2 and destroy the gate.
#
# Exit 0 only when every clause passes. Exit 3 is a harness error (missing
# tool, unbuildable fixture), which is NOT a failure of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALIDATOR="$REPO_ROOT/scripts/validate-pr-body.ts"
HOOK="$REPO_ROOT/.claude/hooks/pr-body-gate.ts"
TEMPLATE="$REPO_ROOT/.github/pull_request_template.md"

SCRATCH_BASE="${OPENBRAIN_TEMP_WORKSPACE:-${DEV_TMP:-/Volumes/ThunderBolt/_tmp}}/open-brain/_scratch"
SCRATCH="$SCRATCH_BASE/720-validator-rejects-foreign-tree.$$"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
command -v git >/dev/null 2>&1 || fail_hard "git not on PATH"
[ -r "$VALIDATOR" ] || fail_hard "validator not readable at $VALIDATOR"
[ -r "$HOOK" ] || fail_hard "hook not readable at $HOOK"
[ -r "$TEMPLATE" ] || fail_hard "template not readable at $TEMPLATE"
mkdir -p "$SCRATCH" || fail_hard "cannot create scratch dir $SCRATCH"

# ---------------------------------------------------------------------------
# The foreign path: a real, committed check of THIS repo. It exists in the
# validator's own tree by construction, and the fixture below is a standalone
# repo that has never carried it — which is the whole asymmetry.
# ---------------------------------------------------------------------------
FOREIGN_REL="scripts/done-means/706-done-means-resolves-pr-head.sh"
[ -e "$REPO_ROOT/$FOREIGN_REL" ] \
  || fail_hard "fixture wrong: $FOREIGN_REL is absent from $REPO_ROOT, so clause 1 would be vacuous"

NOWHERE_REL="scripts/done-means/720-this-path-exists-nowhere-at-all.sh"
[ -e "$REPO_ROOT/$NOWHERE_REL" ] \
  && fail_hard "fixture wrong: the 'nowhere' path exists in $REPO_ROOT; clause 7 would be vacuous"

# ---------------------------------------------------------------------------
# Fixture: a standalone repo with a base branch and a lane branch. The lane
# branch carries ITS OWN check (for clause 4) and never carries FOREIGN_REL.
# `core.hooksPath` is pinned to a nonexistent directory so the fixture cannot
# inherit this operator's global hooks — round 29/#722: an unpinned fixture
# runs somebody else's hooks and every clause then measures the wrong thing.
# ---------------------------------------------------------------------------
FIXTURE="$SCRATCH/fixture"
LANE_TREE="$SCRATCH/lane-tree"
LANE_BRANCH="lane/720-fixture"
BRANCH_ONLY_REL="scripts/done-means/720-lane-only-check.sh"

build_fixture() {
  git init -q -b base "$FIXTURE" || return 1
  git -C "$FIXTURE" config user.email "done-means@open-brain.invalid" || return 1
  git -C "$FIXTURE" config user.name "720 done-means fixture" || return 1
  git -C "$FIXTURE" config core.hooksPath "$FIXTURE/.git/no-hooks" || return 1

  mkdir -p "$FIXTURE/scripts/done-means" || return 1
  printf 'base tree\n' > "$FIXTURE/README.md" || return 1
  git -C "$FIXTURE" add README.md || return 1
  git -C "$FIXTURE" commit -q -m "base commit" || return 1

  git -C "$FIXTURE" checkout -q -b "$LANE_BRANCH" || return 1
  printf '#!/usr/bin/env bash\n# the lane'\''s OWN check\nexit 0\n' \
    > "$FIXTURE/$BRANCH_ONLY_REL" || return 1
  git -C "$FIXTURE" add "$BRANCH_ONLY_REL" || return 1
  git -C "$FIXTURE" commit -q -m "lane: add the branch-only check" || return 1
  git -C "$FIXTURE" checkout -q base || return 1

  git -C "$FIXTURE" worktree add -q "$LANE_TREE" "$LANE_BRANCH" || return 1
}

build_fixture || fail_hard "could not build the fixture repo under $SCRATCH"

# Sanity: the fixture must genuinely express the asymmetry, or the clauses
# below measure nothing. FOREIGN_REL is in neither fixture tree nor on either
# fixture ref; BRANCH_ONLY_REL is on the lane branch and not in the base tree.
[ -e "$FIXTURE/$FOREIGN_REL" ] \
  && fail_hard "fixture wrong: $FOREIGN_REL is visible in the fixture base tree"
[ -e "$LANE_TREE/$FOREIGN_REL" ] \
  && fail_hard "fixture wrong: $FOREIGN_REL is visible in the fixture lane tree"
git -C "$FIXTURE" cat-file -e "$LANE_BRANCH:$FOREIGN_REL" 2>/dev/null \
  && fail_hard "fixture wrong: $FOREIGN_REL is committed on $LANE_BRANCH"
git -C "$FIXTURE" cat-file -e "$LANE_BRANCH:$BRANCH_ONLY_REL" 2>/dev/null \
  || fail_hard "fixture wrong: $BRANCH_ONLY_REL is not committed on $LANE_BRANCH"
[ -e "$FIXTURE/$BRANCH_ONLY_REL" ] \
  && fail_hard "fixture wrong: $BRANCH_ONLY_REL is visible in the fixture base tree"

# ---------------------------------------------------------------------------
# Bodies, built from the COMMITTED template the same way the sibling checks
# build theirs, so a clause here can only fail on the Done-means rule and never
# on unrelated template drift.
# ---------------------------------------------------------------------------
DUMMY="dummy specific content for the 720 acceptance gate"

fill_template() {
  local done_means_value="$1" out="$2"
  sed \
    -e 's/\[ \]\(.*\)or \[ \] not applicable because:.*$/[x]\1or [ ] not applicable because:/' \
    -e 's/^- \[ \]/- [x]/' \
    -e "s|^- Done-means:.*$|- Done-means: $done_means_value|" \
    -e "s/^\(- [^][]*:\)[[:space:]]*$/\1 $DUMMY/" \
    "$TEMPLATE" > "$out"
}

FOREIGN_BODY_FILE="$SCRATCH/foreign-body.md"
BRANCH_BODY_FILE="$SCRATCH/branch-body.md"
NOWHERE_BODY_FILE="$SCRATCH/nowhere-body.md"
OWN_BODY_FILE="$SCRATCH/own-body.md"

fill_template "$FOREIGN_REL" "$FOREIGN_BODY_FILE" || fail_hard "could not build the foreign body"
fill_template "$BRANCH_ONLY_REL" "$BRANCH_BODY_FILE" || fail_hard "could not build the branch body"
fill_template "$NOWHERE_REL" "$NOWHERE_BODY_FILE" || fail_hard "could not build the nowhere body"
fill_template "scripts/validate-pr-body.ts" "$OWN_BODY_FILE" || fail_hard "could not build the own body"

# Guard against a template whose Done-means line moved: a body with no
# Done-means line at all would make every clause below vacuous.
for body_file in "$FOREIGN_BODY_FILE" "$BRANCH_BODY_FILE" "$NOWHERE_BODY_FILE" "$OWN_BODY_FILE"; do
  rg -q '^- Done-means: \S' "$body_file" \
    || fail_hard "body $body_file carries no filled Done-means line; the template shape changed"
done

# run_validator <cwd> <body-file> [extra env assignments...]
# Always the REPO_ROOT validator; only cwd and environment move.
VALIDATOR_OUTPUT=""
VALIDATOR_EXIT=0
run_validator() {
  local cwd="$1" body_file="$2"
  shift 2
  VALIDATOR_OUTPUT="$(
    cd "$cwd" && env "$@" PR_BODY="$(cat "$body_file")" \
      PR_TITLE="720 validator rejects foreign tree" bun "$VALIDATOR" 2>&1
  )"
  VALIDATOR_EXIT=$?
}

CLAUSES=()
record() { CLAUSES+=("$1|$2|$3"); }

# --- 1 THE DEFECT ----------------------------------------------------------
# The exact shape the hook produces for a lane: review tree is the lane
# worktree, head ref is the lane branch, and the cited check lives only in the
# validator's own tree.
run_validator "$LANE_TREE" "$FOREIGN_BODY_FILE" \
  "PR_REPO_DIR=$LANE_TREE" "PR_HEAD_REF=$LANE_BRANCH"
C1_OUTPUT="$VALIDATOR_OUTPUT"
C1_EXIT="$VALIDATOR_EXIT"
if [ "$C1_EXIT" -ne 0 ]; then
  record 1 PASS "check absent from the review tree and from the head ref was REFUSED (exit=$C1_EXIT)"
else
  record 1 FAIL "check absent from the branch under review PASSED on the validator's own tree (exit=0): $(printf '%s' "$C1_OUTPUT" | tr '\n' ' ')"
fi

# --- 2 THE REFUSAL IS TRUTHFUL AND ANNOUNCED -------------------------------
# Two directions, because either alone is satisfiable by an unhelpful fix:
# the refusal must NOT claim the own tree resolved it, and it MUST say the
# branch was consulted so the reader knows the authoritative answer was asked.
if printf '%s' "$C1_OUTPUT" | rg -qF "the validator's own tree"; then
  record 2 FAIL "the refusal still credits the validator's own tree: $(printf '%s' "$C1_OUTPUT" | tr '\n' ' ')"
elif ! printf '%s' "$C1_OUTPUT" | rg -qF 'looked in:'; then
  # The shared marker `709-hook-feeds-head-ref.sh` clause 4 asserts on. A
  # refusal that stops saying where it looked is a dead end, and this fix must
  # not quietly drop it while adding a new refusal path.
  record 2 FAIL "refused but never says where it looked — a dead-end refusal: $(printf '%s' "$C1_OUTPUT" | tr '\n' ' ')"
elif printf '%s' "$C1_OUTPUT" | rg -qF "Done-means" \
  && printf '%s' "$C1_OUTPUT" | rg -qF "$LANE_BRANCH"; then
  record 2 PASS "refusal names the Done-means rule, says where it looked, and names the head ref it consulted ($LANE_BRANCH)"
else
  record 2 FAIL "refusal does not name the rule and the consulted ref: $(printf '%s' "$C1_OUTPUT" | tr '\n' ' ')"
fi

# --- 3 POSITIVE CONTROL: the review tree still answers ----------------------
run_validator "$LANE_TREE" "$BRANCH_BODY_FILE" \
  "PR_REPO_DIR=$LANE_TREE" "PR_HEAD_REF=$LANE_BRANCH"
if [ "$VALIDATOR_EXIT" -eq 0 ] \
  && printf '%s' "$VALIDATOR_OUTPUT" | rg -qF "Done-means resolved" \
  && printf '%s' "$VALIDATOR_OUTPUT" | rg -qF "$LANE_TREE"; then
  record 3 PASS "path present in the review tree resolved and the note named that tree (exit=0)"
else
  record 3 FAIL "path present in the review tree did not resolve with a tree-naming note (exit=$VALIDATOR_EXIT): $(printf '%s' "$VALIDATOR_OUTPUT" | tr '\n' ' ')"
fi

# --- 4 BRANCH TIER UNBROKEN ------------------------------------------------
# On disk in no tree the validator can see (cwd and PR_REPO_DIR are the base
# checkout, which does not carry the file), but committed on the head ref.
[ -e "$FIXTURE/$BRANCH_ONLY_REL" ] \
  && fail_hard "clause 4 vacuous: $BRANCH_ONLY_REL became visible in the base tree"
run_validator "$FIXTURE" "$BRANCH_BODY_FILE" \
  "PR_REPO_DIR=$FIXTURE" "PR_HEAD_REF=$LANE_BRANCH"
if [ "$VALIDATOR_EXIT" -eq 0 ] \
  && printf '%s' "$VALIDATOR_OUTPUT" | rg -qF "Done-means resolved in branch $LANE_BRANCH"; then
  record 4 PASS "path committed on the head ref still resolved via the branch tier, announced (exit=0)"
else
  record 4 FAIL "the branch tier regressed (#706/#714) (exit=$VALIDATOR_EXIT): $(printf '%s' "$VALIDATOR_OUTPUT" | tr '\n' ' ')"
fi

# --- 5 THE REAL PATH: through the hook -------------------------------------
# A genuine PreToolUse payload whose cwd is the FIXTURE BASE checkout (the
# session's directory — round 29: the payload cwd is the session's, not the
# command's) and a real `gh pr create --head <branch>` naming the lane branch.
# The hook derives PR_REPO_DIR and PR_HEAD_REF itself; nothing here supplies
# them, which is the difference between this clause and clause 1.
HOOK_EXIT=0
HOOK_STDERR=""
run_hook() {
  local command_text="$1" payload_cwd="$2" payload
  payload="$(
    COMMAND_TEXT="$command_text" PAYLOAD_CWD="$payload_cwd" bun -e '
      process.stdout.write(JSON.stringify({
        session_id: "720-validator-rejects-foreign-tree",
        cwd: process.env.PAYLOAD_CWD ?? "",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: process.env.COMMAND_TEXT ?? "" },
      }));
    '
  )" || return 1
  HOOK_STDERR="$(printf '%s' "$payload" | bun "$HOOK" 2>&1 >/dev/null)"
  HOOK_EXIT=$?
  return 0
}

HOOK_CMD="cd $LANE_TREE && gh pr create --head $LANE_BRANCH --title 'foreign tree' --body-file $FOREIGN_BODY_FILE"
if ! run_hook "$HOOK_CMD" "$FIXTURE"; then
  record 5 FAIL "harness could not build the hook payload"
elif [ "$HOOK_EXIT" -ne 0 ] \
  && printf '%s' "$HOOK_STDERR" | rg -qF "BLOCKED"; then
  record 5 PASS "the real hook BLOCKED a body citing a check absent from the branch (exit=$HOOK_EXIT)"
else
  record 5 FAIL "the real hook ALLOWED a body citing a check absent from the branch (exit=$HOOK_EXIT): $(printf '%s' "$HOOK_STDERR" | tr '\n' ' ')"
fi

# --- 6 ORDINARY SAME-TREE USE PRESERVED (#706 clause d) --------------------
# Neutral cwd, NO head ref: nothing authoritative exists to be overruled, so
# the own tree may answer — and must say so, including that no head ref was
# available, so the weaker basis is visible rather than silent.
run_validator "$SCRATCH" "$OWN_BODY_FILE"
C6_OUTPUT="$VALIDATOR_OUTPUT"
if [ "$VALIDATOR_EXIT" -ne 0 ]; then
  record 6 FAIL "the ordinary no-head-ref same-tree path was refused (exit=$VALIDATOR_EXIT): $(printf '%s' "$C6_OUTPUT" | tr '\n' ' ')"
elif printf '%s' "$C6_OUTPUT" | rg -qF "the validator's own tree" \
  && printf '%s' "$C6_OUTPUT" | rg -qF "no head ref"; then
  record 6 PASS "with no head ref the own tree still answered, announcing both the tree and the absent head ref (exit=0)"
else
  record 6 FAIL "the own-tree answer did not announce its weaker basis: $(printf '%s' "$C6_OUTPUT" | tr '\n' ' ')"
fi

# --- 7 MUTANT CONTROL ------------------------------------------------------
run_validator "$LANE_TREE" "$NOWHERE_BODY_FILE" \
  "PR_REPO_DIR=$LANE_TREE" "PR_HEAD_REF=$LANE_BRANCH"
if [ "$VALIDATOR_EXIT" -ne 0 ] && printf '%s' "$VALIDATOR_OUTPUT" | rg -qF "Done-means"; then
  record 7 PASS "path present in no tree and on no ref is still refused naming the rule (exit=$VALIDATOR_EXIT)"
else
  record 7 FAIL "path present nowhere was NOT refused by the Done-means rule (exit=$VALIDATOR_EXIT): $(printf '%s' "$VALIDATOR_OUTPUT" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------------------
# Teardown. `git worktree remove` unregisters and removes together — the one
# delete-shaped operation AGENTS.md carves out, because a plain delete strands
# the .git/worktrees entry. The scratch tree itself is LEFT IN PLACE under the
# temp workspace; this check never deletes.
# ---------------------------------------------------------------------------
if ! git -C "$FIXTURE" worktree remove --force "$LANE_TREE" 2>"$SCRATCH/teardown.err"; then
  printf 'TEARDOWN-WARNING: fixture lane tree left at %s — %s\n' \
    "$LANE_TREE" "$(tr '\n' ' ' < "$SCRATCH/teardown.err")" >&2
fi
printf 'NOTE: fixture retained at %s (this check never deletes; AGENTS.md).\n' "$SCRATCH" >&2

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
label_for() {
  case "$1" in
    1) printf 'check absent from the branch under review is REFUSED' ;;
    2) printf 'the refusal is truthful and names the consulted ref' ;;
    3) printf 'POSITIVE CONTROL: the review tree still answers, named' ;;
    4) printf 'BRANCH TIER UNBROKEN: committed-on-head still resolves' ;;
    5) printf 'REAL PATH: the hook itself blocks the foreign-tree citation' ;;
    6) printf 'no head ref -> own tree may answer, announcing its basis' ;;
    7) printf 'MUTANT CONTROL: present nowhere is still refused' ;;
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
