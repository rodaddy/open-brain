#!/usr/bin/env bash
# DONE-MEANS check for issue #705 — "pre-push gate diffs against origin/main, so
# every wip-branch lane inherits 80 commits of Python attribution".
#
#   bash scripts/done-means/705-pre-push-base-selection.sh
#
# ---------------------------------------------------------------------------
# THE DEFECT THIS GATES
# ---------------------------------------------------------------------------
# `_githooks/pre-push` decided which language gates to run by diffing the push
# against a HARDCODED `origin/main` (both the stdin-range path and the manual
# path). Every lane in the current flow branches from `wip/2026-08-07`, which is
# 80 commits ahead of `origin/main`, so the hook attributed all 80 commits'
# Python changes to whatever lane was pushing. Measured on the primary checkout
# 2026-08-09:
#
#   git log --oneline origin/main..origin/wip/2026-08-07 | wc -l   => 80
#   git diff --name-only <merge-base wip main> origin/wip/2026-08-07 \
#     -- python/openbrain python/openbrain-memory
#     => python/openbrain/src/openbrain/apps/bulk/formats.py
#
# So a lane with a ZERO-Python diff ran `python/openbrain`'s pytest, which
# executes the out-of-repo `_ob/scripts/context-budget-gate.ts` crosslang proof
# and fails on #704 — a known main-owned failure the lane did not cause.
#
# Note the attribution correction, announced rather than quietly fixed
# (AGENTS.md, nothing silent): the issue body names `python/openbrain-memory`,
# but the file inherited from wip is in the SIBLING package `python/openbrain`,
# whose gate owns the crosslang test. Same defect, correct package.
#
# The gate stops discriminating once every lane is told it changed Python: a
# push that genuinely breaks Python looks identical to a markdown-only one, and
# "not mine" becomes the habitual response — which is how a gate becomes noise
# routed around with `--no-verify`.
#
# THE FIX IS BASE SELECTION, NOT GATE REMOVAL. The hook compares against the
# branch's actual integration target — its configured upstream — and falls back
# to origin/main only when there is no upstream. And it ANNOUNCES the base, so a
# future lane can read which base produced the verdict instead of inferring it
# from a failure.
#
# ---------------------------------------------------------------------------
# WHY THIS CHECK NEEDS A SEAM, AND WHY THE SEAM IS THE REAL HOOK
# ---------------------------------------------------------------------------
# `pre-push` runs `bun run typecheck` and the full `bun test` suite before it
# reaches any language gate, so a check that invoked it whole would take many
# minutes per clause and would fail for reasons that have nothing to do with
# base selection. The subject under test is the DECISION — which base, and which
# flags fall out of it — not the validations that follow.
#
# So the hook gained `--explain`: it resolves the base and prints its decision,
# then exits WITHOUT running any validation. That is not a test double. It is
# the shipped script, running its own real base-selection code, on the real
# repository — the same lines the live push takes. Clause (e) pins that the
# explain path cannot drift into a second implementation by asserting the hook
# holds exactly ONE base-resolution function.
#
# Every invocation below runs `"$REPO_ROOT/_githooks/pre-push"` with REPO_ROOT
# resolved from THIS FILE's own location (lane-contract round 12/23), so the
# check always drives the copy shipping beside it.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) THE DEFECT. A branch cut from a wip base, carrying a NON-Python commit,
#       whose upstream is that wip base, must report the Python packages
#       UNCHANGED. RED pre-fix: reports them changed, because the 80-commit
#       origin/main span is attributed to the push.
#
#   (b) THE GATE STILL DISCRIMINATES. The same branch, with a REAL Python edit
#       on top, must report that package CHANGED. This is the mutation-relevant
#       half: "fixing" (a) by never setting the flag — or by diffing against
#       HEAD — passes (a) and destroys the gate. Both packages are exercised
#       separately, because they are separately gated and a leading-dir pathspec
#       does not catch the sibling.
#
#   (c) THE BASE IS ANNOUNCED. The decision output must NAME the base ref it
#       compared against. The issue asks for this explicitly, and it is the
#       nothing-silent rule: a verdict whose base is invisible is one a lane can
#       only reverse-engineer from a failure. Anchored on a marker the hook OWNS
#       so a crash cannot satisfy it (lane-contract round 23).
#
#   (d) CONTROL — NO UPSTREAM STILL FALLS BACK TO origin/main, ANNOUNCED. A
#       detached/upstreamless invocation must still resolve a base rather than
#       failing open, and must say that it fell back. Without this, a fix that
#       simply deleted the origin/main path would look like success while
#       leaving upstreamless pushes ungated.
#
#   (f) THE REAL PUSH PATH, DRIVEN WITH A SHA. Clauses (a)-(d) go through
#       `--explain`, which resolves from the symbolic `HEAD`. A REAL push does
#       not: git feeds the hook a stdin range whose tip is a RAW SHA, and
#       `<sha>@{upstream}` is meaningless, so an upstream lookup keyed on the tip
#       silently falls through to origin/main -- the exact bug, still live, on
#       the only path that actually runs. This clause therefore feeds the hook a
#       real stdin range with a zero remote SHA (the new-branch shape, which is
#       every first lane push) and asserts the zero-python lane is still charged
#       nothing.
#
#       This clause exists because the fix SHIPPED WITHOUT IT and the first real
#       push of this lane announced "base: origin/main -- fallback (no
#       configured upstream)". An `--explain`-only check certified a resolution
#       the live path never used.
#
#   (e) ONE IMPLEMENTATION. The hook defines exactly one base-resolution
#       function and every base decision routes through it. The pre-fix file had
#       the selection written TWICE (stdin-range path and manual path), which is
#       why a fix could land on one and leave the other — the
#       sme.duplicated_selection_lists_diverge pattern. Asserted structurally,
#       not by reading prose.
#
# Exit 0 only when every clause passes. Exit 3 is a harness error, which is NOT
# a failure of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$REPO_ROOT/_githooks/pre-push"
RUN_ID="705-$$-$(date +%s)"
SCRATCH="${OPENBRAIN_TEMP_WORKSPACE:-/Volumes/ThunderBolt/_tmp}/open-brain/_scratch/$RUN_ID"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v git >/dev/null 2>&1 || fail_hard "git not on PATH"
[ -r "$HOOK" ] || fail_hard "pre-push hook not readable at $HOOK"
mkdir -p "$SCRATCH" || fail_hard "cannot create scratch dir $SCRATCH"

# ---------------------------------------------------------------------------
# A self-contained repository that REPRODUCES THE SHAPE, not the contents, of
# the real one: a `main`, a `wip` branch some commits ahead of it that touches
# BOTH Python packages, and a lane branch off wip. Built here rather than
# against the live repo so the clauses assert on a known span instead of on
# whatever wip happens to hold today, and so nothing this check does can touch a
# real branch or ref.
#
# The hook is COPIED IN, not reimplemented: the file under test is the shipped
# one, byte for byte.
# ---------------------------------------------------------------------------
FIXTURE="$SCRATCH/fixture"
mkdir -p "$FIXTURE" || fail_hard "cannot create fixture dir"

git_f() { git -C "$FIXTURE" -c user.name="done-means-705" -c user.email="done-means-705@invalid" "$@"; }

setup_fixture() {
  git -C "$FIXTURE" init -q -b main 2>/dev/null || return 1
  mkdir -p "$FIXTURE/python/openbrain/src" \
           "$FIXTURE/python/openbrain-memory/src" \
           "$FIXTURE/contracts" \
           "$FIXTURE/_githooks" \
           "$FIXTURE/docs" || return 1

  # The parity path filter the hook reads. Kept off the Python paths so parity
  # never confounds the Python clauses.
  printf 'contracts/schema.json\n' > "$FIXTURE/contracts/parity-paths.txt" || return 1
  printf '{}\n' > "$FIXTURE/contracts/schema.json" || return 1
  printf 'base\n' > "$FIXTURE/python/openbrain/src/mod.py" || return 1
  printf 'base\n' > "$FIXTURE/python/openbrain-memory/src/mod.py" || return 1
  printf '# base\n' > "$FIXTURE/docs/readme.md" || return 1

  # A REAL, minimal bun project. Without it the hook's `bun run typecheck` dies
  # on a missing script, and that CRASH would satisfy every negative assertion
  # below for a reason that has nothing to do with base selection — the false-RED
  # family (lane-contract rounds 18/22/23). With the scripts present and trivial,
  # a hook that ignores `--explain` and runs validation reaches the DECISION and
  # is judged on it, so each clause fails for the defect's own reason.
  cat > "$FIXTURE/package.json" <<'PKG' || return 1
{
  "name": "done-means-705-fixture",
  "private": true,
  "scripts": {
    "typecheck": "true",
    "test": "true"
  }
}
PKG

  # `bun test` exits non-zero when it matches NO test files, which would be
  # another crash masquerading as a verdict. One trivial passing test makes the
  # validation phase genuinely succeed, so a pre-fix hook that ignores
  # `--explain` runs all the way THROUGH validation and is then judged on the
  # decision it actually made.
  cat > "$FIXTURE/fixture.test.ts" <<'SPEC' || return 1
import { expect, test } from "bun:test";
test("the fixture project runs a test", () => {
  expect(true).toBe(true);
});
SPEC

  cp "$HOOK" "$FIXTURE/_githooks/pre-push" || return 1
  chmod +x "$FIXTURE/_githooks/pre-push" || return 1

  git_f add -A >/dev/null || return 1
  git_f commit -q -m "base" || return 1

  # `origin` is this same repository, so `origin/main` and `origin/wip` are real
  # remote-tracking refs — which is what the hook resolves.
  git_f remote add origin "$FIXTURE" || return 1

  # wip: ahead of main, and it CHANGES BOTH PYTHON PACKAGES. This is the
  # inherited-attribution span — the fixture's stand-in for the 80 commits.
  git_f checkout -q -b wip || return 1
  printf 'wip-change\n' >> "$FIXTURE/python/openbrain/src/mod.py" || return 1
  printf 'wip-change\n' >> "$FIXTURE/python/openbrain-memory/src/mod.py" || return 1
  git_f add -A >/dev/null || return 1
  git_f commit -q -m "wip: change both python packages" || return 1

  git_f fetch -q origin || return 1
  return 0
}

setup_fixture || fail_hard "could not build the fixture repository (see $FIXTURE)"

# A lane off wip, tracking wip — the exact shape every lane in this flow has.
new_lane_branch() {
  local name="$1"
  git_f checkout -q -b "$name" wip || return 1
  git_f branch -q --set-upstream-to=origin/wip "$name" || return 1
  return 0
}

# explain <cwd-branch> -> populates EXPLAIN_OUT / EXPLAIN_EXIT
explain() {
  EXPLAIN_OUT="$(cd "$FIXTURE" && "$FIXTURE/_githooks/pre-push" --explain 2>&1 </dev/null)"
  EXPLAIN_EXIT=$?
}

# Read one decision field out of the hook's explain output.
#
# WHY THERE IS A SECOND READING. Pre-fix the hook has no `--explain` at all: it
# ignores the argument, runs its validations, and announces the SAME decision in
# prose ("Python package changed; running..." / "...unchanged; skipping..."). If
# the only reading were the structured field, every clause would fail with
# "field missing" — a verdict about the flag's absence, not about base
# selection, which is the false-RED family (lane-contract rounds 18/22/23). So
# the field is read first and the hook's own prose is the fallback, and the
# clauses are judged on the DECISION either way. A truly missing decision (both
# readings empty) still fails, and is reported as such rather than defaulting.
field() {
  local structured
  structured="$(printf '%s\n' "$EXPLAIN_OUT" | sed -n "s/^[[:space:]]*$1=\(.*\)$/\1/p" | tail -1)"
  if [ -n "$structured" ]; then
    printf '%s' "$structured"
    return 0
  fi
  case "$1" in
    changed_openbrain_memory)
      if printf '%s' "$EXPLAIN_OUT" | rg -qF "Python package changed"; then printf 'yes'
      elif printf '%s' "$EXPLAIN_OUT" | rg -qF "Python package unchanged"; then printf 'no'
      fi ;;
    changed_openbrain)
      if printf '%s' "$EXPLAIN_OUT" | rg -qF "openbrain package changed"; then printf 'yes'
      elif printf '%s' "$EXPLAIN_OUT" | rg -qF "openbrain package unchanged"; then printf 'no'
      fi ;;
  esac
}

CLAUSES=()
record() { CLAUSES+=("$1|$2|$3"); }

# The all-zero SHA git sends as the remote sha for a branch the remote does not
# have yet. Clause (f) reproduces that shape exactly.
ZERO_SHA_FIXTURE=0000000000000000000000000000000000000000

# --- (a) the defect --------------------------------------------------------
new_lane_branch "lane-nonpython" || fail_hard "could not create lane-nonpython"
printf 'lane note\n' >> "$FIXTURE/docs/readme.md"
git_f add -A >/dev/null && git_f commit -q -m "lane: docs only, zero python"
explain
A_OUT="$EXPLAIN_OUT"
A_MEM="$(field changed_openbrain_memory)"
A_OB="$(field changed_openbrain)"
if [ -z "$A_MEM" ] || [ -z "$A_OB" ]; then
  record a FAIL "decision fields missing from the explain output (memory='$A_MEM' openbrain='$A_OB'): $(printf '%s' "$A_OUT" | tr '\n' ' ')"
elif [ "$A_MEM" = no ] && [ "$A_OB" = no ]; then
  record a PASS "zero-python lane on a wip base reports both packages unchanged"
else
  record a FAIL "zero-python lane inherited python attribution (openbrain-memory=$A_MEM openbrain=$A_OB) — the wip span is being charged to the push"
fi

# --- (b) the gate still discriminates --------------------------------------
B_FAILS=()
new_lane_branch "lane-python-ob" || fail_hard "could not create lane-python-ob"
printf 'lane-change\n' >> "$FIXTURE/python/openbrain/src/mod.py"
git_f add -A >/dev/null && git_f commit -q -m "lane: real python/openbrain change"
explain
[ "$(field changed_openbrain)" = yes ] || B_FAILS+=("a real python/openbrain edit was NOT detected (changed_openbrain='$(field changed_openbrain)')")

new_lane_branch "lane-python-mem" || fail_hard "could not create lane-python-mem"
printf 'lane-change\n' >> "$FIXTURE/python/openbrain-memory/src/mod.py"
git_f add -A >/dev/null && git_f commit -q -m "lane: real python/openbrain-memory change"
explain
[ "$(field changed_openbrain_memory)" = yes ] || B_FAILS+=("a real python/openbrain-memory edit was NOT detected (changed_openbrain_memory='$(field changed_openbrain_memory)')")

# The sibling-package separation the hook's own comment calls out: a
# python/openbrain-memory edit must NOT light up python/openbrain.
[ "$(field changed_openbrain)" = no ] || B_FAILS+=("a python/openbrain-memory edit lit up python/openbrain (changed_openbrain='$(field changed_openbrain)') — the packages are no longer separately gated")

if [ "${#B_FAILS[@]}" -eq 0 ]; then
  record b PASS "real edits to each package are still detected, and the two packages stay separately gated"
else
  record b FAIL "$(printf '%s; ' "${B_FAILS[@]}")"
fi

# --- (c) the base is announced ---------------------------------------------
new_lane_branch "lane-announce" || fail_hard "could not create lane-announce"
printf 'announce note\n' >> "$FIXTURE/docs/readme.md"
git_f add -A >/dev/null && git_f commit -q -m "lane: announce clause"
explain
C_BASE_REF="$(field base_ref)"
if [ -z "$C_BASE_REF" ]; then
  record c FAIL "the hook did not name the base ref it compared against: $(printf '%s' "$EXPLAIN_OUT" | tr '\n' ' ')"
elif printf '%s' "$C_BASE_REF" | rg -qF "origin/wip"; then
  record c PASS "the base ref is named in the hook's own output: base_ref=$C_BASE_REF"
else
  record c FAIL "the named base ref is not the branch's integration target: base_ref=$C_BASE_REF (expected origin/wip)"
fi

# --- (d) control: no upstream still falls back, announced ------------------
git_f checkout -q -b lane-no-upstream wip
printf 'no upstream\n' >> "$FIXTURE/docs/readme.md"
git_f add -A >/dev/null && git_f commit -q -m "lane: branch with no configured upstream"
explain
D_BASE_REF="$(field base_ref)"
D_SOURCE="$(field base_source)"
if [ "$EXPLAIN_EXIT" -ne 0 ]; then
  record d FAIL "an upstreamless branch made the hook fail rather than fall back (exit=$EXPLAIN_EXIT): $(printf '%s' "$EXPLAIN_OUT" | tr '\n' ' ')"
elif [ -z "$D_BASE_REF" ] || [ -z "$D_SOURCE" ]; then
  record d FAIL "the fallback did not announce itself (base_ref='$D_BASE_REF' base_source='$D_SOURCE')"
elif printf '%s' "$D_BASE_REF" | rg -qF "origin/main" && printf '%s' "$D_SOURCE" | rg -qF "fallback"; then
  # The source string must say FALLBACK. Asserting instead that it merely lacks
  # the word "upstream" was this check's own bug, caught on the first GREEN run:
  # the correct label is "fallback (no configured upstream)", which CONTAINS
  # "upstream" while describing the opposite. A negative match on a word that
  # legitimately appears in the right answer is the round-9/17/23 family — match
  # the marker the hook OWNS for this state, not the absence of a word.
  record d PASS "no upstream falls back to origin/main and says so: base_ref=$D_BASE_REF base_source=$D_SOURCE"
else
  record d FAIL "upstreamless fallback is not origin/main or is not labelled a fallback (base_ref='$D_BASE_REF' base_source='$D_SOURCE')"
fi

# --- (e) one implementation ------------------------------------------------
# Structural, so a fix that lands on one of the two duplicated paths and leaves
# the other cannot pass. The definition count and the call count are read
# separately: exactly one definition, and at least two call sites (the
# stdin-range path and the manual path both routing through it).
DEF_COUNT="$(rg -c '^resolve_base\(\)' "$HOOK" 2>/dev/null || printf '0')"
CALL_COUNT="$(rg -c 'resolve_base ' "$HOOK" 2>/dev/null || printf '0')"
HARDCODED="$(rg -c 'merge-base.*origin/main' "$HOOK" 2>/dev/null || printf '0')"
if [ "$DEF_COUNT" = "1" ] && [ "${CALL_COUNT:-0}" -ge 2 ] && [ "${HARDCODED:-0}" -le 1 ]; then
  record e PASS "one resolve_base definition, ${CALL_COUNT} call sites, ${HARDCODED} hardcoded origin/main merge-base site(s)"
else
  record e FAIL "base selection is not funnelled through one function (definitions=$DEF_COUNT calls=$CALL_COUNT hardcoded-merge-base=$HARDCODED)"
fi

# --- (f) the real push path, driven with a SHA tip -------------------------
# The fixture's package.json makes typecheck/test trivial, so the run reaches
# the language gates quickly and the DECISION is what is judged. `uv` is not
# available to the fixture, so a hook that wrongly decides "python changed" dies
# in that gate -- which is the live #705 symptom and is read here as the
# failure it is, from the hook's own prose.
new_lane_branch "lane-realpush" || fail_hard "could not create lane-realpush"
printf 'real push note\n' >> "$FIXTURE/docs/readme.md"
git_f add -A >/dev/null && git_f commit -q -m "lane: docs only, pushed for real"

F_TIP="$(git -C "$FIXTURE" rev-parse HEAD)"
F_REF="refs/heads/lane-realpush"
# The new-branch shape git actually sends: local ref, local sha, remote ref, and
# a ZERO remote sha because the remote does not have this branch yet.
F_OUT="$(
  cd "$FIXTURE" && printf '%s %s %s %s\n' \
    "$F_REF" "$F_TIP" "refs/heads/lane-realpush" "$ZERO_SHA_FIXTURE" \
    | "$FIXTURE/_githooks/pre-push" origin "$FIXTURE" 2>&1
)"

F_BASE="$(printf '%s\n' "$F_OUT" | sed -n 's/^[[:space:]]*base:[[:space:]]*\(.*\)$/\1/p' | tail -1)"
if printf '%s' "$F_OUT" | rg -qF "openbrain package changed" \
  || printf '%s' "$F_OUT" | rg -qF "Python package changed"; then
  record f FAIL "a REAL push of a zero-python lane still ran a Python gate — base line was '${F_BASE:-<none>}'"
elif printf '%s' "$F_OUT" | rg -qF "openbrain package unchanged" \
  && printf '%s' "$F_OUT" | rg -qF "Python package unchanged"; then
  record f PASS "a real stdin-range push with a SHA tip charged no Python gate; base line: ${F_BASE:-<none>}"
else
  record f FAIL "the real push path produced no readable package decision: $(printf '%s' "$F_OUT" | tr '\n' ' ' | tail -c 400)"
fi

# ---------------------------------------------------------------------------
# Teardown. The fixture is a throwaway repository this script created inside the
# temp workspace; it is MOVED to the archive, never deleted (AGENTS.md: the
# agent's cleanup verb is mv). It contains no worktree registration against the
# real repo, so nothing is stranded by moving it.
# ---------------------------------------------------------------------------
ARCHIVE_DIR="${OPENBRAIN_TEMP_WORKSPACE:-/Volumes/ThunderBolt/_tmp}/open-brain/_archive"
if mkdir -p "$ARCHIVE_DIR" 2>/dev/null; then
  mv "$SCRATCH" "$ARCHIVE_DIR/$RUN_ID" 2>/dev/null \
    || printf 'TEARDOWN-WARNING: fixture left at %s\n' "$SCRATCH" >&2
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
label_for() {
  case "$1" in
    a) printf 'zero-python lane on a wip base inherits NO python attribution' ;;
    b) printf 'real python edits are still detected, packages separately gated' ;;
    c) printf 'the hook names the base ref it compared against' ;;
    d) printf 'no upstream still falls back to origin/main, announced' ;;
    e) printf 'base selection lives in exactly one function' ;;
    f) printf 'a REAL stdin-range push (SHA tip) charges no Python gate' ;;
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
