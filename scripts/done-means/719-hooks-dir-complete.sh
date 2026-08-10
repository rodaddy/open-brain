#!/usr/bin/env bash
# DONE-MEANS check for issue #719 — `core.hooksPath = _githooks` REPLACES the
# operator's global hooks directory, so `_githooks/` must CONTAIN the controls
# the override displaced. Not just the right value (#711) — the complete set.
#
#   bash scripts/done-means/719-hooks-dir-complete.sh
#
# ---------------------------------------------------------------------------
# THE DEFECT THIS GATES
# ---------------------------------------------------------------------------
# Git consults EXACTLY ONE hooks directory. It does not chain and it does not
# overlay: `core.hooksPath` is a replacement. This repo sets it to `_githooks`,
# which shipped only `pre-push` and `install.sh`, so the repo had NO pre-commit
# hook at all. Measured on the pre-fix tree, in this lane's own worktree:
#
#   $ git hook run pre-commit
#   error: cannot find a hook named pre-commit          <-- exit 1
#
#   # positive control, same tree, same command, the displaced path:
#   $ git -c core.hooksPath=/Users/rico/.config/git/hooks hook run pre-commit
#   INF no leaks found                                  <-- exit 0
#
# The control IS the finding: gitleaks is installed and works, and this repo's
# config is the only thing stopping it. Two controls were silently OFF for
# every commit here — the gitleaks staged secret scan, and the LAW #8
# protected-branch commit block.
#
# A `.git/hooks/pre-commit` shim existed whose own docstring says it restores
# "the user's global gitleaks pre-commit, which this repo's local
# core.hooksPath override was silently bypassing". It was UNREACHABLE — git
# ignores `.git/hooks` entirely once `core.hooksPath` is set — so the repair was
# written and never once ran. That is why this check asserts BEHAVIOUR through
# `git commit`, and never the presence of a file or the string "gitleaks".
#
# ---------------------------------------------------------------------------
# WHY #711 DID NOT CATCH IT, AND WHAT THIS ADDS
# ---------------------------------------------------------------------------
# `711-hookspath-relative.sh` is 5/5 GREEN and asserts the hooksPath VALUE:
# relative, matching the installer, so each worktree runs its own hooks. Every
# clause there is about WHICH directory. None is about WHAT IS IN IT. Fixing a
# config value correctly still left every non-`pre-push` hook dropped, because
# an override replaces rather than overlays.
#
# So clause (a) here is the complementary assertion — the directory is COMPLETE
# with respect to what it displaced — and it is computed from the displaced
# directory itself rather than from a hardcoded list, so a hook added to the
# global directory later goes RED here instead of being silently dropped.
#
# ---------------------------------------------------------------------------
# THE FIXTURE MUST BE ABLE TO EXPRESS THE DEFECT (round-30 lesson)
# ---------------------------------------------------------------------------
# Round 29/#722 measured the failure this fixture is built against: a git
# fixture that does not PIN `core.hooksPath` inherits the operator's global
# value, and every clause then judges the wrong hooks entirely. Every fixture
# below is created with `git init` and then EXPLICITLY configured
# `core.hooksPath=_githooks` with this repo's tracked `_githooks/` copied in —
# i.e. configured exactly as this repo is — so the thing under test is the
# thing that runs.
#
# And the environment must be able to EXPRESS a caught secret. `gitleaks`
# absent means clauses (b)/(c) cannot distinguish "the hook let the secret
# through" from "no scanner was installed to catch it" — two different defects
# with different owners (round 29). That is a HARNESS-ERROR (exit 3), never a
# PASS and never a FAIL.
#
# ---------------------------------------------------------------------------
# THE CANARY IS FAKE, AND DELIBERATELY SO
# ---------------------------------------------------------------------------
# The planted secret is the AWS example key ID that appears in gitleaks' own
# documentation and test corpus. It is a pattern, not a credential: it grants
# nothing, it is already public in gitleaks' repository, and it is generated
# here at runtime in a throwaway fixture that is never committed to this repo.
# A real credential must never be used to test a secret scanner — that plants
# the exact thing the gate exists to stop, and a fixture leaks like anything
# else.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) COMPLETENESS. Every executable hook in the DISPLACED global
#       `core.hooksPath` has a counterpart in `_githooks/`, or an explicit
#       tracked allowlist entry giving a reason. Computed from the displaced
#       directory, not a hardcoded list. RED pre-fix: `pre-commit` missing.
#       ENV-SKIP when no global hooksPath is configured (a fresh clone or CI
#       displaces nothing), reported as its own verdict.
#
#   (b) THE REAL PATH REFUSES A PLANTED SECRET. In a fixture configured exactly
#       like this repo, `git commit` of a staged fake credential is REFUSED,
#       non-zero, and no commit object is created. Driving `git commit`, not
#       `git hook run` and not the hook script directly — #719 exists precisely
#       because a written repair was never on the path that runs.
#
#   (c) CONTROL — A CLEAN COMMIT STILL COMMITS. The same fixture, a file with
#       no secret, must commit successfully. Without this, a pre-commit that
#       refuses everything passes (b) and destroys the repo. This is the
#       mutation-relevant half, and it is mandatory for a security gate.
#
#   (d) LAW #8 — PROTECTED-BRANCH COMMITS ARE REFUSED. On `main` in the
#       fixture, a clean commit is refused and the refusal names the branch.
#
#   (e) CONTROL — AN UNPROTECTED BRANCH IS NOT REFUSED. Same fixture, same
#       clean file, on a feature branch: commits. Pairs with (d) so a
#       blanket-refusing branch check cannot pass (d).
#
#   (f) PUSH-SIDE SECRET SCAN. The displaced global `pre-push` also carried a
#       gitleaks range scan and a default-branch push guard, and this repo's
#       own `pre-push` replaced it. A push of a commit containing the fake key
#       is REFUSED by `git push` in a fixture with a real file remote.
#
#   (g) CONTROL — A CLEAN PUSH SUCCEEDS. Same fixture, clean commit, pushes.
#
#   (h) EVERY STAGE ANNOUNCES ITSELF (AGENTS.md, "nothing is adjusted
#       silently"). The pre-commit run names each control it ran, so a reader
#       of the transcript can tell a gate that ran and passed from a gate that
#       was never there — which is the entire #719 failure mode.
#
#   (i) THE #711 DRIFT ASSERTION NOW COVERS COMPLETENESS. With a displaced hook
#       missing from `_githooks/`, `_githooks/pre-push` WARNS and names it.
#       This is the clause that closes the gap #719 came through: #711 asserted
#       the hooksPath VALUE and was 5/5 GREEN while the directory was
#       incomplete, so "value right, directory wrong" was invisible.
#
#   (j) CONTROL — that assertion is SILENT on a complete directory. An
#       assertion that warns unconditionally would pass (i) and train every
#       reader to ignore it, which is worse than no assertion.
#
# Exit 0 only when (b)-(j) pass and (a) passes or ENV-SKIPs. Exit 3 is a
# HARNESS-ERROR (missing tool, unusable scratch) — not a verdict on the subject.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GITHOOKS="$REPO_ROOT/_githooks"
ALLOWLIST="$GITHOOKS/displaced-hooks-allowlist.txt"
RUN_ID="719-$$-$(date +%s)"
SCRATCH="${OPENBRAIN_TEMP_WORKSPACE:-/Volumes/ThunderBolt/_tmp}/open-brain/_scratch/$RUN_ID"

# The value the installer writes, read FROM the installer — a check that keeps
# its own copy of the expected value cannot catch the installer changing
# (#711's clause-e reasoning, reused deliberately).
EXPECTED_HOOKS_PATH="$(sed -n 's/^target="\(.*\)"$/\1/p' "$GITHOOKS/install.sh" 2>/dev/null | head -1)"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v git >/dev/null 2>&1 || fail_hard "git not on PATH"
[ -d "$GITHOOKS" ] || fail_hard "_githooks/ not found at $GITHOOKS"
[ -n "$EXPECTED_HOOKS_PATH" ] || fail_hard "could not read target=\"...\" out of $GITHOOKS/install.sh"

# gitleaks absent makes (b) and (f) unable to DISTINGUISH a broken hook from an
# absent scanner. That is a harness problem, not a subject verdict.
command -v gitleaks >/dev/null 2>&1 \
  || fail_hard "gitleaks is not installed, so a 'secret was not caught' result could not be attributed to the hook rather than to the missing scanner. Install it (brew install gitleaks) and re-run."

mkdir -p "$SCRATCH" || fail_hard "cannot create scratch dir $SCRATCH"

CLAUSES=()
record() { CLAUSES+=("$1|$2|$3"); }

# ---------------------------------------------------------------------------
# THE FAKE CANARY
#
# Assembled from fragments at RUNTIME so this checked-in file does not itself
# contain a contiguous credential-shaped string — otherwise the check would trip
# the very scanner it is testing, and every other scanner in the fleet, on its
# own source.
#
# WHY THIS VALUE AND NOT THE AWS EXAMPLE KEY. The first draft used AWS's
# documentation key (`AKIA` + `IOSFODNN7EXAMPLE`) and clause (b) went RED
# against a WORKING hook: gitleaks 8.30.1 scanned it and reported "no leaks
# found". Measured directly, outside the hook, to attribute the red before
# changing anything:
#
#   $ gitleaks detect --no-git --source . --redact=100 -v
#   INF scanned ~106 bytes ... INF no leaks found
#
# The scanner deliberately allowlists well-known example keys, so that canary
# could not express the defect no matter what the hook did — the round-30
# lesson (a fixture must be able to express the thing under test), and a false
# RED that would have been read as "the gate does not work".
#
# The replacement is Stripe's own published test-key value, which gitleaks
# matches with the SPECIFIC `stripe-access-token` rule rather than the fuzzy
# `generic-api-key` one — so the clause turns on a deterministic rule match and
# not on entropy heuristics that could drift between versions. It is a
# published test value: it authenticates nothing and grants nothing.
# ---------------------------------------------------------------------------
CANARY_SECRET="sk_live_""4eC39HqLyjWDarjtT1zdp7dc"
canary_file() {
  printf 'stripe_key = "%s"\n' "$CANARY_SECRET"
}

# Prove the canary is DETECTABLE by the installed scanner before using it to
# judge the hook. Without this, "the commit was not refused" is ambiguous
# between a broken gate and a canary this gitleaks version does not flag —
# exactly the ambiguity that produced the false RED described above. This is a
# HARNESS-ERROR, not a verdict on the subject.
CANARY_PROBE="$SCRATCH/canary-probe"
mkdir -p "$CANARY_PROBE" || fail_hard "cannot create canary probe dir"
canary_file > "$CANARY_PROBE/canary.env"
if gitleaks detect --no-git --source "$CANARY_PROBE" --redact=100 --no-banner >/dev/null 2>&1; then
  fail_hard "the fake canary is NOT flagged by the installed gitleaks ($(gitleaks version 2>/dev/null)). Clauses (b) and (f) could not tell a broken gate from an undetectable canary, so they are not being run. Update the canary to a pattern this version detects."
fi

# make_fixture <dir> [branch] — a throwaway repo configured EXACTLY like this
# one: this repo's tracked _githooks/ copied in, and core.hooksPath pinned to
# the installer's relative value. Pinning is not optional — #722 measured that
# an unpinned fixture inherits the operator's global value and silently judges
# a different hooks directory entirely.
make_fixture() {
  local dir="$1" branch="${2:-work}"
  mkdir -p "$dir" || fail_hard "cannot create fixture dir $dir"
  git -C "$dir" init -q -b "$branch" || fail_hard "git init failed in $dir"
  git -C "$dir" config user.name "done-means-719" || fail_hard "git config failed"
  git -C "$dir" config user.email "done-means-719@invalid" || fail_hard "git config failed"
  git -C "$dir" config commit.gpgsign false
  cp -R "$GITHOOKS" "$dir/$EXPECTED_HOOKS_PATH" 2>/dev/null \
    || fail_hard "could not copy _githooks into the fixture"
  git -C "$dir" config core.hooksPath "$EXPECTED_HOOKS_PATH" || fail_hard "git config failed"

  # The shipped pre-push reads `contracts/parity-paths.txt` unconditionally, so
  # a fixture without it dies on a missing file and REFUSES THE PUSH — which
  # reads exactly like a secret being caught. Measured on the first RED run of
  # this check: clause (f) went PASS for that reason while no secret scan
  # existed anywhere in the hook. That is the #722 failure shape (a confident,
  # specific, FALSE claim from a fixture the subject could not run in), so the
  # fixture supplies the file rather than the check accepting the wrong reason.
  mkdir -p "$dir/contracts"
  printf 'contracts/\n' > "$dir/contracts/parity-paths.txt"

  # `_githooks/` and `contracts/` are copied INTO the fixture, so they are
  # untracked; a later `git commit` with only those present has nothing staged
  # and exits 1 with "nothing added to commit" — a refusal that has nothing to
  # do with any gate. Also measured on the first RED run (clause e). Commit the
  # scaffolding once, with hooks bypassed, so every clause below starts from a
  # clean tree and its own staged content is the only variable.
  git -C "$dir" add -A >/dev/null 2>&1
  git -C "$dir" commit -q --no-verify -m "fixture scaffolding" >/dev/null 2>&1 \
    || fail_hard "could not commit fixture scaffolding in $dir"
}

# Commits created by make_fixture, subtracted from every count below so a clause
# measures only the commits IT caused.
FIXTURE_BASE_COMMITS=1

# ---------------------------------------------------------------------------
# (a) COMPLETENESS — every displaced hook has a counterpart or an allowlist
#     entry. Computed from the displaced directory itself.
# ---------------------------------------------------------------------------
GLOBAL_HOOKS_PATH="$(git config --global --get core.hooksPath 2>/dev/null || true)"
A_SKIP=0
if [ -z "$GLOBAL_HOOKS_PATH" ] || [ ! -d "$GLOBAL_HOOKS_PATH" ]; then
  A_SKIP=1
  printf 'CLAUSE a (every displaced hook is provided or explicitly allowlisted): ENV-SKIP — no readable global core.hooksPath on this machine, so nothing is displaced here. This clause is an ENVIRONMENT verdict; (b)-(h) are hermetic and still apply.\n'
else
  MISSING=""
  PROVIDED=""
  ALLOWED=""
  for displaced in "$GLOBAL_HOOKS_PATH"/*; do
    [ -f "$displaced" ] || continue
    [ -x "$displaced" ] || continue
    name="${displaced##*/}"
    if [ -x "$GITHOOKS/$name" ]; then
      PROVIDED="$PROVIDED $name"
    elif [ -r "$ALLOWLIST" ] && grep -q "^${name}:" "$ALLOWLIST" 2>/dev/null; then
      ALLOWED="$ALLOWED $name"
    else
      MISSING="$MISSING $name"
    fi
  done
  if [ -z "$MISSING" ]; then
    record a PASS "displaced set from $GLOBAL_HOOKS_PATH fully accounted for — provided:${PROVIDED:- none} allowlisted:${ALLOWED:- none}"
  else
    record a FAIL "_githooks/ does not provide, and does not allowlist, displaced hook(s):$MISSING — core.hooksPath REPLACES $GLOBAL_HOOKS_PATH, so those controls do not run in this repo at all"
  fi
fi

# ---------------------------------------------------------------------------
# (b) + (c) + (h) — one fixture, the REAL `git commit` path.
# ---------------------------------------------------------------------------
FIX_SECRET="$SCRATCH/commit-fixture"
make_fixture "$FIX_SECRET" work

canary_file > "$FIX_SECRET/credentials.env"
git -C "$FIX_SECRET" add credentials.env >/dev/null 2>&1
B_OUT="$(git -C "$FIX_SECRET" commit -m "fixture: planted canary" 2>&1)"
B_EXIT=$?
# The authoritative evidence is whether a commit OBJECT exists, not the exit
# code alone: a hook that exits non-zero after git has already written the
# commit would be a refusal in name only.
B_COMMITS=$(( $(git -C "$FIX_SECRET" rev-list --count HEAD 2>/dev/null || echo 0) - FIXTURE_BASE_COMMITS ))

if [ "$B_EXIT" -ne 0 ] && [ "$B_COMMITS" = "0" ]; then
  record b PASS "git commit of a staged fake credential was REFUSED (exit=$B_EXIT) and no commit object was created"
elif [ "$B_EXIT" -eq 0 ]; then
  record b FAIL "git commit of a staged fake credential SUCCEEDED — the secret scan is not on the path git runs: $(printf '%s' "$B_OUT" | tr '\n' ' ' | cut -c1-400)"
else
  record b FAIL "commit exited $B_EXIT but $B_COMMITS commit object(s) exist — the refusal did not prevent the commit: $(printf '%s' "$B_OUT" | tr '\n' ' ' | cut -c1-400)"
fi

# (h) the refusal/run must ANNOUNCE the controls it ran. #719's whole failure
# mode is a gate that is absent being indistinguishable from a gate that passed.
H_MISSING=""
printf '%s' "$B_OUT" | grep -qi "gitleaks" || H_MISSING="$H_MISSING secret-scan-stage"
printf '%s' "$B_OUT" | grep -qi "pre-commit" || H_MISSING="$H_MISSING hook-identity"
if [ -z "$H_MISSING" ]; then
  record h PASS "the pre-commit run names the hook and the secret-scan stage, so an absent gate cannot be mistaken for a passed one"
else
  record h FAIL "pre-commit output does not announce:$H_MISSING — output: $(printf '%s' "$B_OUT" | tr '\n' ' ' | cut -c1-400)"
fi

# (c) mutation control — clean content on the same fixture must COMMIT.
# The canary is unstaged and removed from the worktree first, so the ONLY
# difference between (b) and (c) is the content, not the repository state.
git -C "$FIX_SECRET" rm -q --cached credentials.env >/dev/null 2>&1
rm -f "$FIX_SECRET/credentials.env" 2>/dev/null
printf 'plain prose with no credential in it\n' > "$FIX_SECRET/README.md"
git -C "$FIX_SECRET" add README.md >/dev/null 2>&1
C_OUT="$(git -C "$FIX_SECRET" commit -m "fixture: clean file" 2>&1)"
C_EXIT=$?
C_COMMITS=$(( $(git -C "$FIX_SECRET" rev-list --count HEAD 2>/dev/null || echo 0) - FIXTURE_BASE_COMMITS ))
if [ "$C_EXIT" -eq 0 ] && [ "$C_COMMITS" = "1" ]; then
  record c PASS "control — a clean commit on a feature branch SUCCEEDED (exit=0, 1 commit), so the refusal in (b) is specific and not blanket"
else
  record c FAIL "control — a clean commit was refused (exit=$C_EXIT, commits=$C_COMMITS); a pre-commit that refuses everything is not a gate: $(printf '%s' "$C_OUT" | tr '\n' ' ' | cut -c1-400)"
fi

# ---------------------------------------------------------------------------
# (d) + (e) — LAW #8 protected-branch commit block, and its control.
# The (e) control is already provided by (c), which commits cleanly on `work`;
# (e) restates it on the SAME fixture as (d) so a branch-name bug cannot hide
# behind a different repository state.
# ---------------------------------------------------------------------------
FIX_BRANCH="$SCRATCH/branch-fixture"
make_fixture "$FIX_BRANCH" main

printf 'plain prose with no credential in it\n' > "$FIX_BRANCH/README.md"
git -C "$FIX_BRANCH" add README.md >/dev/null 2>&1
D_OUT="$(git -C "$FIX_BRANCH" commit -m "fixture: clean file on main" 2>&1)"
D_EXIT=$?
D_COMMITS=$(( $(git -C "$FIX_BRANCH" rev-list --count HEAD 2>/dev/null || echo 0) - FIXTURE_BASE_COMMITS ))
if [ "$D_EXIT" -ne 0 ] && [ "$D_COMMITS" = "0" ] && printf '%s' "$D_OUT" | grep -q "main"; then
  record d PASS "LAW #8 — a clean commit on 'main' was REFUSED (exit=$D_EXIT), no commit object created, and the refusal names the branch"
elif [ "$D_EXIT" -eq 0 ]; then
  record d FAIL "LAW #8 — a commit on 'main' SUCCEEDED; the protected-branch block does not run: $(printf '%s' "$D_OUT" | tr '\n' ' ' | cut -c1-400)"
else
  record d FAIL "LAW #8 — commit on 'main' exited $D_EXIT (commits=$D_COMMITS) but the refusal does not name the branch: $(printf '%s' "$D_OUT" | tr '\n' ' ' | cut -c1-400)"
fi

git -C "$FIX_BRANCH" checkout -q -b feat/allowed 2>/dev/null
# Re-stage explicitly: (d)'s refusal left README.md staged in most
# implementations, but a hook that refuses at a different point may not, and a
# clause must not depend on leftover index state it did not establish. An empty
# index would exit 1 with "nothing added to commit" — a refusal from git, not
# from any gate, which is precisely the false RED measured on the first run.
git -C "$FIX_BRANCH" add README.md >/dev/null 2>&1
E_OUT="$(git -C "$FIX_BRANCH" commit -m "fixture: clean file on a feature branch" 2>&1)"
E_EXIT=$?
E_COMMITS=$(( $(git -C "$FIX_BRANCH" rev-list --count HEAD 2>/dev/null || echo 0) - FIXTURE_BASE_COMMITS ))
if [ "$E_EXIT" -eq 0 ] && [ "$E_COMMITS" = "1" ]; then
  record e PASS "control — the SAME clean commit on 'feat/allowed' SUCCEEDED, so (d) refused the branch and not the content"
else
  record e FAIL "control — a clean commit on a feature branch was refused (exit=$E_EXIT, commits=$E_COMMITS): $(printf '%s' "$E_OUT" | tr '\n' ' ' | cut -c1-400)"
fi

# ---------------------------------------------------------------------------
# (f) + (g) — the PUSH side. The displaced global pre-push carried a gitleaks
# range scan; this repo's own pre-push replaced it and carried no secret scan
# at all, so the override dropped secret scanning from BOTH ends of the commit
# path. Driven through a real `git push` to a real (file) remote.
#
# `OPENBRAIN_DONE_MEANS_719=1` tells the shipped pre-push to run its secret and
# branch guards and then STOP, before typecheck and the full test suite. Those
# phases take minutes, need this repo's node_modules, and have nothing to do
# with the control under test — the fixture is a two-file repo where they
# cannot even run. The guards under test are upstream of that exit, which is
# what (f)/(g) observe by asserting on their announcements.
# ---------------------------------------------------------------------------
FIX_PUSH="$SCRATCH/push-fixture"
REMOTE="$SCRATCH/remote.git"
git init -q --bare "$REMOTE" || fail_hard "could not create fixture remote"
make_fixture "$FIX_PUSH" work
git -C "$FIX_PUSH" remote add origin "$REMOTE" || fail_hard "could not add fixture remote"

# Commit the canary with --no-verify: (f) is about the PUSH gate, so the commit
# gate must not be what stops it. Using --no-verify inside a throwaway fixture
# to isolate the control under test is not a bypass of this repo's own gates.
canary_file > "$FIX_PUSH/credentials.env"
git -C "$FIX_PUSH" add credentials.env >/dev/null 2>&1
git -C "$FIX_PUSH" commit -q --no-verify -m "fixture: planted canary" >/dev/null 2>&1 \
  || fail_hard "could not create the canary commit in the push fixture"

F_OUT="$(cd "$FIX_PUSH" && OPENBRAIN_DONE_MEANS_719=1 git push origin work 2>&1)"
F_EXIT=$?
# A refused push leaves the remote ref entirely absent, so this is 0 minus the
# baseline in the refusal case; the comparison below is against "no commits of
# ours reached the remote", i.e. <= 0.
F_REMOTE=$(( $(git -C "$REMOTE" rev-list --count refs/heads/work 2>/dev/null || echo 0) ))
# THE REFUSAL MUST BE ATTRIBUTED, NOT MERELY OBSERVED. On the first RED run of
# this check the push WAS refused and this clause reported PASS — because the
# fixture lacked `contracts/parity-paths.txt` and the hook died reading it,
# while no secret scan existed anywhere in the tree. A clause that accepts any
# non-zero exit as proof of the control under test is the #722 shape: a
# confident, specific, FALSE claim. So the refusal must name the scanner.
if [ "$F_EXIT" -ne 0 ] && [ "$F_REMOTE" = "0" ] && printf '%s' "$F_OUT" | grep -qi "gitleaks\|secret"; then
  record f PASS "git push of a commit containing the fake credential was REFUSED (exit=$F_EXIT), nothing reached the remote, and the refusal attributes itself to the secret scan"
elif [ "$F_EXIT" -ne 0 ] && [ "$F_REMOTE" = "0" ]; then
  record f FAIL "the push was refused (exit=$F_EXIT) but the refusal does NOT name the secret scan, so it cannot be attributed to the control under test rather than to a broken fixture: $(printf '%s' "$F_OUT" | tr '\n' ' ' | cut -c1-400)"
elif [ "$F_EXIT" -eq 0 ]; then
  record f FAIL "git push of a commit containing a fake credential SUCCEEDED — the displaced push-side secret scan was never restored: $(printf '%s' "$F_OUT" | tr '\n' ' ' | cut -c1-400)"
else
  record f FAIL "push exited $F_EXIT but $F_REMOTE commit(s) reached the remote: $(printf '%s' "$F_OUT" | tr '\n' ' ' | cut -c1-400)"
fi

# (g) control — same fixture, clean history, must push.
FIX_CLEAN="$SCRATCH/push-clean-fixture"
REMOTE_CLEAN="$SCRATCH/remote-clean.git"
git init -q --bare "$REMOTE_CLEAN" || fail_hard "could not create clean fixture remote"
make_fixture "$FIX_CLEAN" work
git -C "$FIX_CLEAN" remote add origin "$REMOTE_CLEAN" || fail_hard "could not add fixture remote"
printf 'plain prose with no credential in it\n' > "$FIX_CLEAN/README.md"
git -C "$FIX_CLEAN" add README.md >/dev/null 2>&1
git -C "$FIX_CLEAN" commit -q --no-verify -m "fixture: clean file" >/dev/null 2>&1 \
  || fail_hard "could not create the clean commit in the push fixture"

G_OUT="$(cd "$FIX_CLEAN" && OPENBRAIN_DONE_MEANS_719=1 git push origin work 2>&1)"
G_EXIT=$?
G_REMOTE=$(( $(git -C "$REMOTE_CLEAN" rev-list --count refs/heads/work 2>/dev/null || echo 0) - FIXTURE_BASE_COMMITS ))
if [ "$G_EXIT" -eq 0 ] && [ "$G_REMOTE" = "1" ]; then
  record g PASS "control — a clean push SUCCEEDED (exit=0, 1 commit on the remote), so (f) refused the secret and not every push"
else
  record g FAIL "control — a clean push was refused (exit=$G_EXIT, remote commits=$G_REMOTE); a pre-push that refuses everything is not a gate: $(printf '%s' "$G_OUT" | tr '\n' ' ' | cut -c1-400)"
fi

# ---------------------------------------------------------------------------
# (i) + (j) — the #711 drift assertion now covers COMPLETENESS, not just the
# value, and it does not cry wolf.
#
# #719's root cause was that #711 asserted the hooksPath VALUE and stopped
# there, so "value correct, directory missing a displaced hook" was a state
# nothing detected. `_githooks/pre-push` now warns on exactly that state. These
# two clauses are what stop THAT assertion going the way of the one it extends:
# (i) proves it fires when a displaced hook is missing, (j) is the mutation
# control proving it stays quiet when the directory is complete.
#
# Driven through `git hook run pre-push -- --explain` in a fixture whose
# `_githooks/` has a hook removed, with the fixture's own directory presented as
# the "global" displaced one via `git -c`.
# ---------------------------------------------------------------------------
FIX_DRIFT="$SCRATCH/drift-fixture"
make_fixture "$FIX_DRIFT" work

# A stand-in "displaced" directory. It holds EXACTLY the hook names `_githooks/`
# provides, so that after (i) removes one from the fixture and (j) restores it,
# the ONLY variable between the two runs is that one hook.
#
# An earlier draft also planted a `post-checkout` here that `_githooks/` never
# provides. (j) then went RED — correctly: the directory really was incomplete
# by one hook, and the assertion said so. That was a defective CONTROL fixture,
# not a defective assertion, and it is recorded because the two are easy to
# confuse in exactly the direction that gets a real warning suppressed.
DISPLACED_DIR="$SCRATCH/displaced-global"
mkdir -p "$DISPLACED_DIR" || fail_hard "cannot create displaced dir"
for provided in "$GITHOOKS"/*; do
  pname="${provided##*/}"
  [ "$pname" = "install.sh" ] && continue
  [ "$pname" = "displaced-hooks-allowlist.txt" ] && continue
  [ -x "$provided" ] || continue
  cp "$provided" "$DISPLACED_DIR/$pname"
  chmod +x "$DISPLACED_DIR/$pname"
done

# The hook reads the GLOBAL value specifically, and a done-means check must
# never write to the operator's real global config. `git -c` cannot supply a
# `--global` value either. So HOME points at a scratch home carrying its own
# `.gitconfig`: git resolves `--global` from it exactly as it would from the
# operator's, which keeps this on the hook's real read path with no seam and no
# injected variable.
DRIFT_HOME="$SCRATCH/drift-home"
mkdir -p "$DRIFT_HOME"
printf '[core]\n\thooksPath = %s\n' "$DISPLACED_DIR" > "$DRIFT_HOME/.gitconfig"
rm -f "$FIX_DRIFT/$EXPECTED_HOOKS_PATH/pre-commit"
I_OUT="$(cd "$FIX_DRIFT" && HOME="$DRIFT_HOME" git -c core.hooksPath="$EXPECTED_HOOKS_PATH" \
  hook run pre-push -- --explain 2>&1 || true)"
if printf '%s' "$I_OUT" | grep -q "INCOMPLETE" && printf '%s' "$I_OUT" | grep -q "pre-commit"; then
  record i PASS "with a displaced hook missing from _githooks/, the pre-push drift assertion WARNS and names the missing hook — the state #711 could not see"
else
  record i FAIL "a missing displaced hook produced no INCOMPLETE warning, so 'hooksPath value correct but directory incomplete' is still undetected: $(printf '%s' "$I_OUT" | tr '\n' ' ' | cut -c1-400)"
fi

# (j) mutation control — restore the hook; the warning must go away. Without
# this, an assertion that warns unconditionally would pass (i) and train every
# reader to ignore it.
cp "$GITHOOKS/pre-commit" "$FIX_DRIFT/$EXPECTED_HOOKS_PATH/pre-commit"
chmod +x "$FIX_DRIFT/$EXPECTED_HOOKS_PATH/pre-commit"
J_OUT="$(cd "$FIX_DRIFT" && HOME="$DRIFT_HOME" git -c core.hooksPath="$EXPECTED_HOOKS_PATH" \
  hook run pre-push -- --explain 2>&1 || true)"
if printf '%s' "$J_OUT" | grep -q "INCOMPLETE"; then
  record j FAIL "the drift assertion still warns when the directory is COMPLETE — it warns unconditionally, which is noise rather than a signal: $(printf '%s' "$J_OUT" | tr '\n' ' ' | cut -c1-400)"
else
  record j PASS "control — with the displaced hook provided, the drift assertion is silent, so (i) reflects the directory's contents and not an unconditional warning"
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
label_for() {
  case "$1" in
    a) printf 'every displaced hook is provided by _githooks/ or allowlisted' ;;
    b) printf 'REAL git commit REFUSES a staged fake credential' ;;
    c) printf 'control: a clean commit still succeeds (not blanket-refusing)' ;;
    d) printf 'LAW #8: a commit on main is REFUSED, naming the branch' ;;
    e) printf 'control: the same commit on a feature branch succeeds' ;;
    f) printf 'REAL git push REFUSES a commit containing a fake credential' ;;
    g) printf 'control: a clean push still succeeds' ;;
    h) printf 'the hook ANNOUNCES each control it ran' ;;
    i) printf 'the #711 drift assertion also catches an INCOMPLETE directory' ;;
    j) printf 'control: that assertion is silent when the directory is complete' ;;
  esac
}

ALL_PASS=1
for id in a b c d e f g h i j; do
  for entry in "${CLAUSES[@]}"; do
    [ "${entry%%|*}" = "$id" ] || continue
    rest="${entry#*|}"
    status="${rest%%|*}"
    evidence="${rest#*|}"
    printf 'CLAUSE %s (%s): %s — %s\n' "$id" "$(label_for "$id")" "$status" "$evidence"
    [ "$status" = PASS ] || ALL_PASS=0
  done
done

if [ "$A_SKIP" -eq 1 ]; then
  printf '\nNOTE: clause (a) was ENV-SKIPped and a SKIP IS NOT A PASS. It is an\n'
  printf '      environment verdict about THIS machine (nothing is displaced when no\n'
  printf '      global core.hooksPath is set). Clauses (b)-(h) are hermetic and were\n'
  printf '      judged normally.\n'
fi

if [ "$ALL_PASS" -eq 1 ]; then
  printf '\nRESULT: PASS (%s clause(s) judged%s)\n' "${#CLAUSES[@]}" "$([ "$A_SKIP" -eq 1 ] && printf ', 1 ENV-SKIPped')"
  exit 0
fi
printf '\nRESULT: FAIL\n'
exit 1
