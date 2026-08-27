#!/usr/bin/env bash
# DONE-MEANS check for issue #916 -- the sanitize scan tests in
# scripts/ob-backfill.test.ts assert growth shape, not wall-clock seconds.
#
#   bash scripts/done-means/916-sanitize-scan-growth-shape.sh
#
# ---------------------------------------------------------------------------
# The defect this gates
# ---------------------------------------------------------------------------
# At origin/main the two sanitize scan tests assert that one scan finishes
# under an absolute millisecond count -- `toBeLessThan(1_000)` on the
# token-dense scan and `toBeLessThan(2_000)` on the URL-dense one, each applied
# to a `performance.now()` difference. On the shared self-hosted runner that is
# a distribution tail rather than a regression: 1024ms was observed on run
# 33053849804 with the file untouched (#916; the same class as #834 and #912).
# The suite then fails on a slow runner while the code under test is fine, and
# a red check that carries no information is how a genuine red stops being
# believed.
#
# The shape the property actually has is growth: sanitize should scale about
# linearly with input size. Measuring the same input shape at N and at 4N and
# asserting the RATIO is under 8 keeps the quadratic-blowup property under test
# (quadratic is about 16, linear about 4) while cancelling out how fast the
# machine happens to be that minute -- both measurements ride the same tail.
#
# ---------------------------------------------------------------------------
# NO ARGUMENTS
# ---------------------------------------------------------------------------
# The subject is fixed: scripts/ob-backfill.test.ts. This check gates one file,
# so discovery would add nothing and would let an empty subject read as a pass.
#
# CLAUSE 1 -- SHAPE. In scripts/ob-backfill.test.ts, zero `toBeLessThan(`
#   whose subject is a `performance.now()` difference, and at least two
#   assertions comparing a measured duration at size 4N against size N as a
#   ratio.
# CLAUSE 2 -- RUN. `bun test scripts/ob-backfill.test.ts` exits 0.
#
# Exit 0 when both clauses pass, 1 when either fails, 3 on a harness error
# (missing rg, missing bun, or the test file absent).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUBJECT="scripts/ob-backfill.test.ts"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v rg >/dev/null 2>&1 || fail_hard "rg (ripgrep) not on PATH"
command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
[ -f "$REPO_ROOT/$SUBJECT" ] || fail_hard "$SUBJECT does not exist under $REPO_ROOT"

printf 'SUBJECT: %s\n\n' "$SUBJECT"

# ---------------------------------------------------------------------------
# CLAUSE 1 -- shape.
# ---------------------------------------------------------------------------
# Half a: no wall-clock assertion survives. The defect's spelling is a
# `toBeLessThan(` applied to a `performance.now()` difference, which prettier
# keeps on one line here; the multiline spelling is caught by pairing the
# expect line with the toBeLessThan on the following line.
CLAUSE1=PASS
WALLCLOCK_HITS="$(cd "$REPO_ROOT" && rg -n 'performance\.now\(\)[^\n]*toBeLessThan\(' "$SUBJECT" || true)"
MULTILINE_HITS="$(cd "$REPO_ROOT" && rg -n -U 'expect\(\s*performance\.now\(\)[^;]*?\)\s*\.\s*toBeLessThan\(' "$SUBJECT" || true)"
if [ -n "$WALLCLOCK_HITS" ] || [ -n "$MULTILINE_HITS" ]; then
  printf 'CLAUSE 1a: FAIL -- wall-clock assertions on a performance.now() difference survive:\n'
  printf '%s\n' "$WALLCLOCK_HITS" "$MULTILINE_HITS" | rg -v '^$' | sed 's/^/    /'
  CLAUSE1=FAIL
else
  printf 'CLAUSE 1a: PASS -- 0 toBeLessThan assertions on a performance.now() difference\n'
fi

# Half b: at least two ratio assertions exist. A ratio assertion divides the
# large-size measurement by the small-size one and bounds the quotient; the
# `/ Math.max(` denominator guard is part of the agreed shape, so matching it
# keeps a bare subtraction from reading as a ratio.
RATIO_HITS="$(cd "$REPO_ROOT" && rg -c 'Math\.max\(' "$SUBJECT" || true)"
RATIO_ASSERTS="$(cd "$REPO_ROOT" && rg -c 'expect\(ratio\)\.toBeLessThan\(' "$SUBJECT" || true)"
[ -n "$RATIO_ASSERTS" ] || RATIO_ASSERTS=0
if [ "$RATIO_ASSERTS" -ge 2 ]; then
  printf 'CLAUSE 1b: PASS -- %s ratio assertions (4N over N), %s Math.max denominator guards\n' \
    "$RATIO_ASSERTS" "$RATIO_HITS"
else
  printf 'CLAUSE 1b: FAIL -- %s ratio assertions found, 2 required\n' "$RATIO_ASSERTS"
  CLAUSE1=FAIL
fi

# ---------------------------------------------------------------------------
# CLAUSE 2 -- the suite runs green.
# ---------------------------------------------------------------------------
CLAUSE2=FAIL
RUN_OUT="$(cd "$REPO_ROOT" && bun test "$SUBJECT" 2>&1)"
RUN_STATUS=$?
if [ "$RUN_STATUS" -eq 0 ]; then
  CLAUSE2=PASS
  printf '\nCLAUSE 2: PASS -- bun test %s exited 0\n' "$SUBJECT"
else
  printf '\nCLAUSE 2: FAIL -- bun test %s exited %s\n' "$SUBJECT" "$RUN_STATUS"
  printf '%s\n' "$RUN_OUT" | tail -n 15 | sed 's/^/    /'
fi

printf '\nCLAUSE 1 (growth shape, no wall-clock assertion): %s\n' "$CLAUSE1"
printf 'CLAUSE 2 (bun test on the subject exits 0):       %s\n' "$CLAUSE2"

if [ "$CLAUSE1" = PASS ] && [ "$CLAUSE2" = PASS ]; then
  exit 0
fi
exit 1
