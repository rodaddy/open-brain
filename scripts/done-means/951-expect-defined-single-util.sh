#!/usr/bin/env bash
# DONE-MEANS check for issue #951 -- `expectDefined` is defined exactly once,
# in scripts/test-support/expect-defined.ts; every lane helper module imports
# it instead of carrying its own copy (HANDOVER-RULES rule 27).
#
#   bash scripts/done-means/951-expect-defined-single-util.sh
#
# Exit 0: exactly one `export function expectDefined` in the tree, at the util
# path. Exit 1: any other count or any other location. Exit 3: harness error.
set -u
cd "$(dirname "$0")/../.." || exit 3
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "HARNESS ERROR: not run from a checkout"; exit 3; }
hits=$(rg -l --glob '*.ts' 'export function expectDefined' . | sort)
count=$(printf '%s\n' "$hits" | sed '/^$/d' | wc -l | tr -d ' ')
echo "definitions: $count"
printf '%s\n' "$hits"
if [ "$count" -eq 1 ] && [ "$hits" = "./scripts/test-support/expect-defined.ts" ]; then
  echo "PASS: one definition at scripts/test-support/expect-defined.ts"
  exit 0
fi
echo "FAIL: expected exactly one definition at ./scripts/test-support/expect-defined.ts"
exit 1
