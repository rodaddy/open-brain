#!/usr/bin/env bash
# DONE-MEANS check for lane L2b-1a of the server/ hardening ladder
# (`_plans/server-hardening-ladder.md`, rung L2 "Composition root").
#
#   bash scripts/done-means/750-l2b1-tool-readers-take-config.sh
#
# ---------------------------------------------------------------------------
# The defect this gates
# ---------------------------------------------------------------------------
# The rewrite charter (`_plans/463-server-rewrite-charter.md:108,119`) puts ALL
# env parsing behind `server/config/` and forbids domain code from importing
# `process.env`. L2a (#778) delivered the SCHEMA half: every one of these reads
# is now typed and parsed into a `ServerConfig` group. That left the repo in a
# deliberately doubled state — the validated group AND the original scattered
# reader both existed, and only the reader was actually consulted.
#
# A doubled state is worse than either half alone, because it looks finished
# from the config side. `config.search.embeddingTimeoutMs` can be correct,
# tested, and reported in `/health` while the search path continues to read
# `process.env` directly and answer something else entirely. Nothing fails; the
# two simply drift, and the config becomes documentation of an intention rather
# than the value in force.
#
# This lane closes FOUR of the readers L2a typed. The assertion is about
# ABSENCE at a named boundary: those four files must contain no `process.env`
# at all, because every value they need now arrives through a parameter or
# through `MemoryToolDependencies`.
#
# ---------------------------------------------------------------------------
# WHAT THIS CHECK DELIBERATELY DOES NOT COVER, AND WHY
# ---------------------------------------------------------------------------
# `server/tools/search-all.ts` and `server/tools/search-engine.ts` are the other
# two readers L2a typed. They are OUT of this check, and their `process.env`
# reads are still present in the tree. This is a deferral recorded in the open,
# not an oversight and not a silent narrowing of the bar.
#
# The reason is a collision with a different gate. `_githooks/pre-commit` lints
# whole STAGED files with no main-vs-branch baseline, and both files already
# violate `.oxlintrc.json` on unmodified `origin/main` — 5 violations in
# `search-all.ts` and 9 in `search-engine.ts`. So ANY commit touching either
# file is refused by the hook, whether or not the commit's own change is clean.
# `--no-verify` is not an approved workaround in this repo.
#
# `.oxlintrc.json` states the intended policy — the backlog is "paid per-file as
# work naturally touches them" — so the sanctioned path is to clear each file on
# touch. Measured, that does not fit inside a start-equivalence rewiring: the
# violations are 5-to-10-parameter signatures across the whole search stack
# (`executeSearch` alone has 55 references repo-wide), a 203-line handler, and an
# 837-code-line file. Converting those to options objects and splitting them is a
# behavior-risky refactor of the core search path, and burying a start-equivalence
# rewiring inside it is exactly what the lane contract forbids.
#
# Those two files therefore move to a follow-up lane that dispatches after the
# lint-debt ruling (head ruling, 2026-08-26). When that lane lands, this check
# grows its target list back to six and this section goes away. Until then, a
# GREEN here means FOUR files are clean — never that the rung is finished.
#
# ---------------------------------------------------------------------------
# WHY CLAUSE 3 EXISTS — the vacuous-pass problem
# ---------------------------------------------------------------------------
# The natural check is "rg finds no `process.env` in these files", and that
# assertion passes for two very different reasons: because the reads are gone,
# or because the scan examined nothing. A renamed file, a typo in a path, an
# `rg` that is not on PATH, a bad `--glob` — every one of them produces a silent
# clean sweep and an exit 0 that means nothing. This repo has been burned by the
# "0 items examined, exit 0" shape before, which is why the toolbox convention
# is to prove the tool can still see a hit somewhere it MUST see one.
#
# So the check is three clauses, and all three must pass:
#
# CLAUSE 1 — ALL FOUR TARGET FILES EXIST.
#   Each path is `test -f`'d individually and named in the output. A file that
#   was renamed or deleted makes the scan vacuous, so it is a hard fail here
#   rather than an invisible pass in clause 2.
#
# CLAUSE 2 — NONE OF THEM READS `process.env`.
#   `rg -n 'process\.env' <four files>` must produce no output. Any match is
#   printed, so a failure names the file and line instead of just refusing.
#
# CLAUSE 3 — THE SCANNER IS PROVEN TO MATCH.
#   `rg -c 'process\.env' server/config.ts` must be > 0. `server/config.ts` is
#   the composition root's own env reader: it is the one file in `server/` that
#   MUST read the environment, because it is the boundary the charter puts the
#   parsing behind. If the same pattern, the same tool, and the same invocation
#   find nothing THERE, the clean result in clause 2 is a broken scan and not a
#   clean tree. This is a positive control, deliberately pointed at a file this
#   lane does not touch and no future lane should empty.
#
# Exit 0 only when all three clauses pass. Exit 3 is a harness error (missing
# tool / wrong repo root), which is NOT a fail of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v rg >/dev/null 2>&1 || fail_hard "rg (ripgrep) not on PATH"
[ -d "$REPO_ROOT/.git" ] || [ -f "$REPO_ROOT/.git" ] || fail_hard "not a git repo at $REPO_ROOT"

# The four readers this lane rewires. `search-all.ts` and `search-engine.ts`
# are the other two L2a typed and are deferred to a follow-up lane -- see "WHAT
# THIS CHECK DELIBERATELY DOES NOT COVER" above for the reason and the counts.
#
# Listed literally rather than globbed: a glob that stops matching is exactly
# the vacuous pass clause 3 guards against, and naming them makes a rename fail
# loudly in clause 1.
TARGETS="server/tools/types.ts
server/tools/fts-config.ts
server/tools/realtime-stores.ts
server/tools/operator-doctor.ts"

# The positive control: the composition root's OWN env reader, which must keep
# reading `process.env` for the boundary to exist at all.
CONTROL="server/config.ts"

CLAUSE1=FAIL; CLAUSE1_EVIDENCE=""
CLAUSE2=FAIL; CLAUSE2_EVIDENCE=""
CLAUSE3=FAIL; CLAUSE3_EVIDENCE=""

# ---------------------------------------------------------------------------
# CLAUSE 1 — every target file is present.
# ---------------------------------------------------------------------------
MISSING=""
N_TARGETS=0
while IFS= read -r t; do
  [ -n "$t" ] || continue
  N_TARGETS=$((N_TARGETS + 1))
  [ -f "$REPO_ROOT/$t" ] || MISSING="${MISSING}${t} "
done <<EOF
$TARGETS
EOF

if [ "$N_TARGETS" -ne 4 ]; then
  CLAUSE1_EVIDENCE="expected 4 target paths, the list yielded $N_TARGETS — the check itself is miswritten"
elif [ -n "$MISSING" ]; then
  CLAUSE1_EVIDENCE="target file(s) NOT found: ${MISSING}— a scan over missing files passes vacuously"
else
  CLAUSE1=PASS
  CLAUSE1_EVIDENCE="all 4 target files present under $REPO_ROOT"
fi

# ---------------------------------------------------------------------------
# CLAUSE 2 — none of the five reads process.env.
# ---------------------------------------------------------------------------
if [ "$CLAUSE1" != PASS ]; then
  CLAUSE2_EVIDENCE="skipped — target files are not all present, so any result is vacuous"
else
  # Build the argument list from the same literal set clause 1 verified.
  set --
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    set -- "$@" "$REPO_ROOT/$t"
  done <<EOF
$TARGETS
EOF

  HITS="$(cd "$REPO_ROOT" && rg -n 'process\.env' "$@" 2>/dev/null)"
  RG_STATUS=$?
  # rg exits 1 for "no matches" (the pass) and 2 for a real error. A 2 is a
  # harness problem, not a clean tree, and must not be read as success.
  if [ "$RG_STATUS" -ge 2 ]; then
    fail_hard "rg failed with status $RG_STATUS scanning the four target files"
  fi

  if [ -n "$HITS" ]; then
    CLAUSE2_EVIDENCE="$(printf '%s\n' "$HITS" | wc -l | tr -d ' ') process.env read(s) remain:"
    CLAUSE2_HITS="$HITS"
  else
    CLAUSE2=PASS
    CLAUSE2_EVIDENCE="no process.env read in any of the 4 files — each value now arrives from validated config"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 3 — positive control: the scanner still finds a known hit.
# ---------------------------------------------------------------------------
if [ ! -f "$REPO_ROOT/$CONTROL" ]; then
  CLAUSE3_EVIDENCE="positive control $CONTROL does not exist — cannot prove the scan matches anything"
else
  CONTROL_COUNT="$(cd "$REPO_ROOT" && rg -c 'process\.env' "$CONTROL" 2>/dev/null)"
  CONTROL_COUNT="${CONTROL_COUNT:-0}"
  if [ "$CONTROL_COUNT" -gt 0 ]; then
    CLAUSE3=PASS
    CLAUSE3_EVIDENCE="$CONTROL still contains $CONTROL_COUNT process.env line(s) — the pattern, tool, and invocation are proven to match"
  else
    CLAUSE3_EVIDENCE="$CONTROL contains ZERO process.env lines — either the composition root stopped reading the environment, or this scan is broken and clause 2's clean result is meaningless"
  fi
fi

printf 'CLAUSE 1 (all 4 target files exist):                    %s — %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
printf 'CLAUSE 2 (no process.env in any of the 4):              %s — %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"
if [ "$CLAUSE2" != PASS ] && [ -n "${CLAUSE2_HITS:-}" ]; then
  printf '%s\n' "$CLAUSE2_HITS" | sed 's/^/    /'
fi
printf 'CLAUSE 3 (scanner proven to match in %s):   %s — %s\n' "$CONTROL" "$CLAUSE3" "$CLAUSE3_EVIDENCE"

if [ "$CLAUSE1" = PASS ] && [ "$CLAUSE2" = PASS ] && [ "$CLAUSE3" = PASS ]; then
  exit 0
fi
exit 1
