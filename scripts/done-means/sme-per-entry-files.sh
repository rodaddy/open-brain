#!/usr/bin/env bash
# DONE-MEANS check for issue-graph ledger item 13 — the acceptance gate, not
# the fix.
#
#   bash scripts/done-means/sme-per-entry-files.sh
#
# Ledger item 13 (docs/issue-graph.md, decisions pass 2026-08-07): SME entries
# become one file each; the lane files become generated indexes. The motivating
# defect is concrete and measured: three manual union merges of
# docs/sme/correctness.md in a single night, because every parallel review lane
# appends to the same handful of files and git cannot union-merge prose.
#
# This is a REWARD FUNCTION, not a test of the implementer's diligence. It is
# written and proven RED before the migration exists, and it observes only the
# repository's own end state — never the implementation's internals. A build
# script that satisfies these four clauses by any means has done the job.
#
# EXPECTED TO FAIL until ledger item 13 is implemented. The first clause fails
# on a missing docs/sme/entries/ directory.
#
# Output is content-free: counts, paths, and pass/fail states only.
#
# ---------------------------------------------------------------------------
# The baseline, measured before any migration
# ---------------------------------------------------------------------------
# Measured on origin/main at 90ef4c2 (2026-08-07), the six lane files carried
# 226 dated entries in total:
#
#   docs/sme/correctness.md      64
#   docs/sme/security.md         44
#   docs/sme/gotcha-agent.md     35
#   docs/sme/adversarial.md      34
#   docs/sme/domain-backend.md   31
#   docs/sme/quality.md          18
#   -------------------------------
#   TOTAL                       226
#
# There are 236 entry FILES, not 226: ten findings were written without a date
# prefix and are counted by clause 1 (which counts `^## ` headings) but not by
# clause 4 (which counts `^## \[20`). The two numbers measure different things
# on purpose and both are load-bearing.
#
# That number is pinned as EXPECTED_ENTRY_COUNT below and is the whole point of
# clause 4: a migration that silently drops entries is the failure mode that
# matters, and "the lane files still look fine" cannot detect it, because the
# lane files are regenerated FROM the entries. If a future swarm legitimately
# adds entries, this constant moves UP by exactly the number of new entry
# files, in the same commit that adds them. It never moves down without an
# explicit, stated deletion.
#
# ---------------------------------------------------------------------------
# The four clauses
# ---------------------------------------------------------------------------
#   1. Every dated entry heading in the pre-migration lane files exists in
#      exactly one docs/sme/entries/ file, and every entries/ file carries
#      exactly one dated heading. Counted BOTH directions, so neither a
#      dropped entry nor a duplicated one passes.
#   2. Running the build script twice produces zero git diff. Deterministic:
#      same inputs, byte-identical output. A build that reorders on every run
#      reintroduces the merge conflicts this whole change exists to kill.
#   3. Deleting one generated lane file and rebuilding restores it
#      byte-identical. This is what makes the lane files genuinely GENERATED
#      rather than merely "generated once and then hand-maintained".
#   4. The total dated-entry count across entries/ equals the pinned
#      pre-migration count. No entry text lost.
#
# Clause 2 and clause 3 both mutate the working tree and both restore it. The
# script refuses to run against a dirty docs/sme/ tree (see PREFLIGHT) so that
# a failure can never be confused with a pre-existing local edit, and so that
# its own restore can never clobber uncommitted work.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 2

SME_DIR="docs/sme"
ENTRIES_DIR="$SME_DIR/entries"
BUILD_SCRIPT="scripts/build-sme-indexes.ts"

# Pinned pre-migration measurement. See the header block for provenance.
# 226 at migration (PR #617); +1 = the 2026-08-08 no-silent-adjustments entry
# (operator ruling) — raised in the same commit that adds it, as the gate's
# own failure text instructs.
EXPECTED_ENTRY_COUNT=227

LANE_FILES=(
  "$SME_DIR/correctness.md"
  "$SME_DIR/adversarial.md"
  "$SME_DIR/quality.md"
  "$SME_DIR/security.md"
  "$SME_DIR/domain-backend.md"
  "$SME_DIR/gotcha-agent.md"
)

FAILURES=0

pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
info() { printf '        %s\n' "$1"; }

section() { printf '\n== %s\n' "$1"; }

# ---------------------------------------------------------------------------
# PREFLIGHT — refuse to run against uncommitted docs/sme changes
# ---------------------------------------------------------------------------
# Clauses 2 and 3 delete and regenerate tracked files. If the tree is already
# dirty under docs/sme/, this script cannot distinguish "the build is
# non-deterministic" from "someone had an editor open", and its restore step
# would silently discard their work. Fail closed.
section "PREFLIGHT"

if ! command -v git >/dev/null 2>&1; then
  fail "git not on PATH; this check needs it to observe diffs"
  exit 1
fi

DIRTY="$(git status --porcelain -- "$SME_DIR" 2>/dev/null)"
if [[ -n "$DIRTY" ]]; then
  fail "docs/sme/ has uncommitted changes; commit or stash before running"
  info "clauses 2 and 3 regenerate tracked files and must not clobber them"
  printf '%s\n' "$DIRTY" | sed 's/^/          /'
  exit 1
fi
pass "docs/sme/ is clean; safe to regenerate in place"

# ---------------------------------------------------------------------------
# CLAUSE 1 — every pre-migration entry heading lives in exactly one entry file
# ---------------------------------------------------------------------------
# The pre-migration headings are read from git history at the migration's merge
# base, NOT from the current lane files. Reading them from the current lane
# files would be circular: the lane files are regenerated from the entries, so
# they would agree with the entries by construction even if half the entries
# had been dropped. Comparing against the historical text is what makes this
# clause mean anything.
section "CLAUSE 1 — entry headings preserved, counted both directions"

if [[ ! -d "$ENTRIES_DIR" ]]; then
  fail "$ENTRIES_DIR does not exist — the per-entry migration has not happened"
  info "this is the expected RED state before ledger item 13 is implemented"
fi

# Resolve the pre-migration tree: the merge base with origin/main, falling back
# to origin/main itself. On a branch that has already migrated, the merge base
# still carries the ORIGINAL lane files, which is exactly what clause 1 needs.
BASE_REF=""
for candidate in "$(git merge-base HEAD origin/main 2>/dev/null)" "origin/main" "main"; do
  [[ -z "$candidate" ]] && continue
  if git rev-parse --verify --quiet "$candidate^{commit}" >/dev/null 2>&1; then
    BASE_REF="$candidate"
    break
  fi
done

if [[ -z "$BASE_REF" ]]; then
  fail "cannot resolve a pre-migration git ref (merge-base/origin/main/main)"
else
  info "pre-migration ref: $BASE_REF ($(git rev-parse --short "$BASE_REF"))"

  # Collect historical headings. Sorted and de-duplicated at the end so the
  # comparison is order-independent — entry ORDER is the build script's
  # business, not this clause's.
  HIST_HEADINGS="$(
    for lane in "${LANE_FILES[@]}"; do
      git show "$BASE_REF:$lane" 2>/dev/null | rg '^## \[20' || true
    done | sed 's/[[:space:]]*$//' | sort
  )"
  HIST_COUNT="$(printf '%s\n' "$HIST_HEADINGS" | rg -c '^## \[20' || true)"
  HIST_COUNT="${HIST_COUNT:-0}"
  info "pre-migration dated-entry headings: $HIST_COUNT"

  if [[ -d "$ENTRIES_DIR" ]]; then
    ENTRY_HEADINGS="$(
      fd -e md . "$ENTRIES_DIR" -x rg -N '^## \[20' {} \; 2>/dev/null \
        | sed 's/[[:space:]]*$//' | sort
    )"
    ENTRY_HEAD_COUNT="$(printf '%s\n' "$ENTRY_HEADINGS" | rg -c '^## \[20' || true)"
    ENTRY_HEAD_COUNT="${ENTRY_HEAD_COUNT:-0}"
    info "entries/ dated-entry headings:      $ENTRY_HEAD_COUNT"

    # Direction A: nothing from history went missing.
    MISSING="$(comm -23 <(printf '%s\n' "$HIST_HEADINGS") <(printf '%s\n' "$ENTRY_HEADINGS"))"
    if [[ -n "$MISSING" ]]; then
      fail "headings present pre-migration but absent from entries/:"
      printf '%s\n' "$MISSING" | head -20 | sed 's/^/          /'
    else
      pass "every pre-migration heading is present in entries/"
    fi

    # Direction B: nothing appeared that was not in history. New entries added
    # after the migration are legitimate, so this reports rather than fails —
    # but it must stay visible, because a heading that appears here and is NOT
    # a deliberate new finding means the migration mangled text.
    EXTRA="$(comm -13 <(printf '%s\n' "$HIST_HEADINGS") <(printf '%s\n' "$ENTRY_HEADINGS"))"
    if [[ -n "$EXTRA" ]]; then
      info "headings in entries/ that are new since $BASE_REF (expected only for genuinely new findings):"
      printf '%s\n' "$EXTRA" | head -20 | sed 's/^/          /'
    fi

    # Exactly one: each entry file carries exactly one FINDING heading, and no
    # heading is split across two files.
    #
    # The heading counted here is `^## ` generally, not `^## \[20`. Ten
    # findings across four lanes were written without a date prefix
    # (`## PR #421 — ...`, `## Pattern: ...`, `## A port is complete when ...`)
    # using inline `Severity: ... Status: ... Provenance: ...` prose instead of
    # the bold block. They are findings by every property except their heading
    # format, and they are exactly the entries a date-keyed split is most
    # likely to mangle — so the one-heading-per-file invariant has to cover
    # them. Clause 4 separately pins the DATED count, so narrowing this to the
    # dated form would only make the check blind to the risky cases.
    MULTI=0
    SINGLE=0
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      n="$(rg -c '^## ' "$f" || true)"
      n="${n:-0}"
      if [[ "$n" -eq 1 ]]; then
        SINGLE=$((SINGLE + 1))
      else
        MULTI=$((MULTI + 1))
        info "entry file with $n finding headings (expected 1): $f"
      fi
    done < <(fd -e md . "$ENTRIES_DIR" 2>/dev/null)

    if [[ "$MULTI" -gt 0 ]]; then
      fail "$MULTI entry file(s) do not carry exactly one finding heading"
    elif [[ "$SINGLE" -eq 0 ]]; then
      fail "no entry files found under $ENTRIES_DIR"
    else
      pass "all $SINGLE entry file(s) carry exactly one finding heading"
    fi

    # Duplicate detection: two entry files claiming the same heading would let
    # clause 4's total match while an entry was actually lost.
    DUPES="$(printf '%s\n' "$ENTRY_HEADINGS" | uniq -d)"
    if [[ -n "$DUPES" ]]; then
      fail "duplicate entry headings across entries/ files:"
      printf '%s\n' "$DUPES" | head -10 | sed 's/^/          /'
    else
      pass "no duplicate entry headings"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 2 — the build is idempotent
# ---------------------------------------------------------------------------
section "CLAUSE 2 — build twice, zero git diff"

if [[ ! -f "$BUILD_SCRIPT" ]]; then
  fail "$BUILD_SCRIPT does not exist — nothing to build the lane files from"
elif ! command -v bun >/dev/null 2>&1; then
  fail "bun not on PATH; cannot run $BUILD_SCRIPT"
else
  BUILD_LOG_1="$(bun "$BUILD_SCRIPT" 2>&1)"
  RC1=$?
  if [[ $RC1 -ne 0 ]]; then
    fail "first build run exited $RC1"
    printf '%s\n' "$BUILD_LOG_1" | tail -20 | sed 's/^/          /'
  else
    BUILD_LOG_2="$(bun "$BUILD_SCRIPT" 2>&1)"
    RC2=$?
    if [[ $RC2 -ne 0 ]]; then
      fail "second build run exited $RC2"
      printf '%s\n' "$BUILD_LOG_2" | tail -20 | sed 's/^/          /'
    else
      DIFF_AFTER="$(git status --porcelain -- "$SME_DIR")"
      if [[ -n "$DIFF_AFTER" ]]; then
        fail "building twice from a clean tree produced a diff (non-deterministic)"
        printf '%s\n' "$DIFF_AFTER" | sed 's/^/          /'
        git --no-pager diff --stat -- "$SME_DIR" | sed 's/^/          /'
        # Restore so clause 3 starts from a known-clean tree.
        git checkout -- "$SME_DIR" 2>/dev/null || true
      else
        pass "two consecutive builds left the tree byte-identical"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 3 — a deleted lane file is restored byte-identical by the build
# ---------------------------------------------------------------------------
# The lane file is removed with `git rm --cached`-free plain deletion of the
# working-tree copy only; the committed blob is untouched, so `git diff` after
# the rebuild is the exact byte comparison this clause wants. No recursive or
# forced delete is used: a single named regular file, removed by `rm --` with
# an explicit path, then regenerated.
section "CLAUSE 3 — delete one generated lane file, rebuild restores it"

VICTIM="$SME_DIR/quality.md"

if [[ ! -f "$BUILD_SCRIPT" ]]; then
  fail "skipped: $BUILD_SCRIPT does not exist"
elif [[ ! -f "$VICTIM" ]]; then
  fail "skipped: $VICTIM does not exist"
elif ! command -v bun >/dev/null 2>&1; then
  fail "skipped: bun not on PATH"
else
  VICTIM_HASH_BEFORE="$(git hash-object "$VICTIM")"
  rm -- "$VICTIM"
  if [[ -f "$VICTIM" ]]; then
    fail "could not remove $VICTIM for the restore test"
  else
    info "removed $VICTIM (working tree only; committed blob intact)"
    REBUILD_LOG="$(bun "$BUILD_SCRIPT" 2>&1)"
    RC3=$?
    if [[ $RC3 -ne 0 ]]; then
      fail "rebuild after deletion exited $RC3"
      printf '%s\n' "$REBUILD_LOG" | tail -20 | sed 's/^/          /'
    elif [[ ! -f "$VICTIM" ]]; then
      fail "rebuild did not recreate $VICTIM"
    else
      VICTIM_HASH_AFTER="$(git hash-object "$VICTIM")"
      if [[ "$VICTIM_HASH_BEFORE" == "$VICTIM_HASH_AFTER" ]]; then
        pass "$VICTIM restored byte-identical (blob $VICTIM_HASH_AFTER)"
      else
        fail "$VICTIM restored but NOT byte-identical"
        info "before: $VICTIM_HASH_BEFORE"
        info "after:  $VICTIM_HASH_AFTER"
        git --no-pager diff -- "$VICTIM" | head -40 | sed 's/^/          /'
      fi
    fi
    # Always restore the committed content, pass or fail.
    git checkout -- "$VICTIM" 2>/dev/null || true
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 4 — no dated-entry text lost
# ---------------------------------------------------------------------------
section "CLAUSE 4 — total dated-entry count matches the pinned baseline"

if [[ ! -d "$ENTRIES_DIR" ]]; then
  fail "$ENTRIES_DIR does not exist; cannot count entries"
else
  TOTAL="$(fd -e md . "$ENTRIES_DIR" -x rg -c '^## \[20' {} \; 2>/dev/null \
    | awk '{s += $1} END {print s + 0}')"
  info "dated entries across $ENTRIES_DIR: $TOTAL"
  info "pinned pre-migration baseline:      $EXPECTED_ENTRY_COUNT"
  if [[ "$TOTAL" -eq "$EXPECTED_ENTRY_COUNT" ]]; then
    pass "entry count matches the pinned baseline exactly"
  elif [[ "$TOTAL" -gt "$EXPECTED_ENTRY_COUNT" ]]; then
    fail "more entries ($TOTAL) than the pinned baseline ($EXPECTED_ENTRY_COUNT)"
    info "if a swarm legitimately added findings, raise EXPECTED_ENTRY_COUNT in"
    info "the same commit that adds them, and say so in the PR body"
  else
    fail "FEWER entries ($TOTAL) than the pinned baseline ($EXPECTED_ENTRY_COUNT) — entry text was lost"
  fi
fi

# ---------------------------------------------------------------------------
section "RESULT"
if [[ "$FAILURES" -eq 0 ]]; then
  printf '  GREEN — all clauses pass\n\n'
  exit 0
fi
printf '  RED — %d clause failure(s)\n\n' "$FAILURES"
exit 1
