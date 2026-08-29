#!/usr/bin/env bash
# DONE-MEANS check for issue #962 -- the two growth-shape scans in
# scripts/ob-backfill.test.ts carry an explicit per-test allowance sized to
# the measured runner tail instead of bun's 5000 ms default.
#
#   bash scripts/done-means/962-growth-scan-allowance.sh
#
# Subject: `scripts/ob-backfill.test.ts` in the working tree, or the file
# named by `SUBJECT_FILE` (how the deliberate-miss receipt is taken).
#   1  a `const GROWTH_SCAN_ALLOWANCE_MS = <n>;` line exists with n >= 20000
#   2  the four comment lines directly above it name issue 962 and the
#      measured value 7637 (ms), so the number is traceable to its measurement
#   3  exactly two test titles starting with "scans " exist and exactly two
#      lines pass GROWTH_SCAN_ALLOWANCE_MS as the third `it()` argument.
#      Prettier owns the call layout: it expands a three-argument `it()` onto
#      separate lines, so the allowance argument is matched wherever the
#      formatter puts it rather than at one hand-written column.
# Exit 0: all three pass. Exit 1: any fails (prints which). Exit 3: harness.
set -u
cd "$(dirname "$0")/../.." || exit 3
SUBJECT_FILE="${SUBJECT_FILE:-scripts/ob-backfill.test.ts}"
[ -r "$SUBJECT_FILE" ] || { echo "HARNESS ERROR: cannot read $SUBJECT_FILE"; exit 3; }

failed=""

# Clause 1 -- the constant exists and is at least 20000 ms.
const_line=$(rg -n '^const GROWTH_SCAN_ALLOWANCE_MS = [0-9_]+;$' "$SUBJECT_FILE" | head -1)
if [ -z "$const_line" ]; then
  echo "1: FAIL no 'const GROWTH_SCAN_ALLOWANCE_MS = <n>;' line in $SUBJECT_FILE"
  failed="$failed 1"
  const_no=""
else
  const_no=${const_line%%:*}
  value=$(printf '%s\n' "$const_line" | sed 's/.*= *//; s/;.*//; s/_//g')
  if [ "$value" -ge 20000 ] 2>/dev/null; then
    echo "1: PASS GROWTH_SCAN_ALLOWANCE_MS = $value ms at line $const_no"
  else
    echo "1: FAIL GROWTH_SCAN_ALLOWANCE_MS = $value ms, under the 20000 ms floor"
    failed="$failed 1"
  fi
fi

# Clause 2 -- the four lines above it trace the number to its measurement.
if [ -z "$const_no" ]; then
  echo "2: FAIL no constant line to read the comment above"
  failed="$failed 2"
else
  start=$((const_no - 4))
  [ "$start" -lt 1 ] && start=1
  above=$(sed -n "${start},$((const_no - 1))p" "$SUBJECT_FILE")
  has962=$(printf '%s\n' "$above" | rg -c '962' || true)
  has7637=$(printf '%s\n' "$above" | rg -c '7637' || true)
  if [ "${has962:-0}" -ge 1 ] && [ "${has7637:-0}" -ge 1 ]; then
    echo "2: PASS the four lines above name issue 962 and the measured 7637 ms"
  else
    echo "2: FAIL the four lines above lack 962 and/or 7637 (962=${has962:-0} 7637=${has7637:-0})"
    failed="$failed 2"
  fi
fi

# Clause 3 -- both growth scans are declared with the allowance and close with it.
scans=$(rg -c '^\s*"scans .*",$|^\s*it\("scans ' "$SUBJECT_FILE" || true)
closers=$(rg -c '^\s*\}, GROWTH_SCAN_ALLOWANCE_MS\);$|^\s*GROWTH_SCAN_ALLOWANCE_MS,$' "$SUBJECT_FILE" || true)
if [ "${scans:-0}" -eq 2 ] && [ "${closers:-0}" -eq 2 ]; then
  echo "3: PASS 2 'scans ' tests, each passing GROWTH_SCAN_ALLOWANCE_MS to it()"
else
  echo "3: FAIL expected 2 and 2, got scans=${scans:-0} allowance-args=${closers:-0}"
  failed="$failed 3"
fi

if [ -z "$failed" ]; then
  echo "PASS"
  exit 0
fi
echo "FAIL:$failed"
exit 1
