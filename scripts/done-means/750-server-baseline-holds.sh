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

# baseline.md:36 -- non-test TypeScript files under server/
files=$(fd -e ts . server/ | rg -v '\.test\.ts$' | wc -l | tr -d ' ')
check "server/ non-test files" "${DONE_MEANS_750_EXPECT_FILES:-99}" "$files"

# baseline.md:56 -- code lines per file, comments and blanks stripped; count > 500
over500=0
while IFS= read -r f; do
  n=$(sed -e 's://.*::' -e '/^\s*$/d' "$f" | rg -v '^\s*(\*|/\*)' | wc -l | tr -d ' ')
  if [ "$n" -gt 500 ]; then over500=$((over500 + 1)); fi
done < <(fd -e ts . server/ | rg -v '\.test\.ts$')
check "server/ files over 500 code lines" 5 "$over500"

# baseline.md:86 -- non-test files that read process.env
envreaders=$(rg -c 'process\.env' server/ --type ts | rg -v '\.test\.ts:' | wc -l | tr -d ' ')
check "server/ files reading process.env" 11 "$envreaders"

# baseline.md:107 -- import sites from src/, and distinct modules
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
