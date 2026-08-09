#!/usr/bin/env bash
# DONE-MEANS check for issue #667 — "lane-bootstrap gains a CONTINUATION mode
# for an already-existing branch" (operator ruling 2026-08-08, ledger 30.2).
#
#   bash scripts/done-means/667-lane-bootstrap-continuation.sh
#
# ---------------------------------------------------------------------------
# THE GAP THIS CLOSES
# ---------------------------------------------------------------------------
# scripts/lane-bootstrap.ts hard-codes `git worktree add -b <branch> <path>
# origin/main`. `-b` means CREATE, so the moment the named branch already
# exists git refuses and the script fatals — verifiable at the pre-fix tree:
#
#   $ rg -n "\"-b\"," scripts/lane-bootstrap.ts
#   305:    "-b",
#
# Every continuation lane therefore hand-replicates fetch / worktree-add-
# WITHOUT--b / .env copy / bun install --frozen-lockfile. Hand-building lane
# environments is the exact failure ledger item 15 exists to stop, and round
# 21's Tightening records the interim hand-build recipe as a known tax.
#
# Scope note carried from the issue: ledger item 15's TEARDOWN rejection still
# stands. This is bootstrap-side only. Clause (e) pins that teardown is still
# printed and never executed, so a continuation mode cannot smuggle in the
# thing the operator turned down.
#
# ---------------------------------------------------------------------------
# WHICH TREE RUNS (round 12)
# ---------------------------------------------------------------------------
# The subject under test is a SCRIPT, so "which copy executes" is the whole
# question. Every invocation below runs `bun "$REPO_ROOT/scripts/lane-bootstrap.ts"`
# where REPO_ROOT is resolved from THIS FILE's own location — so the check
# always drives the copy that ships alongside it. Running this file from a lane
# worktree tests that worktree's script; running it from the primary checkout
# tests the primary checkout's. It never reaches across trees.
#
# The worktrees this check creates are registered against REPO_ROOT's git dir.
# A lane worktree shares the primary checkout's object store, so a branch
# created here is visible to `git branch` everywhere — which is precisely why
# every branch, worktree, and database name below carries this run's RUN_ID and
# why teardown refuses to touch a name lacking it.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) CONTINUATION. A branch that already EXISTS locally and is IN SYNC with
#       its origin counterpart bootstraps successfully, and the resulting
#       worktree is checked out ON that branch at exactly that branch's SHA —
#       not on a fresh branch, not reset to origin/main. Asserted from the
#       worktree itself (`git rev-parse HEAD` / `git branch --show-current`),
#       never from the script's own report: a script claiming LANE READY is the
#       thing under test, so its self-report is not admissible (the same rule
#       lane-bootstrap-known-good.sh clause 2 was written under). The lane's
#       distinguishing commit must be PRESENT in the worktree — that is what
#       separates "continued the branch" from "silently cut a new one at
#       origin/main", which would otherwise satisfy a naive branch-name check.
#       RED pre-fix: the script fatals at `worktree add -b` on an existing branch.
#
#   (b) CONTROL — the FRESH-branch path is unchanged. A never-before-seen
#       branch name still bootstraps, still lands on a new branch, and still
#       sits at origin/main's SHA. Passes PRE-fix by design. Without it, a
#       "continuation mode" that made every run a continuation (or that
#       silently dropped -b for all cases and stopped branching from
#       origin/main) would look like success.
#
#   (c) DIVERGENCE IS REFUSED, LOUDLY, BEFORE ANYTHING IS CREATED. A local
#       branch whose tip differs from origin's must be refused with a NON-ZERO
#       exit, and the refusal must NAME BOTH SHAs — local and origin — because
#       a refusal that does not tell the operator what to reconcile is a dead
#       end (round 15's dead-end-error class). Never a silent reset: the
#       diverged local commit must SURVIVE the refused run.
#
#       Plant-and-survive (round 16: "a guard needs a canary, not just an
#       exception"). "Throws on divergence" and "refuses BEFORE mutating" are
#       different claims, and only the second is what the issue asks for. So:
#       the divergent commit is planted, the run is refused, and afterwards we
#       assert (1) the local branch STILL points at the planted SHA and (2) NO
#       worktree exists at the path the run would have used, and (3) git's own
#       worktree registry has no entry for it. Assertion (3) is not redundant
#       with (2): a created-then-cleaned worktree leaves a registration behind,
#       and a directory check alone would call that a clean refusal.
#
#   (d) CONTROL — the LEFTOVER-WORKTREE refusal is unchanged. With a worktree
#       already present at the target path, the run is refused non-zero and
#       names the path, even for an existing in-sync branch. Passes PRE-fix by
#       design. Continuation mode must not be read as permission to reuse or
#       clobber a directory that may be a live lane; the existsSync guard is a
#       separate rule from the branch rule and this clause keeps them separate.
#
#   (e) NOTHING SILENTLY (AGENTS.md coding standards, operator ruling
#       2026-08-08) — and teardown still printed, never executed. The
#       continuation run must NAME the states it inspected and declined to
#       touch: that the branch already existed (rather than being created), and
#       that local and origin were verified in sync at a named SHA. A
#       continuation that looks identical to a fresh cut in the transcript is
#       the adjusted-silently defect; the operator reading the lane transcript
#       must be able to tell which path ran.
#
#       BOTH HALVES IN ONE CLAUSE, and mutation-relevant: it also asserts the
#       fresh run does NOT claim to have continued anything. Split apart, a
#       banner printed unconditionally on every run passes the "names it" half
#       while telling the reader nothing — announcement noise is silence with
#       extra steps (round 18). Teardown is folded in here as the scope pin:
#       the continuation output still carries `git worktree remove`, and the
#       worktree still exists on disk after the run.
#
# ---------------------------------------------------------------------------
# CLEANUP OWNERSHIP
# ---------------------------------------------------------------------------
# This check creates the worktrees and branches below, so this check removes
# them — `git worktree remove` is the agent-owned cleanup for a worktree the
# agent created (AGENTS.md). Every artifact carries this run's RUN_ID and
# teardown REFUSES any name without it. Nothing here uses `rm` of any spelling.
#
# EXPECTED TO FAIL (RED) at the pre-fix tree, on clauses (a) and (c) and (e),
# with (b) and (d) green — a check that fails everywhere proves only that it
# fails (round 13).
set -uo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SCRIPT_ABS="$REPO_ROOT/scripts/lane-bootstrap.ts"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
command -v git >/dev/null 2>&1 || fail_hard "git not on PATH"
[ -e "$REPO_ROOT/.git" ] || fail_hard "REPO_ROOT=$REPO_ROOT is not a git checkout"
[ -f "$SCRIPT_ABS" ] || fail_hard "no lane-bootstrap at $SCRIPT_ABS"

# The script places worktrees under $WS/open-brain/_worktrees. Pin the same
# resolution the script uses so the check knows where to look, and pin the
# variable explicitly so the script's own fallback ADJUSTED path (round 11) is
# not silently in play during the check.
WORKSPACE="${OPENBRAIN_TEMP_WORKSPACE:-${DEV_TMP:-/Volumes/ThunderBolt/_tmp}}"
export OPENBRAIN_TEMP_WORKSPACE="$WORKSPACE"
WORKTREE_BASE="$WORKSPACE/open-brain/_worktrees"
mkdir -p "$WORKTREE_BASE" || fail_hard "cannot create $WORKTREE_BASE"

RUN_ID="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"

BR_CONT="donemeans-667-${RUN_ID}-cont"
BR_FRESH="donemeans-667-${RUN_ID}-fresh"
BR_DIV="donemeans-667-${RUN_ID}-div"
BR_LEFT="donemeans-667-${RUN_ID}-left"

WT_CONT="${WORKTREE_BASE}/${BR_CONT}"
WT_FRESH="${WORKTREE_BASE}/${BR_FRESH}"
WT_DIV="${WORKTREE_BASE}/${BR_DIV}"
WT_LEFT="${WORKTREE_BASE}/${BR_LEFT}"

CREATED_WTS=()
CREATED_BRS=()
CREATED_REMOTE_BRS=()

teardown() {
  for wt in "${CREATED_WTS[@]:-}"; do
    [ -n "$wt" ] || continue
    case "$wt" in
      *"$RUN_ID"*) git -C "$REPO_ROOT" worktree remove --force "$wt" >/dev/null 2>&1 ;;
      *) printf 'REFUSING to remove unexpected worktree: %s\n' "$wt" >&2 ;;
    esac
  done
  git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1
  for br in "${CREATED_BRS[@]:-}"; do
    [ -n "$br" ] || continue
    case "$br" in
      *"$RUN_ID"*) git -C "$REPO_ROOT" branch -D "$br" >/dev/null 2>&1 ;;
      *) printf 'REFUSING to delete unexpected branch: %s\n' "$br" >&2 ;;
    esac
  done
  # Remote-tracking refs are fabricated locally (see below); retire them the
  # same way, by RUN_ID only. No network push ever happens in this check.
  for rb in "${CREATED_REMOTE_BRS[@]:-}"; do
    [ -n "$rb" ] || continue
    case "$rb" in
      *"$RUN_ID"*) git -C "$REPO_ROOT" update-ref -d "refs/remotes/origin/$rb" >/dev/null 2>&1 ;;
      *) printf 'REFUSING to delete unexpected remote ref: %s\n' "$rb" >&2 ;;
    esac
  done
}
trap teardown EXIT

# ---------------------------------------------------------------------------
# Fixture construction.
#
# A continuation lane needs a branch that exists BOTH locally and on origin and
# whose tips agree. Pushing test branches to the real GitHub remote to obtain
# that would be a network mutation of a shared resource for a local check, so
# instead the origin side is fabricated as a local remote-tracking ref
# (refs/remotes/origin/<name>). That is the same ref the script must consult —
# `git rev-parse origin/<branch>` reads exactly this — so the fixture exercises
# the real comparison, and the pre-fix `git fetch origin` in the script does
# not disturb it because these names do not exist on the actual remote.
#
# ANNOUNCED ADJUSTMENT (nothing silently): the origin side of every fixture
# branch here is a locally-written remote-tracking ref, not a pushed branch.
# The property under test — "local tip vs origin tip, agree or diverge" — is
# preserved exactly; what is NOT exercised is the network fetch itself.
# ---------------------------------------------------------------------------
printf 'FIXTURE: origin/<branch> refs for this run are locally-written remote-tracking refs, not pushed branches (announced adjustment; the local-vs-origin comparison under test is unaffected).\n'

BASE_SHA="$(git -C "$REPO_ROOT" rev-parse origin/main 2>/dev/null)" \
  || fail_hard "cannot resolve origin/main"
[ -n "$BASE_SHA" ] || fail_hard "origin/main resolved empty"

# --- in-sync branch for clause (a): local and origin/<br> at the same NEW commit.
# The commit must NOT be origin/main's, or "continued the branch" and "cut a
# fresh branch at origin/main" would be indistinguishable.
make_commit_on() {
  # $1 = branch name. Creates the branch at BASE_SHA plus one empty commit,
  # entirely via plumbing so no checkout and no working tree is touched.
  local br="$1" msg="$2" tree parent new
  tree="$(git -C "$REPO_ROOT" rev-parse "${BASE_SHA}^{tree}")" || return 1
  parent="$BASE_SHA"
  new="$(git -C "$REPO_ROOT" commit-tree "$tree" -p "$parent" -m "$msg")" || return 1
  git -C "$REPO_ROOT" update-ref "refs/heads/$br" "$new" || return 1
  printf '%s' "$new"
}

CONT_SHA="$(make_commit_on "$BR_CONT" "donemeans 667 fixture: continuation branch commit $RUN_ID")" \
  || fail_hard "could not build the in-sync fixture branch"
CREATED_BRS+=("$BR_CONT")
git -C "$REPO_ROOT" update-ref "refs/remotes/origin/$BR_CONT" "$CONT_SHA" \
  || fail_hard "could not write origin ref for $BR_CONT"
CREATED_REMOTE_BRS+=("$BR_CONT")

CLAUSE_A=FAIL; EV_A=""
CLAUSE_B=FAIL; EV_B=""
CLAUSE_C=FAIL; EV_C=""
CLAUSE_D=FAIL; EV_D=""
CLAUSE_E=FAIL; EV_E=""

# ---------------------------------------------------------------------------
# CLAUSE (a) — continuation on an existing, in-sync branch
# ---------------------------------------------------------------------------
OUT_A="$(cd "$REPO_ROOT" && bun "$SCRIPT_ABS" --branch "$BR_CONT" \
  --reason "done-means 667 continuation clause a" 2>&1)"
EXIT_A=$?
CREATED_WTS+=("$WT_CONT")

if [ "$EXIT_A" -ne 0 ]; then
  CLAUSE_A=FAIL
  EV_A="bootstrap exited $EXIT_A on an existing in-sync branch (head: $(printf '%s' "$OUT_A" | tr '\n' ' ' | head -c 240))"
elif [ ! -d "$WT_CONT" ]; then
  CLAUSE_A=FAIL
  EV_A="exit=0 but no worktree at $WT_CONT — reported success without creating the lane"
else
  WT_BRANCH="$(git -C "$WT_CONT" branch --show-current 2>/dev/null)"
  WT_HEAD="$(git -C "$WT_CONT" rev-parse HEAD 2>/dev/null)"
  # Distinguishing evidence: the fixture commit is reachable from the worktree
  # HEAD. A silent re-cut at origin/main would put HEAD at BASE_SHA instead.
  if [ "$WT_BRANCH" = "$BR_CONT" ] && [ "$WT_HEAD" = "$CONT_SHA" ]; then
    CLAUSE_A=PASS
    EV_A="worktree on branch $WT_BRANCH at $WT_HEAD (== existing branch tip, != origin/main $BASE_SHA)"
  else
    CLAUSE_A=FAIL
    EV_A="worktree branch=${WT_BRANCH:-<none>} head=${WT_HEAD:-<none>}; expected branch=$BR_CONT head=$CONT_SHA (origin/main is $BASE_SHA)"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE (b) — CONTROL: fresh-branch path unchanged
# ---------------------------------------------------------------------------
OUT_B="$(cd "$REPO_ROOT" && bun "$SCRIPT_ABS" --branch "$BR_FRESH" \
  --reason "done-means 667 fresh-path control clause b" 2>&1)"
EXIT_B=$?
CREATED_WTS+=("$WT_FRESH"); CREATED_BRS+=("$BR_FRESH")

if [ "$EXIT_B" -ne 0 ]; then
  CLAUSE_B=FAIL
  EV_B="fresh-branch bootstrap exited $EXIT_B (head: $(printf '%s' "$OUT_B" | tr '\n' ' ' | head -c 240))"
elif [ ! -d "$WT_FRESH" ]; then
  CLAUSE_B=FAIL
  EV_B="exit=0 but no worktree at $WT_FRESH"
else
  FB="$(git -C "$WT_FRESH" branch --show-current 2>/dev/null)"
  FH="$(git -C "$WT_FRESH" rev-parse HEAD 2>/dev/null)"
  if [ "$FB" = "$BR_FRESH" ] && [ "$FH" = "$BASE_SHA" ]; then
    CLAUSE_B=PASS
    EV_B="fresh branch $FB created at origin/main $FH"
  else
    CLAUSE_B=FAIL
    EV_B="fresh path changed: branch=${FB:-<none>} head=${FH:-<none>}, expected $BR_FRESH at $BASE_SHA"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE (c) — divergence refused, both SHAs named, BEFORE anything is created
# ---------------------------------------------------------------------------
# Plant: local branch one commit ahead of a DIFFERENT origin tip.
DIV_ORIGIN_SHA="$(make_commit_on "$BR_DIV" "donemeans 667 fixture: origin side $RUN_ID")" \
  || fail_hard "could not build the divergent fixture (origin side)"
CREATED_BRS+=("$BR_DIV")
git -C "$REPO_ROOT" update-ref "refs/remotes/origin/$BR_DIV" "$DIV_ORIGIN_SHA" \
  || fail_hard "could not write origin ref for $BR_DIV"
CREATED_REMOTE_BRS+=("$BR_DIV")

DIV_TREE="$(git -C "$REPO_ROOT" rev-parse "${BASE_SHA}^{tree}")"
DIV_LOCAL_SHA="$(git -C "$REPO_ROOT" commit-tree "$DIV_TREE" -p "$DIV_ORIGIN_SHA" \
  -m "donemeans 667 fixture: LOCAL-ONLY divergent commit $RUN_ID")" \
  || fail_hard "could not build the divergent fixture (local side)"
git -C "$REPO_ROOT" update-ref "refs/heads/$BR_DIV" "$DIV_LOCAL_SHA" \
  || fail_hard "could not move local $BR_DIV to the divergent commit"

OUT_C="$(cd "$REPO_ROOT" && bun "$SCRIPT_ABS" --branch "$BR_DIV" \
  --reason "done-means 667 divergence refusal clause c" 2>&1)"
EXIT_C=$?

# Survival evidence, read AFTER the refused run.
DIV_AFTER="$(git -C "$REPO_ROOT" rev-parse "refs/heads/$BR_DIV" 2>/dev/null)"
DIV_WT_DIR=no; [ -d "$WT_DIV" ] && DIV_WT_DIR=yes
DIV_WT_REG=no
if git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null | grep -qF "$WT_DIV"; then
  DIV_WT_REG=yes
fi
# If the pre-fix script DID create it, register for teardown so the refusal
# failure does not also leak a worktree.
if [ "$DIV_WT_DIR" = yes ] || [ "$DIV_WT_REG" = yes ]; then
  CREATED_WTS+=("$WT_DIV")
fi

NAMES_LOCAL=no;  printf '%s' "$OUT_C" | grep -qF "$DIV_LOCAL_SHA"  && NAMES_LOCAL=yes
NAMES_ORIGIN=no; printf '%s' "$OUT_C" | grep -qF "$DIV_ORIGIN_SHA" && NAMES_ORIGIN=yes

if [ "$EXIT_C" -eq 0 ]; then
  CLAUSE_C=FAIL
  EV_C="exit=0 on a divergent branch — divergence was not refused at all"
elif [ "$NAMES_LOCAL" != yes ] || [ "$NAMES_ORIGIN" != yes ]; then
  CLAUSE_C=FAIL
  EV_C="exit=$EXIT_C non-zero but SHAs not both named (local=$NAMES_LOCAL origin=$NAMES_ORIGIN); a refusal that does not say what to reconcile is a dead end (out head: $(printf '%s' "$OUT_C" | tr '\n' ' ' | head -c 240))"
elif [ "$DIV_AFTER" != "$DIV_LOCAL_SHA" ]; then
  CLAUSE_C=FAIL
  EV_C="refused, but the local branch MOVED: was $DIV_LOCAL_SHA, now ${DIV_AFTER:-<gone>} — a silent reset is exactly what the ruling forbids"
elif [ "$DIV_WT_DIR" = yes ] || [ "$DIV_WT_REG" = yes ]; then
  CLAUSE_C=FAIL
  EV_C="refused and SHAs named, but a worktree was created first (dir=$DIV_WT_DIR registered=$DIV_WT_REG at $WT_DIV) — the refusal must happen BEFORE any worktree exists"
else
  CLAUSE_C=PASS
  EV_C="exit=$EXIT_C; names local $DIV_LOCAL_SHA and origin $DIV_ORIGIN_SHA; local tip survived unchanged; no worktree dir and no worktree registration at $WT_DIV"
fi

# ---------------------------------------------------------------------------
# CLAUSE (d) — CONTROL: leftover-worktree refusal unchanged
# ---------------------------------------------------------------------------
# Branch exists AND is in sync, so only the leftover directory can refuse it.
LEFT_SHA="$(make_commit_on "$BR_LEFT" "donemeans 667 fixture: leftover branch $RUN_ID")" \
  || fail_hard "could not build the leftover fixture branch"
CREATED_BRS+=("$BR_LEFT")
git -C "$REPO_ROOT" update-ref "refs/remotes/origin/$BR_LEFT" "$LEFT_SHA" \
  || fail_hard "could not write origin ref for $BR_LEFT"
CREATED_REMOTE_BRS+=("$BR_LEFT")

mkdir -p "$WT_LEFT" || fail_hard "cannot create the leftover fixture dir"
printf 'donemeans 667 leftover fixture %s\n' "$RUN_ID" > "$WT_LEFT/LEFTOVER-FIXTURE.txt"

OUT_D="$(cd "$REPO_ROOT" && bun "$SCRIPT_ABS" --branch "$BR_LEFT" \
  --reason "done-means 667 leftover-worktree control clause d" 2>&1)"
EXIT_D=$?

LEFT_SURVIVED=no; [ -f "$WT_LEFT/LEFTOVER-FIXTURE.txt" ] && LEFT_SURVIVED=yes
NAMES_PATH=no; printf '%s' "$OUT_D" | grep -qF "$WT_LEFT" && NAMES_PATH=yes

if [ "$EXIT_D" -eq 0 ]; then
  CLAUSE_D=FAIL
  EV_D="exit=0 with a leftover worktree present at $WT_LEFT — the leftover refusal regressed"
elif [ "$NAMES_PATH" != yes ]; then
  CLAUSE_D=FAIL
  EV_D="exit=$EXIT_D non-zero but the refusal does not name $WT_LEFT (head: $(printf '%s' "$OUT_D" | tr '\n' ' ' | head -c 240))"
elif [ "$LEFT_SURVIVED" != yes ]; then
  CLAUSE_D=FAIL
  EV_D="refused but the pre-existing directory contents were disturbed — it may be a live lane and must be left alone"
else
  CLAUSE_D=PASS
  EV_D="exit=$EXIT_D, refusal names $WT_LEFT, pre-existing contents untouched"
fi
# The fixture dir is not a git worktree, so `git worktree remove` cannot retire
# it and this check does not delete. Announce it for the operator.
LEFTOVER_NOTE="$WT_LEFT (plain directory fixture, not a registered worktree; no rm is performed by this check)"

# ---------------------------------------------------------------------------
# CLAUSE (e) — nothing silently, and teardown still printed-never-executed
# ---------------------------------------------------------------------------
# Half 1: the continuation run NAMES the inspected-and-untouched states —
#   that the branch already existed, and that local/origin were verified in
#   sync at a named SHA.
# Half 2 (the mutation guard): the FRESH run must NOT make the same claim.
#   An unconditional banner satisfies half 1 while telling the reader nothing.
# Half 3: teardown line still printed AND the worktree still on disk.
# The announcement must be the SCRIPT's own, on a line it owns. Observed at
# the pre-fix tree: a bare `already exists` match went GREEN off git's fatal
# ("fatal: a branch named 'x' already exists") on the very run where the script
# announced nothing and crashed. A negative-of-a-substring on hostile output is
# the round-9/round-17 false-match family; anchor on the script's step marker.
says_own() { printf '%s' "$1" | grep -qE '^[[:space:]]*\[ok\][[:space:]]+.*'"$2"; }

CONT_SAYS_EXISTING=no
says_own "$OUT_A" 'continuation' && CONT_SAYS_EXISTING=yes
CONT_SAYS_SYNC=no
says_own "$OUT_A" 'in sync|in-sync|matches origin' && CONT_SAYS_SYNC=yes
CONT_NAMES_SHA=no
printf '%s' "$OUT_A" | grep -qF "$CONT_SHA" && CONT_NAMES_SHA=yes

FRESH_SAYS_EXISTING=no
says_own "$OUT_B" 'continuation' && FRESH_SAYS_EXISTING=yes

CONT_TEARDOWN_LINE=no
printf '%s' "$OUT_A" | grep -qF 'git worktree remove' && CONT_TEARDOWN_LINE=yes
CONT_WT_PRESENT=no; [ -d "$WT_CONT" ] && CONT_WT_PRESENT=yes

if [ "$CONT_SAYS_EXISTING" = yes ] && [ "$CONT_SAYS_SYNC" = yes ] \
   && [ "$CONT_NAMES_SHA" = yes ] && [ "$FRESH_SAYS_EXISTING" = no ] \
   && [ "$CONT_TEARDOWN_LINE" = yes ] && [ "$CONT_WT_PRESENT" = yes ]; then
  CLAUSE_E=PASS
  EV_E="continuation run names the existing branch, the verified sync, and the SHA $CONT_SHA; the fresh run makes no such claim; teardown printed and worktree still present"
else
  CLAUSE_E=FAIL
  EV_E="cont_names_existing=$CONT_SAYS_EXISTING cont_names_sync=$CONT_SAYS_SYNC cont_names_sha=$CONT_NAMES_SHA fresh_falsely_claims_existing=$FRESH_SAYS_EXISTING teardown_printed=$CONT_TEARDOWN_LINE worktree_present=$CONT_WT_PRESENT"
fi

printf '\n'
printf 'CLAUSE (a) continuation on existing in-sync branch:      %s — %s\n' "$CLAUSE_A" "$EV_A"
printf 'CLAUSE (b) CONTROL fresh-branch path unchanged:          %s — %s\n' "$CLAUSE_B" "$EV_B"
printf 'CLAUSE (c) divergence refused, both SHAs, pre-creation:  %s — %s\n' "$CLAUSE_C" "$EV_C"
printf 'CLAUSE (d) CONTROL leftover-worktree refusal unchanged:  %s — %s\n' "$CLAUSE_D" "$EV_D"
printf 'CLAUSE (e) nothing silently + teardown printed only:     %s — %s\n' "$CLAUSE_E" "$EV_E"
printf 'NOT REMOVED BY THIS CHECK: %s\n' "$LEFTOVER_NOTE"

if [ "$CLAUSE_A" = PASS ] && [ "$CLAUSE_B" = PASS ] && [ "$CLAUSE_C" = PASS ] \
   && [ "$CLAUSE_D" = PASS ] && [ "$CLAUSE_E" = PASS ]; then
  exit 0
fi
exit 1
