#!/usr/bin/env bash
# Done-means for _plans/server-quality-baseline.md (#750 sprint, L0 measure).
#
# The baseline records numbers WITH the command that produced each one. This
# check re-runs those exact commands against the tree and fails if any headline
# number moved, so the document cannot silently describe a tree that no longer
# exists. When a ladder rung lands (L2 removes process.env readers, L4 splits
# the five files, L5 cuts the src/ imports) this check is EXPECTED to go red;
# the rung re-measures and updates the baseline, then this file's expectations.
#
# Negative control: DONE_MEANS_750_EXPECT_FILES=1 must make it exit 1.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

fail=0
check() {
  local label=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then
    printf 'ok   %-42s %s\n' "$label" "$actual"
  else
    printf 'FAIL %-42s expected %s, measured %s\n' "$label" "$expected" "$actual"
    fail=1
  fi
}

# baseline.md -- non-test TypeScript files under server/
# 99 -> 100 at 49ecfbe: L2a (PR #778) added server/config/env-groups.ts.
files=$(fd -e ts . server/ | rg -v '\.test\.ts$' | wc -l | tr -d ' ')
check "server/ non-test files" "${DONE_MEANS_750_EXPECT_FILES:-100}" "$files"

# baseline.md -- code lines per file, comments and blanks stripped; count > 500
over500=0
while IFS= read -r f; do
  n=$(sed -e 's://.*::' -e '/^\s*$/d' "$f" | rg -v '^\s*(\*|/\*)' | wc -l | tr -d ' ')
  if [ "$n" -gt 500 ]; then over500=$((over500 + 1)); fi
done < <(fd -e ts . server/ | rg -v '\.test\.ts$')
check "server/ files over 500 code lines" 5 "$over500"

# baseline.md -- non-test files CONTAINING the string process.env.
#
# This counts files that contain the text, comments included -- NOT readers.
# server/config/env-groups.ts names it only in doc comments and reads nothing,
# and it is counted here all the same. The count is deliberately left in this
# mechanically re-runnable form: a hand-curated "real readers" number cannot be
# re-measured by a script, which is the whole point of this file. The
# no-process-env lint rule L2c installs is what distinguishes read from mention.
#
# 11 -> 12 at 49ecfbe: L2a (PR #778) added env-groups.ts. The number went UP
# because L2a is the schema half only -- it typed the env names and left the
# original readers in place on purpose. L2b/L2c bring it DOWN by rewiring
# consumers onto injected config.
envreaders=$(rg -c 'process\.env' server/ --type ts | rg -v '\.test\.ts:' | wc -l | tr -d ' ')
check "server/ files containing process.env" 12 "$envreaders"

# baseline.md -- import sites from src/, and distinct modules
sites=$(rg -oN "from ['\"][^'\"]*src/[^'\"]+" server/ --type ts | rg -v '\.test\.ts:' | wc -l | tr -d ' ')
modules=$(rg -oN "from ['\"][^'\"]*src/[^'\"]+" server/ --type ts | rg -v '\.test\.ts:' \
  | rg -o "src/[^'\"]+" | sort -u | wc -l | tr -d ' ')
check "server/ import sites from src/" 50 "$sites"
check "distinct src/ modules imported" 28 "$modules"

if [ "$fail" -ne 0 ]; then
  echo "FAIL: _plans/server-quality-baseline.md no longer matches the tree; re-measure and update it."
  exit 1
fi
echo "PASS: every headline number in _plans/server-quality-baseline.md matches the tree."
