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
# ABSENCE ALONE IS NOT THE BAR. A reader that stopped reading `process.env` and
# whose caller never started passing the value is not wired -- it is silently
# running on its `?? default` forever, and clauses 1-3 go green on exactly that
# state (observed on this branch: three of the four readers took parameters and
# `server/main.ts` passed none of them). So CLAUSE 4 asserts ARRIVAL at the
# composition root: each value must be handed down from the ONE validated parse
# at the call site that reaches the tool layer.
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
# CLAUSE 4 -- THE VALUES ARRIVE AT THE COMPOSITION ROOT.
#   Absence proves the reader stopped guessing; arrival proves someone started
#   telling it. Four anchored `rg` patterns, each of which must match EXACTLY
#   once -- zero means unwired, more than once means two composition paths that
#   can disagree, which is the doubled state this rung exists to end:
#     server/main.ts       `ftsCorpusConfig: config.fts.corpusConfig`
#     server/main.ts       `recoveryWalPath: config.recovery.walPath`
#     server/main.ts       `natsRuntimeBoundary: nats.boundary`  -- the boundary
#         the NATS phase ALREADY computed (`natsRuntimeBoundaryFromConfig` at
#         server/main.ts:267, returned as `NatsPhase.boundary`). Calling that
#         function a second time here would rebuild a second boundary from the
#         same config, which is a second source of truth by construction.
#     server/tools/search-brain.ts  `ftsCorpusConfig: dependencies.ftsCorpusConfig`
#         -- the corpus default threaded into `resolveCallerFtsConfig`, which is
#         what passes it as `requestFtsConfig`'s second argument. Without this
#         the branch's new second parameter is never supplied by any caller.
#
# CLAUSE 5 -- THE INJECTED VALUES ARRIVE AT THEIR CONSUMERS.
#   Clause 4 reads the composition root's SOURCE and proves the three values are
#   written at the call site. That is a textual assertion: it proves someone
#   typed the wiring, never that the value survives the trip. A field can be
#   spelled correctly at the root and still be dropped by the registrar, shadowed
#   by a fallback, or read from the wrong place by the handler, and every one of
#   those states keeps clause 4 green.
#
#   So clause 5 EXERCISES the wiring. `server/tools/dependency-arrival.test.ts`
#   registers the real tools through a fake McpServer, injects each value, and
#   asserts on observable behavior at the far end:
#     ftsCorpusConfig      -> the SQL search_brain emits names the injected
#                             configuration, with no per-request argument.
#     recoveryWalPath      -> recovery_wal_append writes a real JSONL file at
#                             the injected path, through the fallback store.
#     natsRuntimeBoundary  -> operator_doctor reports the injected transport,
#                             not the one an empty environment produces.
#
#   The clause runs `bun test` on that one file and requires exit 0 AND at least
#   3 passing tests parsed from the output. The parsed count is the vacuity
#   guard, the same shape as clause 3: a runner that loads no tests also exits 0,
#   and "0 pass" must never read as success. A missing file is a hard FAIL here
#   rather than a skip, for the same reason clause 1 is a hard fail.
#
# Exit 0 only when all five clauses pass. Exit 3 is a harness error (missing
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
CLAUSE4=FAIL; CLAUSE4_EVIDENCE=""
CLAUSE5=FAIL; CLAUSE5_EVIDENCE=""

# The behavioral test clause 5 runs, and the least number of passing tests that
# can honestly satisfy it -- one per injected value.
ARRIVAL_TEST="server/tools/dependency-arrival.test.ts"
ARRIVAL_TEST_MIN_PASS=3

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

# ---------------------------------------------------------------------------
# CLAUSE 4 — the values ARRIVE at the composition root.
# ---------------------------------------------------------------------------
# Each entry is `<file>|<fixed-string pattern>`. `rg -F` so the pattern is read
# literally, and the count must be exactly 1: 0 is unwired, >1 is two
# composition paths.
ARRIVALS="server/main.ts|ftsCorpusConfig: config.fts.corpusConfig
server/main.ts|recoveryWalPath: config.recovery.walPath
server/main.ts|natsRuntimeBoundary: nats.boundary
server/tools/search-brain.ts|ftsCorpusConfig: dependencies.ftsCorpusConfig"

ARRIVAL_BAD=""
ARRIVAL_OK=0
N_ARRIVALS=0
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  N_ARRIVALS=$((N_ARRIVALS + 1))
  a_file="${entry%%|*}"
  a_pat="${entry#*|}"
  if [ ! -f "$REPO_ROOT/$a_file" ]; then
    ARRIVAL_BAD="${ARRIVAL_BAD}
    MISSING FILE $a_file (for: $a_pat)"
    continue
  fi
  a_count="$(cd "$REPO_ROOT" && rg -cF -- "$a_pat" "$a_file" 2>/dev/null)"
  a_count="${a_count:-0}"
  if [ "$a_count" -eq 1 ]; then
    ARRIVAL_OK=$((ARRIVAL_OK + 1))
  else
    ARRIVAL_BAD="${ARRIVAL_BAD}
    $a_file: found $a_count, expected 1 — \"$a_pat\""
  fi
done <<EOF
$ARRIVALS
EOF

if [ "$N_ARRIVALS" -ne 4 ]; then
  CLAUSE4_EVIDENCE="expected 4 arrival assertions, the list yielded $N_ARRIVALS — the check itself is miswritten"
elif [ -n "$ARRIVAL_BAD" ]; then
  CLAUSE4_EVIDENCE="$ARRIVAL_OK/4 values arrive; the rest are not wired:${ARRIVAL_BAD}"
else
  CLAUSE4=PASS
  CLAUSE4_EVIDENCE="all 4 values are passed exactly once from the composition root"
fi

printf 'CLAUSE 1 (all 4 target files exist):                    %s — %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
printf 'CLAUSE 2 (no process.env in any of the 4):              %s — %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"
if [ "$CLAUSE2" != PASS ] && [ -n "${CLAUSE2_HITS:-}" ]; then
  printf '%s\n' "$CLAUSE2_HITS" | sed 's/^/    /'
fi
printf 'CLAUSE 3 (scanner proven to match in %s):   %s — %s\n' "$CONTROL" "$CLAUSE3" "$CLAUSE3_EVIDENCE"

# ---------------------------------------------------------------------------
# CLAUSE 5 — the injected values arrive at their consumers, proven by running.
# ---------------------------------------------------------------------------
if [ ! -f "$REPO_ROOT/$ARRIVAL_TEST" ]; then
  CLAUSE5_EVIDENCE="$ARRIVAL_TEST does not exist — clause 4 asserts the wiring was TYPED; nothing here asserts it WORKS"
else
  command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH; cannot run $ARRIVAL_TEST"
  ARRIVAL_TEST_OUT="$(cd "$REPO_ROOT" && bun test "$ARRIVAL_TEST" 2>&1)"
  ARRIVAL_TEST_STATUS=$?
  # bun prints a summary line of the form "N pass". Read the last one, so an
  # earlier per-file line cannot be mistaken for the total.
  ARRIVAL_PASS="$(printf '%s\n' "$ARRIVAL_TEST_OUT" | rg -o '^\s*([0-9]+) pass' -r '$1' | tail -n 1)"
  ARRIVAL_PASS="${ARRIVAL_PASS:-0}"
  if [ "$ARRIVAL_TEST_STATUS" -ne 0 ]; then
    CLAUSE5_EVIDENCE="bun test $ARRIVAL_TEST exited $ARRIVAL_TEST_STATUS ($ARRIVAL_PASS passing) — an injected value does not reach its consumer:"
    CLAUSE5_OUT="$ARRIVAL_TEST_OUT"
  elif [ "$ARRIVAL_PASS" -lt "$ARRIVAL_TEST_MIN_PASS" ]; then
    # exit 0 with too few tests is the vacuous pass: the runner found the file
    # and ran nothing meaningful in it.
    CLAUSE5_EVIDENCE="bun test $ARRIVAL_TEST exited 0 but only $ARRIVAL_PASS test(s) passed, expected at least $ARRIVAL_TEST_MIN_PASS — one per injected value, so a green run here examined nothing"
    CLAUSE5_OUT="$ARRIVAL_TEST_OUT"
  else
    CLAUSE5=PASS
    CLAUSE5_EVIDENCE="$ARRIVAL_PASS test(s) passed in $ARRIVAL_TEST — each injected value observed at its consumer, not just at the call site"
  fi
fi

printf 'CLAUSE 4 (values arrive at the composition root):        %s — %s\n' "$CLAUSE4" "$CLAUSE4_EVIDENCE"
printf 'CLAUSE 5 (injected values observed at their consumers):  %s — %s\n' "$CLAUSE5" "$CLAUSE5_EVIDENCE"
if [ "$CLAUSE5" != PASS ] && [ -n "${CLAUSE5_OUT:-}" ]; then
  printf '%s\n' "$CLAUSE5_OUT" | sed 's/^/    /'
fi

if [ "$CLAUSE1" = PASS ] && [ "$CLAUSE2" = PASS ] && [ "$CLAUSE3" = PASS ] && [ "$CLAUSE4" = PASS ] && [ "$CLAUSE5" = PASS ]; then
  exit 0
fi
exit 1
