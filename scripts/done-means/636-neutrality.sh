#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
ALLOWLIST="$SCRIPT_DIR/636-neutrality-allowlist.txt"
PATTERN='10\.71\.[0-9]{1,3}\.[0-9]{1,3}|core01|rodaddy\.live|/Volumes/ThunderBolt'

if [[ ! -f "$ALLOWLIST" ]]; then
  printf 'FAIL: neutrality allowlist is missing: %s\n' "$ALLOWLIST" >&2
  exit 1
fi

is_allowed() {
  local path="$1"
  local entry
  while IFS= read -r entry || [[ -n "$entry" ]]; do
    [[ -z "$entry" || "$entry" == \#* ]] && continue
    if [[ "$entry" == */ && "$path" == "$entry"* ]]; then
      return 0
    fi
    if [[ "$entry" != */ && ( "$path" == "$entry" || "$path" == "$entry"* ) ]]; then
      return 0
    fi
  done < "$ALLOWLIST"
  return 1
}

violations=0
while IFS= read -r -d '' file; do
  if is_allowed "$file"; then
    continue
  fi

  status=0
  matches="$(rg -n --no-heading --color never -e "$PATTERN" -- "$ROOT/$file")" || status=$?
  if [[ "$status" -eq 1 ]]; then
    continue
  fi
  if [[ "$status" -ne 0 ]]; then
    printf 'FAIL: rg could not inspect tracked file %s (exit %s)\n' "$file" "$status" >&2
    exit "$status"
  fi

  printf '%s\n' "$matches" | while IFS= read -r match; do
    printf 'VIOLATION %s:%s\n' "$file" "$match"
  done
  violations=$((violations + 1))
done < <(git -C "$ROOT" ls-files -z)

if [[ "$violations" -ne 0 ]]; then
  printf 'FAIL: neutrality check found environment-specific values in %s tracked file(s) outside the explicit internal-ops allowlist.\n' "$violations" >&2
  exit 1
fi

printf 'PASS: tracked files are neutral outside the explicit internal-ops allowlist.\n'
