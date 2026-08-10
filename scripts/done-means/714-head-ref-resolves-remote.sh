#!/usr/bin/env bash
# DONE-MEANS check for issue #714 — a `--head` the hook cannot RESOLVE is not a
# head ref, and feeding it is the same dead branch tier by a different route.
#
#   bash scripts/done-means/714-head-ref-resolves-remote.sh
#
# ---------------------------------------------------------------------------
# The defect this gates, and how it differs from what #714 was FILED as
# ---------------------------------------------------------------------------
# #714 was filed against pre-#709 code and claims `pr-body-gate.ts` "never sets
# PR_HEAD_REF, so the validator's branch tier is dead". That premise is STALE:
# PR #713 landed the #709 fix, the hook parses `--head`/`-H` and derives a
# branch from the cd target, and `scripts/done-means/709-hook-feeds-head-ref.sh`
# is 5/5 GREEN holding it there.
#
# Re-verifying the premise (canon: an issue older than the current code
# re-verifies before implementation) found the residue is NARROWER and real:
#
#   the hook feeds the `--head` value THROUGH UNTOUCHED, and `gh pr create
#   --head <branch>` names a branch on the REMOTE. In a checkout that has
#   fetched but never created a local branch of that name — the primary, which
#   is exactly where a lane runs `gh pr create --head <branch>` from without a
#   `cd` and without a worktree on disk — the bare name resolves to nothing:
#
#     $ git cat-file -e lane/714-fixture:scripts/done-means/lane-only-check.sh
#     fatal: invalid object name 'lane/714-fixture'.        # exit 128
#     $ git cat-file -e origin/lane/714-fixture:...          # exit 0
#
# So the branch tier IS fed, and still cannot answer. The refusal even prints
# `; and in ref lane/714-fixture`, which reads as "your check is not on the
# branch either" when the truth is "that ref does not name anything here" —
# a refusal that misdirects is worse than one that admits it looked nowhere.
#
# Measured 2026-08-10 against the hook at 17ada37 with the fixture below.
#
# ---------------------------------------------------------------------------
# Why this check drives the HOOK, and with a REAL remote
# ---------------------------------------------------------------------------
# Round 28: A SEAM ADDED TO MAKE A GATE TESTABLE IS NOT THE PATH THAT RUNS.
# `709-hook-feeds-head-ref.sh` clause 3 already drives `--head` through the real
# hook and passes — because its fixture has the lane branch LOCALLY, so the bare
# name resolves. That is the false-green: the clause proves `--head` is parsed,
# never that the parsed value is RESOLVABLE in the tree being asked. The
# asymmetry only appears with a genuine remote, so this fixture builds one
# (bare upstream + clone) rather than faking the ref layout.
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
#   1  `gh pr create --head <branch>` from a checkout where the branch exists
#      ONLY as `origin/<branch>`, citing a check committed only on that branch,
#      with no `cd` and no worktree on disk -> ALLOWED, and the announcement
#      names the ref that actually answered.
#      RED before the fix: refused, `; and in ref <branch>` present.
#   2  a `--head` value that ALREADY carries the remote prefix
#      (`--head origin/<branch>`) still resolves. The fix must not mangle a ref
#      that was correct on arrival — no double-prefixing.
#   3  MUTANT CONTROL: same remote-only shape, citing a path committed on NO
#      branch and present in NO tree -> still REFUSED, naming the path. A fix
#      that widens WHERE a path may resolve must never widen WHAT may be named;
#      this clause fails if anyone "fixes" #714 by making the field advisory.
#   4  MUTANT CONTROL (containment): a `--head` naming a branch that does not
#      exist at all, local or remote -> the head ref must not be announced as
#      resolvable, and the body citing a branch-only check is REFUSED. Proves
#      the fix asserts POSITIVELY on the ref (round 28: a lookup whose failure
#      is indistinguishable from its empty case must be asserted on positively)
#      rather than blindly prepending `origin/` and hoping.
#   5  the ref the hook SETTLED ON is announced, including when it differs from
#      what the command said (AGENTS.md 2026-08-08, nothing is adjusted
#      silently: `--head lane/x` becoming `origin/lane/x` is a self-made
#      decision, and an invisible one cannot be checked). Round 28: assert on
#      announcements or they rot silently.
#   6  REGRESSION: a LOCAL branch name still resolves without an origin remote
#      in play. The fix must not make local-branch resolution depend on a
#      remote that a plain checkout may not have.
#
# Exit 0 only when every clause passes. Exit 3 is a harness error (missing tool,
# unbuildable fixture), which is NOT a fail of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$REPO_ROOT/.claude/hooks/pr-body-gate.ts"
TEMPLATE="$REPO_ROOT/.github/pull_request_template.md"
VALIDATOR="$REPO_ROOT/scripts/validate-pr-body.ts"

SCRATCH_BASE="${OPENBRAIN_TEMP_WORKSPACE:-${DEV_TMP:-/Volumes/ThunderBolt/_tmp}}/open-brain/_scratch"
SCRATCH="$SCRATCH_BASE/714-head-ref-resolves-remote.$$"

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
# Fixture: a REAL remote. bare upstream <- seed (pushes the lane branch) and a
# PRIMARY clone that has fetched it but holds no local branch of that name and
# no worktree on disk. That is the shape `gh pr create --head <branch>` is run
# in from a root checkout, and the only shape where the bare name is unresolvable.
# ---------------------------------------------------------------------------
UPSTREAM="$SCRATCH/upstream.git"
SEED="$SCRATCH/seed"
PRIMARY="$SCRATCH/primary"
LANE_BRANCH="lane/714-fixture"
BRANCH_ONLY_CHECK="scripts/done-means/lane-only-check.sh"

build_fixture() {
  git init -q --bare -b base "$UPSTREAM" || return 1

  git init -q -b base "$SEED" || return 1
  git -C "$SEED" config user.email "done-means@open-brain.invalid" || return 1
  git -C "$SEED" config user.name "714 done-means fixture" || return 1
  # A scratch repo must not run this repo's hooks; that would measure the wrong
  # thing entirely.
  git -C "$SEED" config core.hooksPath "$SEED/.git/no-hooks" || return 1

  mkdir -p "$SEED/scripts/done-means" || return 1
  printf 'base tree\n' > "$SEED/README.md" || return 1
  git -C "$SEED" add README.md || return 1
  git -C "$SEED" commit -q -m "base commit" || return 1
  git -C "$SEED" remote add origin "$UPSTREAM" || return 1
  git -C "$SEED" push -q origin base || return 1

  git -C "$SEED" checkout -q -b "$LANE_BRANCH" || return 1
  printf '#!/usr/bin/env bash\nexit 0\n' > "$SEED/$BRANCH_ONLY_CHECK" || return 1
  git -C "$SEED" add "$BRANCH_ONLY_CHECK" || return 1
  git -C "$SEED" commit -q -m "lane: add the branch-only check" || return 1
  git -C "$SEED" push -q origin "$LANE_BRANCH" || return 1

  git clone -q -b base "$UPSTREAM" "$PRIMARY" || return 1
  git -C "$PRIMARY" config core.hooksPath "$PRIMARY/.git/no-hooks" || return 1
}

build_fixture || fail_hard "could not build the fixture repo under $SCRATCH"

# Sanity: the fixture must genuinely express the asymmetry, or every clause
# below measures nothing. This is the whole defect, stated as three facts.
[ -e "$PRIMARY/$BRANCH_ONLY_CHECK" ] \
  && fail_hard "fixture wrong: the branch-only check is on disk in the primary clone"
git -C "$PRIMARY" rev-parse --verify --quiet "$LANE_BRANCH" >/dev/null 2>&1 \
  && fail_hard "fixture wrong: $LANE_BRANCH exists LOCALLY in the primary clone — the bare name would resolve and the defect would be invisible"
git -C "$PRIMARY" rev-parse --verify --quiet "origin/$LANE_BRANCH" >/dev/null 2>&1 \
  || fail_hard "fixture wrong: origin/$LANE_BRANCH does not resolve in the primary clone"
git -C "$PRIMARY" cat-file -e "origin/$LANE_BRANCH:$BRANCH_ONLY_CHECK" 2>/dev/null \
  || fail_hard "fixture wrong: the branch-only check is not committed on origin/$LANE_BRANCH"

# ---------------------------------------------------------------------------
# Bodies, built from the committed template exactly the way
# scripts/done-means/709-hook-feeds-head-ref.sh builds its own, so this check
# inherits the template's guarantee rather than maintaining a second field list.
# ---------------------------------------------------------------------------
DUMMY="dummy specific content for the 714 acceptance gate"

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

# Sanity on the MUTANT CONTROL fixture: absent from every tree and every ref, or
# clause 3 proves nothing.
[ -e "$PRIMARY/$NOWHERE_PATH" ] && fail_hard "fixture wrong: the 'nowhere' path exists in the primary clone"
[ -e "$REPO_ROOT/$NOWHERE_PATH" ] && fail_hard "fixture wrong: the 'nowhere' path exists in this repo"
if git -C "$PRIMARY" cat-file -e "origin/$LANE_BRANCH:$NOWHERE_PATH" 2>/dev/null; then
  fail_hard "fixture wrong: the 'nowhere' path is committed on origin/$LANE_BRANCH"
fi

# ---------------------------------------------------------------------------
# Drive the REAL hook the way Claude Code does: a PreToolUse JSON payload on
# stdin whose cwd is the PRIMARY clone. Sets HOOK_EXIT and HOOK_STDERR.
# ---------------------------------------------------------------------------
HOOK_EXIT=0
HOOK_STDERR=""
run_hook() {
  local command_text="$1" payload_cwd="$2" payload
  payload="$(
    COMMAND_TEXT="$command_text" PAYLOAD_CWD="$payload_cwd" bun -e '
      process.stdout.write(JSON.stringify({
        session_id: "714-head-ref-resolves-remote",
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
  for c in 1 2 3 4 5 6; do
    record "$c" FAIL "no hook at $HOOK — nothing resolves anything"
  done
else
  # -- CLAUSE 1: the reported shape. --head <branch>, remote-only, no cd. ------
  run_hook "gh pr create --head $(q "$LANE_BRANCH") --title 'feat: lane thing' --body-file $(q "$BRANCH_BODY_FILE")" "$PRIMARY"
  if [ "$HOOK_EXIT" -ne 0 ]; then
    record 1 FAIL "REFUSED (exit=$HOOK_EXIT) — a --head naming a remote-only branch does not resolve: $(printf '%s' "$HOOK_STDERR" | tr '\n' ' ' | cut -c1-300)"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qF "resolved in branch"; then
    record 1 FAIL "allowed, but the BRANCH tier never announced — something else answered, so the remote ref is still unproven"
  else
    record 1 PASS "--head naming a remote-only branch resolved via the branch tier and announced it (exit=0)"
  fi

  # -- CLAUSE 2: an already-correct ref is not mangled -------------------------
  run_hook "gh pr create --head $(q "origin/$LANE_BRANCH") --title 'feat: lane thing' --body-file $(q "$BRANCH_BODY_FILE")" "$PRIMARY"
  if [ "$HOOK_EXIT" -ne 0 ]; then
    record 2 FAIL "REFUSED (exit=$HOOK_EXIT) — an explicit origin/<branch> was mangled (double-prefixed?): $(printf '%s' "$HOOK_STDERR" | tr '\n' ' ' | cut -c1-300)"
  elif printf '%s' "$HOOK_STDERR" | rg -qF "origin/origin/"; then
    record 2 FAIL "allowed, but the announcement shows a double-prefixed ref (origin/origin/...)"
  else
    record 2 PASS "an explicit origin/<branch> resolves untouched, no double-prefixing (exit=0)"
  fi

  # -- CLAUSE 3: MUTANT CONTROL. Nowhere path is still REFUSED ----------------
  run_hook "gh pr create --head $(q "$LANE_BRANCH") --title 'feat: lane thing' --body-file $(q "$NOWHERE_BODY_FILE")" "$PRIMARY"
  if [ "$HOOK_EXIT" -ne 2 ]; then
    record 3 FAIL "a nonexistent Done-means path was ALLOWED (exit=$HOOK_EXIT) — widening resolution became a blanket pass"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qF "$NOWHERE_PATH"; then
    record 3 FAIL "refused but never names the offending path"
  else
    record 3 PASS "nonexistent Done-means path still REFUSED, naming the path (exit=2)"
  fi

  # -- CLAUSE 4: MUTANT CONTROL. A --head that names nothing at all -----------
  # The fix must ASSERT that the ref it settled on resolves, not assume that
  # prepending origin/ makes any string into a ref. A body citing a branch-only
  # check must still be refused here, since no tree and no reachable ref has it.
  GHOST_BRANCH="lane/714-this-branch-does-not-exist"
  git -C "$PRIMARY" rev-parse --verify --quiet "$GHOST_BRANCH" >/dev/null 2>&1 \
    && fail_hard "fixture wrong: the ghost branch exists locally"
  git -C "$PRIMARY" rev-parse --verify --quiet "origin/$GHOST_BRANCH" >/dev/null 2>&1 \
    && fail_hard "fixture wrong: the ghost branch exists as a remote-tracking ref"

  run_hook "gh pr create --head $(q "$GHOST_BRANCH") --title 'feat: lane thing' --body-file $(q "$BRANCH_BODY_FILE")" "$PRIMARY"
  if [ "$HOOK_EXIT" -ne 2 ]; then
    record 4 FAIL "a --head naming no existing ref was ALLOWED (exit=$HOOK_EXIT) — the ref is not being asserted on positively"
  elif printf '%s' "$HOOK_STDERR" | rg -qF "and in ref $GHOST_BRANCH"; then
    record 4 FAIL "refused, but the refusal claims it looked 'in ref $GHOST_BRANCH' — a ref that resolves to nothing; the message misdirects"
  else
    record 4 PASS "a --head naming no existing ref is REFUSED without claiming to have consulted it (exit=2)"
  fi

  # -- CLAUSE 5: the SETTLED ref is announced, adjustment and all -------------
  # `--head lane/x` resolved as `origin/lane/x` is the hook deciding something
  # for itself. AGENTS.md 2026-08-08: original -> adjusted, and why, in the
  # normal output. Round 28: assert on announcements or they rot.
  run_hook "gh pr create --head $(q "$LANE_BRANCH") --title 'feat: lane thing' --body-file $(q "$BRANCH_BODY_FILE")" "$PRIMARY"
  if ! printf '%s' "$HOOK_STDERR" | rg -qF "origin/$LANE_BRANCH"; then
    record 5 FAIL "the ref the hook settled on (origin/$LANE_BRANCH) is never named — a silent adjustment: $(printf '%s' "$HOOK_STDERR" | tr '\n' ' ' | cut -c1-300)"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qF "$LANE_BRANCH" ; then
    record 5 FAIL "the announcement never names the branch the command asked for"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qi -e 'head ref'; then
    record 5 FAIL "no head-ref announcement line at all"
  else
    record 5 PASS "the hook announces the ref it settled on, naming both what --head said and what resolved"
  fi

  # -- CLAUSE 6: REGRESSION. A local branch still resolves --------------------
  # The seed repo is checked out ON the lane branch and the file is committed
  # there. Resolution must not have become remote-dependent.
  run_hook "cd $(q "$SEED") && gh pr create --title 'feat: lane thing' --body-file $(q "$BRANCH_BODY_FILE")" "$PRIMARY"
  if [ "$HOOK_EXIT" -ne 0 ]; then
    record 6 FAIL "REFUSED (exit=$HOOK_EXIT) — local resolution regressed: $(printf '%s' "$HOOK_STDERR" | tr '\n' ' ' | cut -c1-300)"
  else
    record 6 PASS "a checkout carrying the branch locally still resolves (exit=0), no remote dependency introduced"
  fi
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
label_for() {
  case "$1" in
    1) printf 'a --head naming a REMOTE-ONLY branch resolves' ;;
    2) printf 'an explicit origin/<branch> is not mangled' ;;
    3) printf 'MUTANT CONTROL: a path on no ref is still REFUSED' ;;
    4) printf 'MUTANT CONTROL: a --head naming nothing is not claimed as consulted' ;;
    5) printf 'the ref the hook settled on is announced, never silent' ;;
    6) printf 'REGRESSION: a local branch still resolves' ;;
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

# Fixture teardown. ARCHIVED, never deleted — AGENTS.md, the agent's cleanup
# verb is mv.
ARCHIVE_DIR="${OPENBRAIN_TEMP_WORKSPACE:-${DEV_TMP:-/Volumes/ThunderBolt/_tmp}}/open-brain/_archive"
if mkdir -p "$ARCHIVE_DIR" 2>/dev/null; then
  mv "$SCRATCH" "$ARCHIVE_DIR/$(basename "$SCRATCH").$(date +%s)" 2>/dev/null
fi

[ "$ALL_PASS" -eq 1 ] && exit 0
exit 1
