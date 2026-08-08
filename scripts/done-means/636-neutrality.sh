#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
ALLOWLIST="$SCRIPT_DIR/636-neutrality-allowlist.txt"
# Literal-exception list: whole LINES that legitimately contain a matching
# token because the token is a real in-repo filename or a fixed handshake
# string, not a leaked deployment value. Path-prefix allowlisting is too coarse
# for these -- exempting all of `scripts/deploy-ref-gate.ts` would blind the
# check to a future real leak in the same file.
LINE_EXCEPTIONS="$SCRIPT_DIR/636-neutrality-line-exceptions.txt"
PATTERN='10\.71\.[0-9]{1,3}\.[0-9]{1,3}|core01|rodaddy\.live|/Volumes/ThunderBolt'

if [[ ! -f "$ALLOWLIST" ]]; then
  printf 'FAIL: neutrality allowlist is missing: %s\n' "$ALLOWLIST" >&2
  exit 1
fi

if [[ ! -f "$LINE_EXCEPTIONS" ]]; then
  printf 'FAIL: neutrality line-exception list is missing: %s\n' "$LINE_EXCEPTIONS" >&2
  exit 1
fi

# Every exception is anchored to an exact `path:substring` pair, so it cannot
# silently widen to another file.
is_line_excepted() {
  local file="$1" text="$2" entry exc_path exc_text
  while IFS= read -r entry || [[ -n "$entry" ]]; do
    [[ -z "$entry" || "$entry" == \#* ]] && continue
    exc_path="${entry%%:*}"
    exc_text="${entry#*:}"
    [[ "$file" == "$exc_path" ]] || continue
    if [[ "$text" == *"$exc_text"* ]]; then
      return 0
    fi
  done < "$LINE_EXCEPTIONS"
  return 1
}

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

  # Counted in THIS shell, not a pipeline subshell: `... | while read` runs the
  # loop in a subshell, so an increment inside it is discarded and the check
  # exits 0 while printing violations.
  file_violations=0
  while IFS= read -r match; do
    # `match` is `<line>:<text>`; strip the line number to test the content.
    if is_line_excepted "$file" "${match#*:}"; then
      continue
    fi
    printf 'VIOLATION %s:%s\n' "$file" "$match"
    file_violations=$((file_violations + 1))
  done <<< "$matches"

  if [[ "$file_violations" -ne 0 ]]; then
    violations=$((violations + 1))
  fi
done < <(git -C "$ROOT" ls-files -z)

if [[ "$violations" -ne 0 ]]; then
  printf 'FAIL: neutrality check found environment-specific values in %s tracked file(s) outside the explicit internal-ops allowlist.\n' "$violations" >&2
  exit 1
fi

printf 'PASS: tracked files are neutral outside the explicit internal-ops allowlist.\n'
