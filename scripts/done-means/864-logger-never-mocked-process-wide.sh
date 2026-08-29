#!/opt/homebrew/bin/bash
# DONE-MEANS check for issue 864 -- no test suite replaces the logger module
# process-wide, and the suites that depend on a real logger still pass.
#
#   bash scripts/done-means/864-logger-never-mocked-process-wide.sh
#
# THE MECHANISM. bun's `mock.module()` is process-wide, not file-scoped: a
# single suite calling `mock.module("../../src/logger.ts", ...)` swaps the
# logger for EVERY suite that loads afterwards in the same run. The
# observability suite asserts on real log records, so it observes the
# replacement rather than the module it imported, and the failure surfaces in
# a file that changed nothing. The offending call is the defect, not the suite
# that reports it.
#
# Clause A -- NO PROCESS-WIDE LOGGER MOCK. `mock.module(... logger ...)` appears
#   on no non-comment line of any *.test.ts under src, server or scripts.
#   Comment lines are excluded on purpose: the two surviving mentions
#   (src/observability/observability.test.ts and scripts/backfill.test.ts) are
#   prose warning the next author off the call, and a gate that failed on its
#   own documentation would push that warning out of the tree.
#
#   RED at origin/main:
#     git show origin/main:scripts/__tests__/bulk-import.test.ts | rg -n 'mock\.module'
#     -> `17:mock.module("../../src/logger.ts", () => ({`, exit 0.
#   That one call is what clause A rejects.
#
# Clause B -- THE SUITES STILL PASS. `bun run test:isolated` over the two
#   bulk-import suites plus the observability suite exits 0. The observability
#   suite is the detector: it is the one that notices a replaced logger, and
#   running it in the SAME process as the bulk-import suites is what makes the
#   clause meaningful. Running them apart would pass with the mock restored.
#
# Exit 0: both clauses pass.
# Exit 1: either clause fails.
# Exit 3: harness error -- rg or bun missing, or not in a git tree.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 3
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  printf 'HARNESS-ERROR: not run from a checkout\n' >&2
  exit 3
}
command -v rg >/dev/null 2>&1 || { printf 'HARNESS-ERROR: rg not on PATH\n' >&2; exit 3; }
command -v bun >/dev/null 2>&1 || { printf 'HARNESS-ERROR: bun not on PATH\n' >&2; exit 3; }

# Every match, then the comment lines removed. Both counts print, so a reader
# can see that the documentation mentions were found and deliberately excused.
ALL_HITS="$(rg -n 'mock\.module\([^)]*logger' --glob '*.test.ts' src server scripts || true)"
CODE_HITS="$(printf '%s\n' "$ALL_HITS" | rg -v ':[[:space:]]*(//|\*|/\*)' | rg -v '^$' || true)"

ALL_COUNT=0
[ -n "$ALL_HITS" ] && ALL_COUNT="$(printf '%s\n' "$ALL_HITS" | rg -c '' || true)"
CODE_COUNT=0
[ -n "$CODE_HITS" ] && CODE_COUNT="$(printf '%s\n' "$CODE_HITS" | rg -c '' || true)"

CLAUSE_A=PASS
if [ "$CODE_COUNT" -ne 0 ]; then
  CLAUSE_A=FAIL
fi

printf '=== DONE-MEANS 864 (the logger is never replaced process-wide) ===\n'
printf 'mentions        : %s (comments included)\n' "$ALL_COUNT"
printf 'calls           : %s (comment lines excluded)\n' "$CODE_COUNT"
if [ "$CLAUSE_A" = FAIL ]; then
  printf '%s\n' "$CODE_HITS"
fi
printf 'CLAUSE A no process-wide logger mock: %s\n' "$CLAUSE_A"

CLAUSE_B=PASS
TEST_OUT="$(bun run test:isolated \
  scripts/__tests__/bulk-import.test.ts \
  scripts/__tests__/bulk-import-routing.test.ts \
  src/observability/observability.test.ts 2>&1)" || CLAUSE_B=FAIL

printf '%s\n' "$TEST_OUT" | rg -n '^[[:space:]]*[0-9]+ (pass|fail)' || true
printf 'CLAUSE B the three suites pass in one process: %s\n' "$CLAUSE_B"

if [ "$CLAUSE_A" = PASS ] && [ "$CLAUSE_B" = PASS ]; then
  printf 'RESULT: PASS\n'
  exit 0
fi

if [ "$CLAUSE_B" = FAIL ]; then
  printf '%s\n' "$TEST_OUT" | tail -40
fi
printf 'RESULT: FAIL\n'
exit 1
